import { join } from 'node:path'
import type { Session } from 'electron'
import type { ImportBrowser } from '@shared/ext-import'
import {
  countImportableCookies,
  readCookieDatabase,
  withDatabaseCopy,
  type CookieSkips,
  type ImportedCookie
} from './chromium-cookies'
import { indexedDbSurvey, localStorageBytes, stageIndexedDb, stageLocalStorage } from './chromium-storage'
import { browserKeychain } from './browsers'
import { countImportablePasswords, readPasswordDatabase, type PasswordSkips } from './chromium-passwords'
import type { PasswordStore } from '../passwords/password-store'
import { KeychainError, readSafeStorageKey } from './chromium-crypt'

// "Bring my logins over": one profile's cookies, localStorage and
// IndexedDB. Together they carry most sites' signed-in state — a token can
// be in any of the three — and what they cannot carry is listed in
// `browserImport.session.note`.
//
// Always one profile, never several merged: a browser keeps one cookie jar
// per profile and they hold the same sites signed in as different accounts,
// so merging would leave whichever came last.

/** Cookies in flight at once; each one is a round trip to the network service. */
const BATCH = 64

export interface SessionSummary {
  browser: ImportBrowser
  /** Absolute path of the profile folder to read. */
  profileDir: string
  cookies: number
  /** Distinct sites behind `cookies`. */
  hosts: number
  localStorageBytes: number
  /** Sites whose IndexedDB would be moved in, and what they weigh. */
  indexedDb: { origins: number; bytes: number }
  /** Saved passwords worth offering. */
  passwords: number
}

/** localStorage and IndexedDB together, as the confirmation counts them. */
export function siteDataBytes(summary: SessionSummary): number {
  return summary.localStorageBytes + summary.indexedDb.bytes
}

export interface SessionResult {
  cookies: number
  /** Rows Chromium refused to take back. */
  rejected: number
  skipped: CookieSkips
  /** What is waiting for the next launch; zeroes when nothing is. */
  staged: { localStorageBytes: number; indexedDbOrigins: number; indexedDbBytes: number }
  passwords: { imported: number; skipped: PasswordSkips }
  /** Why no cookies came over, when none did. */
  failure: 'keychain' | 'unreadable' | null
}

/** True when the next launch has something to move in. */
export function needsRestart(result: SessionResult): boolean {
  return result.staged.localStorageBytes > 0 || result.staged.indexedDbOrigins > 0
}

/** What an import would bring over, without touching the keychain. */
export async function surveySession(
  browser: ImportBrowser,
  profileDir: string,
  userData: string,
  partition: string | null
): Promise<SessionSummary | null> {
  let cookies = 0
  let hosts = 0
  try {
    const counts = await withDatabaseCopy(join(profileDir, 'Cookies'), 'Cookies', (copy) => countImportableCookies(copy))
    cookies = counts.cookies
    hosts = counts.hosts
  } catch {
    // No cookie jar, or one we cannot read: localStorage may still be there.
  }
  // Both only make sense against a partition on disk, which is also the
  // only way to tell which IndexedDB sites are new here.
  const bytes = partition ? await localStorageBytes(profileDir) : 0
  const indexedDb = partition ? await indexedDbSurvey(profileDir, userData, partition) : { origins: 0, bytes: 0 }
  let passwords = 0
  try {
    passwords = await withDatabaseCopy(join(profileDir, 'Login Data'), 'LoginData', (copy) =>
      countImportablePasswords(copy)
    )
  } catch {
    // No password database, or one we cannot read.
  }
  if (cookies === 0 && bytes === 0 && indexedDb.origins === 0 && passwords === 0) return null
  return { browser, profileDir, cookies, hosts, localStorageBytes: bytes, indexedDb, passwords }
}

/**
 * Put the profile's cookies into `ses` and stage its localStorage and
 * IndexedDB for the next launch. `partition` is the directory behind `ses`
 * (`persist:default` → `default`); without one, only cookies are imported.
 */
export async function importSession(
  ses: Session,
  summary: SessionSummary,
  userData: string,
  partition: string | null,
  passwords: PasswordStore
): Promise<SessionResult> {
  const result: SessionResult = {
    cookies: 0,
    rejected: 0,
    skipped: { partitioned: 0, sessionOnly: 0, expired: 0, undecryptable: 0, malformed: 0 },
    staged: { localStorageBytes: 0, indexedDbOrigins: 0, indexedDbBytes: 0 },
    passwords: { imported: 0, skipped: { android: 0, blacklisted: 0, inKeychain: 0, undecryptable: 0 } },
    failure: null
  }

  const needsKey = summary.cookies > 0 || summary.passwords > 0
  const key = needsKey ? await safeStorageKey(summary.browser) : null
  if (needsKey && key === null) result.failure = 'keychain'

  if (summary.cookies > 0 && key) {
    {
      try {
        const jar = await withDatabaseCopy(join(summary.profileDir, 'Cookies'), 'Cookies', (copy) =>
          readCookieDatabase(copy, key)
        )
        result.skipped = jar.skipped
        const applied = await applyCookies(ses, jar.cookies)
        result.cookies = applied.set
        result.rejected = applied.rejected
      } catch (error) {
        console.error('[import] could not read the cookie database', error)
        result.failure = 'unreadable'
      }
    }
  }

  if (summary.passwords > 0 && key && passwords.available) {
    try {
      const read = await withDatabaseCopy(join(summary.profileDir, 'Login Data'), 'LoginData', (copy) =>
        readPasswordDatabase(copy, key)
      )
      result.passwords.skipped = read.skipped
      for (const entry of read.passwords) {
        if (passwords.save(entry.origin, entry.username, entry.password)) result.passwords.imported += 1
      }
    } catch (error) {
      console.error('[import] could not read the password database', error)
    }
  }

  if (partition && summary.localStorageBytes > 0) {
    try {
      result.staged.localStorageBytes = await stageLocalStorage(summary.profileDir, userData, partition)
    } catch (error) {
      console.error('[import] could not stage localStorage', error)
    }
  }
  if (partition && summary.indexedDb.origins > 0) {
    try {
      const staged = await stageIndexedDb(summary.profileDir, userData, partition)
      result.staged.indexedDbOrigins = staged.origins
      result.staged.indexedDbBytes = staged.bytes
    } catch (error) {
      console.error('[import] could not stage IndexedDB', error)
    }
  }
  return result
}

/** Null when the item is missing, or when the user did not allow access. */
async function safeStorageKey(browser: ImportBrowser): Promise<Buffer | null> {
  const { service, account } = browserKeychain(browser)
  try {
    return await readSafeStorageKey(service, account)
  } catch (error) {
    if (!(error instanceof KeychainError)) throw error
    return null
  }
}

/**
 * Chromium validates every cookie on the way in and rejects the ones it
 * would not have accepted from a site (a `__Host-` cookie with a domain, a
 * `SameSite=None` without `Secure`…). Those are counted and the rest still
 * go through.
 */
async function applyCookies(ses: Session, cookies: readonly ImportedCookie[]): Promise<{ set: number; rejected: number }> {
  let set = 0
  let rejected = 0
  for (let i = 0; i < cookies.length; i += BATCH) {
    const results = await Promise.allSettled(cookies.slice(i, i + BATCH).map((cookie) => ses.cookies.set(cookie)))
    for (const outcome of results) {
      if (outcome.status === 'fulfilled') set += 1
      else rejected += 1
    }
  }
  return { set, rejected }
}

/** `persist:default` → `default`; in-memory partitions have no directory. */
export function partitionDirName(partition: string): string | null {
  return partition.startsWith('persist:') ? partition.slice('persist:'.length) || null : null
}
