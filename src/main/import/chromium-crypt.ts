import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// Chromium's "v10" encryption, as every Chromium browser uses it on macOS for
// cookies and saved passwords. The secret is a random password the browser
// keeps in the login keychain under "<Product> Safe Storage"; the AES key is
// derived from it with parameters that have not changed since 2013:
//
//   key       = PBKDF2-HMAC-SHA1(keychain password, "saltysalt", 1003, 16 bytes)
//   plaintext = AES-128-CBC-decrypt(key, iv = sixteen spaces, ciphertext)
//
// Chromium 130 and later also bind each cookie to its host: the plaintext
// starts with SHA-256 of the cookie's `host_key`. Rows written before that
// have no prefix, so it is only stripped when it actually matches the host
// the row claims (`boundTo`) — which doubles as a check that the key is right.

const execFileAsync = promisify(execFile)

const PREFIX = 'v10'
const IV = Buffer.alloc(16, 0x20)
const SALT = 'saltysalt'
const ROUNDS = 1003
const KEY_BYTES = 16
const BLOCK_BYTES = 16
const BOUND_HASH_BYTES = 32

/**
 * Reading another app's keychain item makes macOS ask the user to allow it,
 * and the dialog waits for them. Long enough to find and click the button.
 */
const KEYCHAIN_TIMEOUT_MS = 3 * 60_000

export class KeychainError extends Error {}

/**
 * The AES key behind a browser's "Safe Storage" keychain item, or null when
 * there is no such item (that browser never stored anything encrypted).
 * Throws `KeychainError` when the item exists but access was refused.
 */
export async function readSafeStorageKey(service: string, account: string): Promise<Buffer | null> {
  let stdout: string
  try {
    const result = await execFileAsync(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', service, '-a', account],
      { timeout: KEYCHAIN_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 64 * 1024 }
    )
    stdout = result.stdout
  } catch (error) {
    // 44 = item not found; anything else is a refusal, a timeout or a
    // keychain that could not be unlocked.
    const code = (error as { code?: unknown }).code
    if (code === 44) return null
    throw new KeychainError(`security exited with ${String(code)}`)
  }
  // `-w` prints the password and a newline; the password itself never ends in one.
  const password = stdout.replace(/\n$/, '')
  if (!password) return null
  return deriveKey(password)
}

export function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ROUNDS, KEY_BYTES, 'sha1')
}

/**
 * One encrypted cell. Returns null when the blob is not a v10 payload, when
 * the key does not fit, or when `boundTo` is given and the plaintext carries
 * some other host's hash.
 */
export function decryptV10(key: Buffer, blob: Uint8Array, boundTo?: string): string | null {
  if (blob.length <= PREFIX.length) return null
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  if (buf.subarray(0, PREFIX.length).toString('latin1') !== PREFIX) return null
  const body = buf.subarray(PREFIX.length)
  if (body.length === 0 || body.length % BLOCK_BYTES !== 0) return null

  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV)
    plain = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    // Wrong key: the PKCS#7 padding check fails.
    return null
  }

  if (boundTo === undefined) return plain.toString('utf8')
  if (plain.length < BOUND_HASH_BYTES) return plain.toString('utf8')
  const expected = createHash('sha256').update(boundTo).digest()
  const actual = plain.subarray(0, BOUND_HASH_BYTES)
  if (timingSafeEqual(actual, expected)) return plain.subarray(BOUND_HASH_BYTES).toString('utf8')
  // No prefix at all (written before Chromium 130) is normal; a prefix for a
  // different host means the row or the key cannot be trusted.
  return looksLikeHostHash(plain) ? null : plain.toString('utf8')
}

/**
 * Heuristic for "the plaintext starts with a 32-byte hash we could not
 * match": real values are text, hashes are not.
 */
function looksLikeHostHash(plain: Buffer): boolean {
  for (let i = 0; i < BOUND_HASH_BYTES; i += 1) {
    const byte = plain[i]!
    if (byte < 0x20 || byte > 0x7e) return true
  }
  return false
}
