import { createHash, verify } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { isInside } from './installer'

// Chrome Web Store packages (CRX3): a signed header, then a ZIP archive.
//
//   "Cr24" | version (u32 = 3) | header size (u32) | CrxFileHeader | ZIP
//
// The header is a protobuf. Its signed part names the extension id; each
// proof is a public key with an RSA (or ECDSA) signature over
// "CRX3 SignedData\0" + len(signed part) + signed part + ZIP. The id is the
// first 16 bytes of SHA-256(public key) written with the letters a–p, so the
// proof whose key hashes to the id is the developer's, and it must verify.

const MAX_ENTRIES = 20_000
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024

export interface Crx {
  id: string
  /** DER (SPKI) public key the id comes from; goes into manifest.json as `key`. */
  publicKey: Buffer
  archive: Buffer
}

/** Extension id of a DER public key: SHA-256, first 16 bytes, hex digits mapped onto a–p. */
export function extensionIdOf(publicKey: Buffer): string {
  return idFromBytes(createHash('sha256').update(publicKey).digest().subarray(0, 16))
}

function idFromBytes(bytes: Buffer): string {
  return [...bytes.toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

/** Parse a CRX3 file and check its developer signature. Throws on anything else. */
export function parseCrx(file: Buffer): Crx {
  if (file.length < 12 || file.toString('latin1', 0, 4) !== 'Cr24') throw new Error('Not a CRX package')
  const version = file.readUInt32LE(4)
  if (version !== 3) throw new Error(`Unsupported CRX version ${version}`)
  const headerSize = file.readUInt32LE(8)
  if (12 + headerSize > file.length) throw new Error('Truncated CRX header')
  const header = file.subarray(12, 12 + headerSize)
  const archive = file.subarray(12 + headerSize)

  const proofs: Array<{ key: Buffer; signature: Buffer }> = []
  let signedData: Buffer | null = null
  for (const field of protobufFields(header)) {
    if (field.number === 2 && Buffer.isBuffer(field.value)) {
      // sha256_with_rsa: AsymmetricKeyProof { public_key = 1, signature = 2 }
      let key: Buffer | null = null
      let signature: Buffer | null = null
      for (const inner of protobufFields(field.value)) {
        if (inner.number === 1 && Buffer.isBuffer(inner.value)) key = inner.value
        if (inner.number === 2 && Buffer.isBuffer(inner.value)) signature = inner.value
      }
      if (key && signature) proofs.push({ key, signature })
    } else if (field.number === 10000 && Buffer.isBuffer(field.value)) {
      signedData = field.value
    }
  }
  if (!signedData) throw new Error('CRX has no signed header')
  let crxId: Buffer | null = null
  for (const field of protobufFields(signedData)) {
    if (field.number === 1 && Buffer.isBuffer(field.value)) crxId = field.value
  }
  if (!crxId || crxId.length !== 16) throw new Error('CRX has no extension id')
  const id = idFromBytes(crxId)

  const developer = proofs.find((p) => extensionIdOf(p.key) === id)
  if (!developer) throw new Error('CRX is not signed by its own key')
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedData.length)
  const message = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), length, signedData, archive])
  const valid = verify('sha256', message, { key: developer.key, format: 'der', type: 'spki' }, developer.signature)
  if (!valid) throw new Error('CRX signature does not match its contents')
  return { id, publicKey: developer.key, archive }
}

interface ProtobufField {
  number: number
  value: Buffer | bigint
}

/** Top-level fields of a protobuf message (varints, fixed and length-delimited). */
function* protobufFields(buf: Buffer): Generator<ProtobufField> {
  let pos = 0
  const varint = (): bigint => {
    let result = 0n
    for (let shift = 0n; ; shift += 7n) {
      if (pos >= buf.length || shift > 63n) throw new Error('Bad protobuf varint')
      const byte = buf[pos++]!
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
    }
  }
  while (pos < buf.length) {
    const tag = varint()
    const number = Number(tag >> 3n)
    switch (Number(tag & 7n)) {
      case 0:
        yield { number, value: varint() }
        break
      case 1:
        pos += 8
        break
      case 2: {
        const length = Number(varint())
        if (pos + length > buf.length) throw new Error('Bad protobuf length')
        yield { number, value: buf.subarray(pos, pos + length) }
        pos += length
        break
      }
      case 5:
        pos += 4
        break
      default:
        throw new Error('Bad protobuf wire type')
    }
  }
}

/**
 * Extract a ZIP archive into `dest` (stored and deflated entries, as
 * extension packages use). Paths may not leave `dest`.
 */
export async function unzip(archive: Buffer, dest: string): Promise<void> {
  // End of central directory: the last "PK\5\6" within the final 64 KiB.
  let end = -1
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('Not a ZIP archive')
  const count = archive.readUInt16LE(end + 10)
  let pos = archive.readUInt32LE(end + 16)
  if (count === 0xffff || pos === 0xffffffff) throw new Error('ZIP64 archives are not supported')
  if (count > MAX_ENTRIES) throw new Error('Too many files in the package')

  let total = 0
  for (let n = 0; n < count; n++) {
    if (pos + 46 > archive.length || archive.readUInt32LE(pos) !== 0x02014b50) throw new Error('Bad ZIP directory')
    const flags = archive.readUInt16LE(pos + 8)
    const method = archive.readUInt16LE(pos + 10)
    const compressedSize = archive.readUInt32LE(pos + 20)
    const size = archive.readUInt32LE(pos + 24)
    const nameLength = archive.readUInt16LE(pos + 28)
    const extraLength = archive.readUInt16LE(pos + 30)
    const commentLength = archive.readUInt16LE(pos + 32)
    const localOffset = archive.readUInt32LE(pos + 42)
    const name = archive.toString('utf8', pos + 46, pos + 46 + nameLength)
    pos += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error('Encrypted ZIP entries are not supported')
    total += size
    if (total > MAX_UNPACKED_BYTES) throw new Error('The package is too large')
    const target = join(dest, normalize(name.replace(/\\/g, '/')))
    if (!isInside(dest, target) || target === dest) throw new Error(`Unsafe path in package: ${name}`)

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Bad ZIP entry')
    const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28)
    const raw = archive.subarray(start, start + compressedSize)
    let data: Buffer
    if (method === 0) data = raw
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })
    else throw new Error(`Unsupported ZIP compression ${method}`)
    if (data.length !== size) throw new Error(`Corrupt ZIP entry: ${name}`)

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, data)
  }
}
