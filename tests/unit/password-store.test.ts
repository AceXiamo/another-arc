import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stands in for the login keychain. Reversible, but the output never
// contains the input, so a store that wrote plaintext would fail the test.
let encryptionAvailable = true
const SEAL = 'v1:'
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (text: string) => Buffer.from(SEAL + Buffer.from(text, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith(SEAL)) throw new Error('not ours')
      return Buffer.from(text.slice(SEAL.length), 'base64').toString('utf8')
    }
  }
}))

const { Database } = await import('../../src/main/persistence/database')
const { PasswordStore, originOf } = await import('../../src/main/passwords/password-store')

let dir: string
let db: InstanceType<typeof Database>
let store: InstanceType<typeof PasswordStore>

beforeEach(() => {
  encryptionAvailable = true
  dir = mkdtempSync(join(tmpdir(), 'password-store-test-'))
  db = new Database(join(dir, 'browser.db'))
  store = new PasswordStore(db)
})

afterEach(() => {
  db.raw.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('originOf', () => {
  it('keeps the scheme, host and port apart', () => {
    expect(originOf('https://a.test/login?x=1')).toBe('https://a.test')
    expect(originOf('http://a.test:8080/')).toBe('http://a.test:8080')
    expect(originOf('https://a.test')).not.toBe(originOf('http://a.test'))
  })

  it('refuses anything that is not a web page', () => {
    expect(originOf('file:///etc/passwd')).toBeNull()
    expect(originOf('chrome-extension://abc/')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })
})

describe('PasswordStore', () => {
  it('round-trips a password without ever storing the text', () => {
    const saved = store.save('https://a.test', 'ace', 'hunter2')
    expect(saved).toMatchObject({ origin: 'https://a.test', username: 'ace' })
    expect(store.password(saved!.id)).toBe('hunter2')

    const row = db.get<{ password: Uint8Array }>('SELECT password FROM logins WHERE id = ?', saved!.id)
    expect(Buffer.from(row!.password).toString('utf8')).not.toContain('hunter2')
  })

  it('never hands the password out through the list', () => {
    store.save('https://a.test', 'ace', 'hunter2')
    expect(JSON.stringify(store.list())).not.toContain('hunter2')
  })

  it('replaces the password for a username it already has', () => {
    const first = store.save('https://a.test', 'ace', 'old')
    const second = store.save('https://a.test', 'ace', 'new')
    expect(second!.id).toBe(first!.id)
    expect(store.list()).toHaveLength(1)
    expect(store.password(first!.id)).toBe('new')
  })

  it('keeps two usernames on the same site apart', () => {
    store.save('https://a.test', 'one', 'p1')
    store.save('https://a.test', 'two', 'p2')
    expect(store.forOrigin('https://a.test').map((l) => l.username).sort()).toEqual(['one', 'two'])
  })

  it('offers an origin only its own logins', () => {
    store.save('https://a.test', 'ace', 'p')
    store.save('https://b.test', 'ace', 'p')
    expect(store.forOrigin('https://a.test')).toHaveLength(1)
    expect(store.forOrigin('http://a.test')).toHaveLength(0)
  })

  it('offers the most used first', () => {
    const rare = store.save('https://a.test', 'rare', 'p')!
    const common = store.save('https://a.test', 'common', 'p')!
    store.markUsed(common.id)
    store.markUsed(common.id)
    expect(store.forOrigin('https://a.test')[0]!.username).toBe('common')
    expect(store.list().find((l) => l.id === common.id)!.timesUsed).toBe(2)
  })

  it('knows when a sign-in is already saved, password and all', () => {
    store.save('https://a.test', 'ace', 'hunter2')
    expect(store.has('https://a.test', 'ace', 'hunter2')).toBe(true)
    expect(store.has('https://a.test', 'ace', 'changed')).toBe(false)
    expect(store.has('https://a.test', 'other', 'hunter2')).toBe(false)
  })

  it('removes one, and all', () => {
    const a = store.save('https://a.test', 'ace', 'p')!
    store.save('https://b.test', 'ace', 'p')
    store.remove(a.id)
    expect(store.list()).toHaveLength(1)
    expect(store.password(a.id)).toBeNull()
    store.removeAll()
    expect(store.list()).toEqual([])
  })

  it('stores nothing at all when the OS will not give us a key', () => {
    encryptionAvailable = false
    expect(store.available).toBe(false)
    expect(store.save('https://a.test', 'ace', 'hunter2')).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('survives a row it cannot decrypt', () => {
    const saved = store.save('https://a.test', 'ace', 'hunter2')!
    db.run('UPDATE logins SET password = ? WHERE id = ?', Buffer.from('from another Mac'), saved.id)
    expect(store.password(saved.id)).toBeNull()
    expect(store.list()).toHaveLength(1)
  })
})
