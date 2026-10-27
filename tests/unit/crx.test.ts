import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionIdOf, parseCrx, unzip } from '../../src/main/extensions/crx'

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-crx-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function varint(n: number): Buffer {
  const out: number[] = []
  do {
    let byte = n & 0x7f
    n = Math.floor(n / 128)
    if (n > 0) byte |= 0x80
    out.push(byte)
  } while (n > 0)
  return Buffer.from(out)
}

/** A length-delimited protobuf field. */
function field(number: number, value: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value])
}

/** A ZIP with one entry per file (deflated, or stored when `store`). */
function zip(files: Record<string, string>, store = false): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const packed = store ? data : deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(store ? 0 : 8, 10)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBytes.length, 28)
    dir.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, packed)
    central.push(dir, nameBytes)
    offset += 30 + nameBytes.length + packed.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

/** A CRX3 package signed with a fresh key of its own (`tamper` changes the archive afterwards). */
function crx(archive: Buffer, opts: { tamper?: boolean } = {}) {
  const developer = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicKey = developer.publicKey.export({ type: 'spki', format: 'der' })
  const crxId = createHash('sha256').update(publicKey).digest().subarray(0, 16)
  const signedData = field(1, crxId)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedData.length)
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00'), length, signedData, archive]), developer.privateKey)
  const header = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), field(10000, signedData)])
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'latin1')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  const body = opts.tamper ? Buffer.from(archive).fill(0x20, archive.length - 30, archive.length - 25) : archive
  return { file: Buffer.concat([prefix, header, body]), publicKey, id: extensionIdOf(publicKey) }
}

describe('CRX packages', () => {
  it('reads the id and key of a package signed by its own key', () => {
    const archive = zip({ 'manifest.json': '{"name":"x","version":"1","manifest_version":3}' })
    const { file, publicKey, id } = crx(archive)
    const parsed = parseCrx(file)
    expect(parsed.id).toBe(id)
    expect(parsed.id).toMatch(/^[a-p]{32}$/)
    expect(parsed.publicKey.equals(publicKey)).toBe(true)
    expect(parsed.archive.equals(archive)).toBe(true)
  })

  it('rejects a package whose contents were changed after signing', () => {
    const { file } = crx(zip({ 'manifest.json': '{"name":"x"}', 'a.js': 'console.log(1)'.repeat(10) }), { tamper: true })
    expect(() => parseCrx(file)).toThrow(/signature/)
  })

  it('rejects files that are not CRX3', () => {
    expect(() => parseCrx(Buffer.from('PK\x03\x04 not a crx'))).toThrow()
    const v2 = Buffer.alloc(16)
    v2.write('Cr24', 0, 'latin1')
    v2.writeUInt32LE(2, 4)
    expect(() => parseCrx(v2)).toThrow(/version 2/)
  })

  it('unpacks stored and deflated entries into folders', async () => {
    const dest = tempDir()
    await unzip(zip({ 'manifest.json': '{"a":1}', 'js/bg.js': 'x'.repeat(5000) }), dest)
    await unzip(zip({ 'icons/16.png': 'png' }, true), dest)
    expect(readFileSync(join(dest, 'manifest.json'), 'utf8')).toBe('{"a":1}')
    expect(readFileSync(join(dest, 'js/bg.js'), 'utf8')).toBe('x'.repeat(5000))
    expect(readFileSync(join(dest, 'icons/16.png'), 'utf8')).toBe('png')
  })

  it('refuses paths that leave the destination', async () => {
    await expect(unzip(zip({ '../evil.js': 'x' }), tempDir())).rejects.toThrow(/Unsafe path/)
    await expect(unzip(zip({ '/abs/evil.js': 'x' }), tempDir())).resolves.toBeUndefined()
  })
})
