import { createCipheriv, createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptV10, deriveKey } from '../../src/main/import/chromium-crypt'

// Encrypts the way Chromium does on macOS, so the tests exercise the real
// shape of a stored cell rather than a mock.
function encrypt(key: Buffer, value: string, boundTo?: string): Uint8Array {
  const plain = boundTo === undefined
    ? Buffer.from(value, 'utf8')
    : Buffer.concat([createHash('sha256').update(boundTo).digest(), Buffer.from(value, 'utf8')])
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return new Uint8Array(Buffer.concat([Buffer.from('v10', 'latin1'), cipher.update(plain), cipher.final()]))
}

const key = deriveKey('v7Vb1cSCHdsJDkT/')
const other = deriveKey('a-different-password')

describe('deriveKey', () => {
  it('is the documented PBKDF2 derivation', () => {
    expect(key).toHaveLength(16)
    expect(deriveKey('v7Vb1cSCHdsJDkT/')).toEqual(key)
    expect(other).not.toEqual(key)
  })
})

describe('decryptV10', () => {
  it('reads a host-bound value and strips the hash', () => {
    expect(decryptV10(key, encrypt(key, 'session=abc', '.example.com'), '.example.com')).toBe('session=abc')
  })

  it('reads a value written before Chromium bound them to a host', () => {
    expect(decryptV10(key, encrypt(key, 'plain-value'), '.example.com')).toBe('plain-value')
  })

  it('keeps a long unbound value whole', () => {
    const long = 'a'.repeat(64)
    expect(decryptV10(key, encrypt(key, long), '.example.com')).toBe(long)
  })

  it('refuses a value bound to another host', () => {
    expect(decryptV10(key, encrypt(key, 'session=abc', '.evil.test'), '.example.com')).toBeNull()
  })

  it('refuses the wrong key', () => {
    expect(decryptV10(other, encrypt(key, 'session=abc', '.example.com'), '.example.com')).toBeNull()
  })

  it('refuses a payload that is not v10', () => {
    expect(decryptV10(key, new Uint8Array([0x76, 0x32, 0x30, 1, 2, 3]))).toBeNull()
    expect(decryptV10(key, new Uint8Array())).toBeNull()
  })

  it('refuses a truncated payload', () => {
    const blob = encrypt(key, 'session=abc', '.example.com')
    expect(decryptV10(key, blob.slice(0, blob.length - 4), '.example.com')).toBeNull()
  })
})
