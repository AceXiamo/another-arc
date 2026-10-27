import { createCipheriv } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { countImportablePasswords, readPasswordDatabase } from '../../src/main/import/chromium-passwords'
import { deriveKey } from '../../src/main/import/chromium-crypt'

// A `Login Data` database with Chromium's own schema and encryption.

const KEY = deriveKey('v7Vb1cSCHdsJDkT/')

function encrypt(value: string): Uint8Array {
  const cipher = createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 0x20))
  return new Uint8Array(Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(Buffer.from(value, 'utf8')), cipher.final()]))
}

interface Login {
  origin?: string
  realm?: string
  username?: string
  password?: Uint8Array
  blacklisted?: number
  keychain?: Uint8Array | null
}

let dir: string
let dbPath: string
let created = 0

function addLogin(o: Login): void {
  const db = new DatabaseSync(dbPath)
  db.prepare(
    `INSERT INTO logins (origin_url, signon_realm, username_value, password_value, blacklisted_by_user,
                         keychain_identifier, date_created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.origin ?? 'https://example.com/login',
    o.realm ?? 'https://example.com/',
    o.username ?? 'ace',
    o.password ?? encrypt('hunter2'),
    o.blacklisted ?? 0,
    o.keychain ?? null,
    (created += 1)
  )
  db.close()
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'login-data-test-'))
  dbPath = join(dir, 'Login Data')
  const db = new DatabaseSync(dbPath)
  db.exec(
    `CREATE TABLE logins (origin_url TEXT NOT NULL, signon_realm TEXT NOT NULL, username_value TEXT NOT NULL,
                          password_value BLOB NOT NULL, blacklisted_by_user INTEGER NOT NULL,
                          keychain_identifier BLOB, date_created INTEGER NOT NULL)`
  )
  db.close()

  addLogin({ username: 'ace', password: encrypt('hunter2') })
  addLogin({ origin: 'https://shop.test/in', realm: 'https://shop.test/', username: 'a@b.test', password: encrypt('pw with spaces') })
  // The origin comes from the realm when there is no usable origin_url.
  addLogin({ origin: '', realm: 'https://realm-only.test/', username: 'r', password: encrypt('rr') })
  // Skipped, one per reason.
  addLogin({ realm: 'android://hash@com.example.app/', username: 'phone', password: encrypt('app') })
  addLogin({ realm: 'https://never.test/', username: '', password: new Uint8Array(), blacklisted: 1 })
  addLogin({ realm: 'https://old.test/', username: 'old', password: new Uint8Array(), keychain: new Uint8Array([1, 2, 3]) })
  addLogin({ realm: 'https://broken.test/', username: 'x', password: new Uint8Array([118, 49, 48, 7, 7, 7]) })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readPasswordDatabase', () => {
  it('decrypts the logins worth carrying over', () => {
    const { passwords } = readPasswordDatabase(dbPath, KEY)
    expect(passwords).toEqual([
      { origin: 'https://example.com', username: 'ace', password: 'hunter2' },
      { origin: 'https://shop.test', username: 'a@b.test', password: 'pw with spaces' },
      { origin: 'https://realm-only.test', username: 'r', password: 'rr' }
    ])
  })

  it('counts each kind it leaves behind', () => {
    expect(readPasswordDatabase(dbPath, KEY).skipped).toEqual({
      android: 1,
      blacklisted: 1,
      inKeychain: 1,
      undecryptable: 1
    })
  })

  it('reports nothing readable when the key is wrong', () => {
    const result = readPasswordDatabase(dbPath, deriveKey('wrong'))
    expect(result.passwords).toEqual([])
    expect(result.skipped.undecryptable).toBe(4)
  })
})

describe('countImportablePasswords', () => {
  // An estimate for the dialog: it cannot know which rows the key will open.
  it('counts the rows an import would try, without the key', () => {
    expect(countImportablePasswords(dbPath)).toBe(4)
  })
})
