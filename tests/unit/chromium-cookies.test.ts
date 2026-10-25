import { createCipheriv, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { countImportableCookies, readCookieDatabase } from '../../src/main/import/chromium-cookies'
import { deriveKey } from '../../src/main/import/chromium-crypt'

// A cookie jar with Chromium's own schema and encryption, so the mapping is
// tested against the real column values rather than a convenient stand-in.

const KEY = deriveKey('v7Vb1cSCHdsJDkT/')
const NOW = Date.UTC(2026, 0, 15)
const CHROMIUM_EPOCH_OFFSET_SEC = 11_644_473_600n

/** Unix milliseconds as Chromium stores them: microseconds since 1601-01-01. */
const chromiumTime = (ms: number): bigint => (BigInt(Math.floor(ms / 1000)) + CHROMIUM_EPOCH_OFFSET_SEC) * 1_000_000n

function encrypt(value: string, host: string): Uint8Array {
  const plain = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value, 'utf8')])
  const cipher = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20))
  return new Uint8Array(Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(plain), cipher.final()]))
}

interface RowOverrides {
  host_key?: string
  name?: string
  value?: string
  encrypted?: Uint8Array | null
  path?: string
  expiresMs?: number | null
  is_secure?: number
  is_httponly?: number
  is_persistent?: number
  samesite?: number
  source_scheme?: number
  source_port?: number
  top_frame_site_key?: string
}

let dir: string
let dbPath: string
let created = 0

function addCookie(o: RowOverrides): void {
  const host = o.host_key ?? '.example.com'
  const name = o.name ?? `c${created}`
  const value = o.value ?? 'v'
  const expires = o.expiresMs === undefined ? Date.UTC(2027, 0, 1) : o.expiresMs
  const db = new DatabaseSync(dbPath)
  db.prepare(
    `INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path,
                          expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent,
                          priority, samesite, source_scheme, source_port, last_update_utc, source_type,
                          has_cross_site_ancestor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?, 0, 0, 0)`
  ).run(
    BigInt(created += 1),
    host,
    o.top_frame_site_key ?? '',
    name,
    o.value !== undefined && o.encrypted === null ? value : '',
    o.encrypted === null ? new Uint8Array() : (o.encrypted ?? encrypt(value, host)),
    o.path ?? '/',
    expires === null ? 0n : chromiumTime(expires),
    o.is_secure ?? 1,
    o.is_httponly ?? 0,
    expires === null ? 0 : 1,
    o.is_persistent ?? 1,
    o.samesite ?? -1,
    o.source_scheme ?? 2,
    o.source_port ?? 443
  )
  db.close()
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'arc-cookies-test-'))
  dbPath = join(dir, 'Cookies')
  const db = new DatabaseSync(dbPath)
  db.exec(
    `CREATE TABLE cookies (creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL,
                           name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL,
                           expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
                           last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL,
                           priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL,
                           source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,
                           has_cross_site_ancestor INTEGER NOT NULL)`
  )
  db.close()

  addCookie({ host_key: '.example.com', name: 'sid', value: 'abc123', is_httponly: 1, samesite: 1 })
  addCookie({ host_key: 'app.example.com', name: 'host-only', value: 'h', samesite: 2 })
  addCookie({ host_key: '.plain.test', name: 'legacy', value: 'unencrypted', encrypted: null, is_secure: 0, source_scheme: 1, source_port: 80 })
  addCookie({ host_key: 'localhost', name: 'dev', value: 'd', is_secure: 0, source_scheme: 1, source_port: 3000 })
  addCookie({ host_key: '.forever.test', name: 'no-expiry', value: 'f', expiresMs: null })
  addCookie({ host_key: '.none.test', name: 'cross-site', value: 'n', samesite: 0 })
  // Skipped, one per reason.
  addCookie({ host_key: '.chips.test', name: 'partitioned', top_frame_site_key: 'https://top.test' })
  addCookie({ host_key: '.session.test', name: 'session-only', is_persistent: 0 })
  addCookie({ host_key: '.old.test', name: 'expired', expiresMs: Date.UTC(2025, 0, 1) })
  addCookie({ host_key: '.bad.test', name: 'garbled', encrypted: new Uint8Array([118, 49, 48, 9, 9, 9, 9]) })
  addCookie({ host_key: '', name: 'hostless' })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readCookieDatabase', () => {
  const read = () => readCookieDatabase(dbPath, KEY, NOW)
  const find = (name: string) => read().cookies.find((c) => c.name === name)

  it('decrypts values and keeps the flags Chromium stored', () => {
    expect(find('sid')).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      value: 'abc123',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: Math.floor(Date.UTC(2027, 0, 1) / 1000)
    })
  })

  it('keeps a host-only cookie host-only by leaving the domain out', () => {
    const cookie = find('host-only')
    expect(cookie?.domain).toBeUndefined()
    expect(cookie?.url).toBe('https://app.example.com/')
    expect(cookie?.sameSite).toBe('strict')
  })

  it('reads rows that were never encrypted', () => {
    expect(find('legacy')).toMatchObject({ value: 'unencrypted', secure: false, url: 'http://plain.test/' })
  })

  it('keeps a non-default port in the URL', () => {
    expect(find('dev')?.url).toBe('http://localhost:3000/')
  })

  it('leaves a cookie without an expiry a session cookie here too', () => {
    expect(find('no-expiry')?.expirationDate).toBeUndefined()
  })

  it('maps SameSite=None and unspecified apart', () => {
    expect(find('cross-site')?.sameSite).toBe('no_restriction')
    expect(find('sid')?.sameSite).toBe('lax')
    expect(find('legacy')?.sameSite).toBe('unspecified')
  })

  it('counts what it leaves behind instead of failing', () => {
    const { cookies, hosts, skipped } = read()
    expect(cookies.map((c) => c.name).sort()).toEqual(
      ['cross-site', 'dev', 'host-only', 'legacy', 'no-expiry', 'sid'].sort()
    )
    expect(hosts).toBe(6)
    expect(skipped).toEqual({ partitioned: 1, sessionOnly: 1, expired: 1, undecryptable: 1, malformed: 1 })
  })

  it('reports nothing readable when the key is wrong', () => {
    const result = readCookieDatabase(dbPath, deriveKey('wrong'), NOW)
    expect(result.cookies.map((c) => c.name)).toEqual(['legacy'])
    expect(result.skipped.undecryptable).toBe(7)
  })
})

describe('countImportableCookies', () => {
  // An estimate for the dialog: it cannot know which rows the key will open.
  it('counts every row an import would try, without the key', () => {
    expect(countImportableCookies(dbPath, NOW)).toEqual({ cookies: 8, hosts: 8 })
  })
})
