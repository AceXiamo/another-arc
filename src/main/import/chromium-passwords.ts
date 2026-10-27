import { DatabaseSync } from 'node:sqlite'
import { decryptV10 } from './chromium-crypt'

// Another Chromium profile's saved passwords, from its `Login Data`.
//
// Three kinds of row never come over, and each is counted rather than
// dropped quietly:
//
// - `android://…` realms are app credentials Chrome syncs from a phone.
//   They have no meaning in a browser.
// - rows the user told that browser never to save (`blacklisted_by_user`),
//   which carry no password at all.
// - rows whose password lives in a keychain item of its own
//   (`keychain_identifier`, how Chrome stored them years ago): the blob in
//   the database is not a v10 payload and there is nothing to decrypt.

export interface ImportedPassword {
  origin: string
  username: string
  password: string
}

export interface PasswordSkips {
  /** Credentials for an Android app, synced from a phone. */
  android: number
  /** "Never save for this site" entries, which hold no password. */
  blacklisted: number
  /** Stored in a keychain item of its own, so unreadable from the file. */
  inKeychain: number
  /** Wrong key, or a row we do not understand. */
  undecryptable: number
}

export interface ChromiumPasswords {
  passwords: ImportedPassword[]
  skipped: PasswordSkips
}

interface Row {
  origin_url: string
  signon_realm: string
  username_value: string
  password_value: Uint8Array
  blacklisted: number
  keychain_identifier: Uint8Array | null
}

const QUERY = `
  SELECT origin_url,
         signon_realm,
         username_value,
         password_value,
         blacklisted_by_user AS blacklisted,
         keychain_identifier
    FROM logins
   ORDER BY date_created`

/** Rows worth offering, counted without the key (for the confirmation). */
export function countImportablePasswords(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db
      .prepare(
        `SELECT count(*) AS n FROM logins
          WHERE blacklisted_by_user = 0
            AND length(password_value) > 0
            AND signon_realm NOT LIKE 'android://%'`
      )
      .get() as { n: number } | undefined
    return row?.n ?? 0
  } finally {
    db.close()
  }
}

export function readPasswordDatabase(dbPath: string, key: Buffer): ChromiumPasswords {
  const passwords: ImportedPassword[] = []
  const skipped: PasswordSkips = { android: 0, blacklisted: 0, inKeychain: 0, undecryptable: 0 }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    for (const row of db.prepare(QUERY).all() as unknown as Row[]) {
      if (row.signon_realm.startsWith('android://')) {
        skipped.android += 1
        continue
      }
      if (row.blacklisted) {
        skipped.blacklisted += 1
        continue
      }
      if (row.password_value.length === 0) {
        // A row with its password in a keychain item of its own, or an
        // empty one Chrome kept for the username alone.
        if ((row.keychain_identifier?.length ?? 0) > 0) skipped.inKeychain += 1
        else skipped.undecryptable += 1
        continue
      }
      const password = decryptV10(key, row.password_value)
      const origin = originOf(row.origin_url) ?? originOf(row.signon_realm)
      if (password === null || password === '' || origin === null) {
        skipped.undecryptable += 1
        continue
      }
      passwords.push({ origin, username: row.username_value, password })
    }
  } finally {
    db.close()
  }
  return { passwords, skipped }
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}
