import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decryptV10 } from './chromium-crypt'

// Reads another Chromium profile's cookie jar and turns it into something
// `Session.cookies.set` accepts. The values are re-encrypted with our own
// keychain key on the way in, so the file itself can never be copied — every
// cookie goes through Chromium's own validation here, which is also what
// keeps a malformed row from poisoning the jar.
//
// The database is always copied before it is opened: the other browser may
// be running and holds it with an exclusive lock, and nothing under its
// folder is ever opened for writing.

/** Microseconds between 1601-01-01 (Chromium's epoch) and 1970-01-01. */
const CHROMIUM_EPOCH_OFFSET_SEC = 11_644_473_600

/** Chromium's `samesite` column; -1 (unspecified) and anything else fall through. */
const SAME_SITE: Record<number, ImportedCookie['sameSite']> = {
  0: 'no_restriction',
  1: 'lax',
  2: 'strict'
}

export interface ImportedCookie {
  url: string
  name: string
  value: string
  /** Set for domain cookies (`.example.com`); absent makes it host-only. */
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** Unix seconds; absent for a cookie that never expires. */
  expirationDate?: number
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

export interface CookieSkips {
  /** CHIPS cookies, keyed to a top-level site we have no API to reproduce. */
  partitioned: number
  /** Only valid for the browsing session they were set in. */
  sessionOnly: number
  expired: number
  /** Wrong key, or a row written by a scheme we do not know. */
  undecryptable: number
  /** Host or path Chromium itself would not accept back. */
  malformed: number
}

export interface ArcCookies {
  cookies: ImportedCookie[]
  /** Distinct sites behind `cookies`, for the confirmation dialog. */
  hosts: number
  skipped: CookieSkips
}

interface Row {
  host_key: string
  name: string
  value: string
  encrypted_value: Uint8Array
  path: string
  expires_sec: number
  is_secure: number
  is_httponly: number
  has_expires: number
  is_persistent: number
  samesite: number
  source_scheme: number
  source_port: number
  partitioned: number
}

// `value` is only read for rows written before the profile had encryption;
// for every other row it holds bytes that are not valid text. Expiry is
// converted in SQL because Chromium's microsecond timestamps are past the
// range JavaScript numbers represent exactly.
const QUERY = `
  SELECT host_key,
         name,
         CASE WHEN length(encrypted_value) > 0 THEN '' ELSE value END AS value,
         encrypted_value,
         path,
         expires_utc / 1000000 - ${CHROMIUM_EPOCH_OFFSET_SEC} AS expires_sec,
         is_secure,
         is_httponly,
         has_expires,
         is_persistent,
         samesite,
         source_scheme,
         source_port,
         length(top_frame_site_key) > 0 AS partitioned
    FROM cookies
   ORDER BY creation_utc`

/**
 * Every cookie in `dbPath` worth carrying over. `key` is the profile's
 * "Safe Storage" key; rows it cannot open are counted, not thrown.
 */
export function readCookieDatabase(dbPath: string, key: Buffer, now = Date.now()): ArcCookies {
  const cookies: ImportedCookie[] = []
  const hosts = new Set<string>()
  const skipped: CookieSkips = { partitioned: 0, sessionOnly: 0, expired: 0, undecryptable: 0, malformed: 0 }
  const nowSec = Math.floor(now / 1000)

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    for (const row of db.prepare(QUERY).all() as unknown as Row[]) {
      if (row.partitioned) {
        skipped.partitioned += 1
        continue
      }
      if (!row.is_persistent) {
        skipped.sessionOnly += 1
        continue
      }
      if (row.has_expires && row.expires_sec <= nowSec) {
        skipped.expired += 1
        continue
      }
      const value =
        row.encrypted_value.length > 0 ? decryptV10(key, row.encrypted_value, row.host_key) : row.value
      if (value === null) {
        skipped.undecryptable += 1
        continue
      }
      const cookie = toCookie(row, value)
      if (!cookie) {
        skipped.malformed += 1
        continue
      }
      cookies.push(cookie)
      hosts.add(row.host_key)
    }
  } finally {
    db.close()
  }
  return { cookies, hosts: hosts.size, skipped }
}

/** How many cookies an import would bring over, without decrypting any of them. */
export function countImportableCookies(dbPath: string, now = Date.now()): { cookies: number; hosts: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db
      .prepare(
        `SELECT count(*) AS cookies, count(DISTINCT host_key) AS hosts
           FROM cookies
          WHERE is_persistent = 1
            AND length(top_frame_site_key) = 0
            AND (has_expires = 0 OR expires_utc / 1000000 - ${CHROMIUM_EPOCH_OFFSET_SEC} > ?)`
      )
      .get(Math.floor(now / 1000)) as { cookies: number; hosts: number } | undefined
    return { cookies: row?.cookies ?? 0, hosts: row?.hosts ?? 0 }
  } finally {
    db.close()
  }
}

/**
 * Chromium stores the host a cookie belongs to with a leading dot when the
 * cookie covers subdomains. `Session.cookies.set` reproduces that split
 * through `domain`: given one, it writes a domain cookie; left out, the URL's
 * host becomes a host-only cookie. Passing `host_key` for both would widen
 * every host-only cookie to its subdomains.
 */
function toCookie(row: Row, value: string): ImportedCookie | null {
  const forSubdomains = row.host_key.startsWith('.')
  const host = forSubdomains ? row.host_key.slice(1) : row.host_key
  if (!host || !row.name) return null

  const secure = row.is_secure === 1
  // `source_scheme`: 0 unset, 1 non-secure, 2 secure.
  const scheme = secure || row.source_scheme === 2 ? 'https' : 'http'
  const defaultPort = scheme === 'https' ? 443 : 80
  const authority = row.source_port > 0 && row.source_port !== defaultPort ? `${host}:${row.source_port}` : host
  const path = row.path || '/'

  let url: string
  try {
    url = new URL(`${scheme}://${authority}${path}`).toString()
  } catch {
    return null
  }

  const cookie: ImportedCookie = {
    url,
    name: row.name,
    value,
    path,
    secure,
    httpOnly: row.is_httponly === 1,
    sameSite: SAME_SITE[row.samesite] ?? 'unspecified'
  }
  if (forSubdomains) cookie.domain = row.host_key
  if (row.has_expires) cookie.expirationDate = row.expires_sec
  return cookie
}

/**
 * Run `read` against a private copy of a database the other browser may have
 * open. The copy is always removed again.
 */
export async function withDatabaseCopy<T>(source: string, label: string, read: (copy: string) => T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `arc-${label}-`))
  try {
    const copy = join(dir, label)
    await copyFile(source, copy)
    return read(copy)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
