import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { SavedLogin } from '@shared/passwords'
import type { Database } from '../persistence/database'

// Saved logins, encrypted with the login keychain through Electron's
// `safeStorage`. The database holds ciphertext only: a copy of the file is
// worth nothing on another Mac, or to another user on this one.
//
// Plaintext passwords exist in exactly two places — the argument to `save`
// and the return of `password` — and never go through IPC to the shell,
// never reach a page's own world, and are never logged.

/** Same-origin only: a credential for `https://a.test` is not offered to `http://a.test`. */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null
  } catch {
    return null
  }
}

interface Row {
  id: string
  origin: string
  username: string
  password: Uint8Array
  created_at: number
  last_used_at: number
  times_used: number
}

export class PasswordStore {
  constructor(private readonly db: Database) {}

  /**
   * False when the OS will not give us a key (no keychain access). Nothing
   * is ever stored in the clear, so saving is simply off in that case.
   */
  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** Every saved login, newest first. Without the passwords. */
  list(): SavedLogin[] {
    return this.db
      .all<Row>('SELECT * FROM logins ORDER BY origin, username')
      .map((row) => toSaved(row))
  }

  /** The logins offered on `origin`, most used first. */
  forOrigin(origin: string): SavedLogin[] {
    return this.db
      .all<Row>('SELECT * FROM logins WHERE origin = ? ORDER BY times_used DESC, last_used_at DESC', origin)
      .map((row) => toSaved(row))
  }

  /** Does this origin already have this exact sign-in? */
  has(origin: string, username: string, password: string): boolean {
    const row = this.db.get<Row>('SELECT * FROM logins WHERE origin = ? AND username = ?', origin, username)
    return row !== undefined && this.decrypt(row.password) === password
  }

  /** One saved login by id, without its password. */
  get(id: string): SavedLogin | null {
    const row = this.db.get<Row>('SELECT * FROM logins WHERE id = ?', id)
    return row ? toSaved(row) : null
  }

  /** The decrypted password, or null when the row is gone or undecryptable. */
  password(id: string): string | null {
    const row = this.db.get<Row>('SELECT * FROM logins WHERE id = ?', id)
    return row ? this.decrypt(row.password) : null
  }

  /**
   * Store a sign-in, replacing the password when this origin already has
   * that username. Returns null when encryption is unavailable.
   */
  save(origin: string, username: string, password: string): SavedLogin | null {
    if (!this.available || !origin) return null
    let encrypted: Buffer
    try {
      encrypted = safeStorage.encryptString(password)
    } catch (error) {
      console.error('[passwords] could not encrypt', error)
      return null
    }
    const now = Date.now()
    const existing = this.db.get<Row>('SELECT * FROM logins WHERE origin = ? AND username = ?', origin, username)
    const id = existing?.id ?? randomUUID()
    if (existing) {
      this.db.run('UPDATE logins SET password = ?, last_used_at = ? WHERE id = ?', encrypted, now, id)
    } else {
      this.db.run(
        'INSERT INTO logins (id, origin, username, password, created_at, last_used_at, times_used) VALUES (?, ?, ?, ?, ?, ?, 0)',
        id,
        origin,
        username,
        encrypted,
        now,
        now
      )
    }
    return { id, origin, username, createdAt: existing?.created_at ?? now, lastUsedAt: now, timesUsed: existing?.times_used ?? 0 }
  }

  remove(id: string): void {
    this.db.run('DELETE FROM logins WHERE id = ?', id)
  }

  removeAll(): void {
    this.db.run('DELETE FROM logins')
  }

  /** Called after a login is filled, so the most-used one is offered first. */
  markUsed(id: string): void {
    this.db.run('UPDATE logins SET times_used = times_used + 1, last_used_at = ? WHERE id = ?', Date.now(), id)
  }

  private decrypt(value: Uint8Array): string | null {
    if (!this.available) return null
    try {
      return safeStorage.decryptString(Buffer.from(value))
    } catch {
      // Written under a different keychain, or the item was removed.
      console.error('[passwords] could not decrypt a saved login')
      return null
    }
  }
}

function toSaved(row: Row): SavedLogin {
  return {
    id: row.id,
    origin: row.origin,
    username: row.username,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    timesUsed: row.times_used
  }
}
