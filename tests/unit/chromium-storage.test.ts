import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPendingStorage,
  backupPath,
  indexedDbSurvey,
  localStorageBytes,
  PENDING_FILE,
  stageIndexedDb,
  stageLocalStorage
} from '../../src/main/import/chromium-storage'

const PARTITION = 'default'

let root: string
let source: string
let userData: string

/** A LevelDB directory as Chromium leaves one behind. */
function writeLevelDb(dir: string, contents: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(contents)) writeFileSync(join(dir, name), body)
}

const LIVE = () => join(userData, 'Partitions', PARTITION)
const ours = () => join(LIVE(), 'Local Storage')
const idb = () => join(LIVE(), 'IndexedDB')
const pending = () => JSON.parse(readFileSync(join(userData, PENDING_FILE), 'utf8')) as Record<string, string[]>
const site = (key: string) => `${key}.indexeddb.leveldb`
const blob = (key: string) => `${key}.indexeddb.blob`

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chromium-storage-test-'))
  source = join(root, 'Other', 'Default')
  userData = join(root, 'userData')

  writeLevelDb(join(source, 'Local Storage', 'leveldb'), {
    CURRENT: 'MANIFEST-000001\n',
    'MANIFEST-000001': 'manifest bytes',
    '000003.log': 'their records',
    LOCK: '',
    LOG: 'reused 1 times',
    'LOG.old': 'older log'
  })
  writeLevelDb(join(ours(), 'leveldb'), { CURRENT: 'MANIFEST-000001\n', '000003.log': 'our records' })

  // Three sites and an extension; one site also has a blob folder.
  for (const key of ['https_new.test_0', 'https_shared.test_0', 'chrome-extension_abcdef_0']) {
    writeLevelDb(join(source, 'IndexedDB', site(key)), { CURRENT: 'x\n', '000003.log': `${key} records` })
  }
  writeLevelDb(join(source, 'IndexedDB', blob('https_new.test_0')), { '1': 'blob bytes' })
  // This profile already stores something for one of them.
  writeLevelDb(join(idb(), site('https_shared.test_0')), { CURRENT: 'x\n', '000003.log': 'ours already' })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('localStorageBytes', () => {
  it('measures only what would be copied', async () => {
    expect(await localStorageBytes(source)).toBe(
      'MANIFEST-000001\n'.length + 'manifest bytes'.length + 'their records'.length
    )
  })

  it('is zero for a profile that never stored anything', async () => {
    expect(await localStorageBytes(join(root, 'nowhere'))).toBe(0)
  })
})

describe('stageLocalStorage', () => {
  it('copies the database aside and leaves the live one alone', async () => {
    expect(await stageLocalStorage(source, userData, PARTITION)).toBeGreaterThan(0)
    const staged = join(LIVE(), 'import-staged', 'Local Storage', 'leveldb')
    expect((await readdir(staged)).sort()).toEqual(['000003.log', 'CURRENT', 'MANIFEST-000001'])
    expect(readFileSync(join(ours(), 'leveldb', '000003.log'), 'utf8')).toBe('our records')
    expect(pending()).toEqual({ localStorage: [PARTITION], indexedDb: [] })
  })

  it('stages nothing when the other profile has nothing', async () => {
    expect(await stageLocalStorage(join(root, 'nowhere'), userData, PARTITION)).toBe(0)
    expect(existsSync(join(userData, PENDING_FILE))).toBe(false)
  })

  it('records a partition once however often it is staged', async () => {
    await stageLocalStorage(source, userData, PARTITION)
    await stageLocalStorage(source, userData, PARTITION)
    expect(pending().localStorage).toEqual([PARTITION])
  })
})

describe('indexedDbSurvey', () => {
  it('counts the sites it would move, skipping extensions and sites we already have', async () => {
    const survey = await indexedDbSurvey(source, userData, PARTITION)
    expect(survey.origins).toBe(1)
    expect(survey.bytes).toBe('x\n'.length + 'https_new.test_0 records'.length + 'blob bytes'.length)
  })

  it('is empty for a profile with no IndexedDB', async () => {
    expect(await indexedDbSurvey(join(root, 'nowhere'), userData, PARTITION)).toEqual({ origins: 0, bytes: 0 })
  })
})

describe('stageIndexedDb', () => {
  it('copies a site with its blob folder, and nothing else', async () => {
    expect(await stageIndexedDb(source, userData, PARTITION)).toMatchObject({ origins: 1 })
    const staged = join(LIVE(), 'import-staged', 'IndexedDB')
    expect(readdirSync(staged).sort()).toEqual([blob('https_new.test_0'), site('https_new.test_0')])
    expect(pending()).toEqual({ localStorage: [], indexedDb: [PARTITION] })
  })

  it('stages nothing, and asks for no restart, when every site is an extension or already here', async () => {
    rmSync(join(source, 'IndexedDB', site('https_new.test_0')), { recursive: true, force: true })
    rmSync(join(source, 'IndexedDB', blob('https_new.test_0')), { recursive: true, force: true })
    expect(await stageIndexedDb(source, userData, PARTITION)).toEqual({ origins: 0, bytes: 0 })
    expect(existsSync(join(userData, PENDING_FILE))).toBe(false)
  })
})

describe('applyPendingStorage', () => {
  it('swaps localStorage in and keeps the old database', async () => {
    await stageLocalStorage(source, userData, PARTITION)
    applyPendingStorage(userData)

    expect(readFileSync(join(ours(), 'leveldb', '000003.log'), 'utf8')).toBe('their records')
    expect(readFileSync(join(backupPath(userData, PARTITION), '000003.log'), 'utf8')).toBe('our records')
    expect(existsSync(join(LIVE(), 'import-staged'))).toBe(false)
    expect(existsSync(join(userData, PENDING_FILE))).toBe(false)
  })

  it('moves an IndexedDB site in without touching the one we already had', async () => {
    await stageIndexedDb(source, userData, PARTITION)
    applyPendingStorage(userData)

    expect(readdirSync(idb()).sort()).toEqual([
      blob('https_new.test_0'),
      site('https_new.test_0'),
      site('https_shared.test_0')
    ])
    expect(readFileSync(join(idb(), site('https_new.test_0'), '000003.log'), 'utf8')).toBe('https_new.test_0 records')
    expect(readFileSync(join(idb(), site('https_shared.test_0'), '000003.log'), 'utf8')).toBe('ours already')
    expect(existsSync(join(idb(), site('chrome-extension_abcdef_0')))).toBe(false)
  })

  it('leaves a site alone when it gained data between staging and the restart', async () => {
    await stageIndexedDb(source, userData, PARTITION)
    writeLevelDb(join(idb(), site('https_new.test_0')), { '000003.log': 'written since' })
    applyPendingStorage(userData)
    expect(readFileSync(join(idb(), site('https_new.test_0'), '000003.log'), 'utf8')).toBe('written since')
  })

  it('does both in one launch', async () => {
    await stageLocalStorage(source, userData, PARTITION)
    await stageIndexedDb(source, userData, PARTITION)
    applyPendingStorage(userData)
    expect(readFileSync(join(ours(), 'leveldb', '000003.log'), 'utf8')).toBe('their records')
    expect(existsSync(join(idb(), site('https_new.test_0')))).toBe(true)
    expect(existsSync(join(LIVE(), 'import-staged'))).toBe(false)
  })

  it('works on a profile with no databases yet', async () => {
    rmSync(ours(), { recursive: true, force: true })
    rmSync(idb(), { recursive: true, force: true })
    await stageLocalStorage(source, userData, PARTITION)
    await stageIndexedDb(source, userData, PARTITION)
    applyPendingStorage(userData)
    expect(readFileSync(join(ours(), 'leveldb', '000003.log'), 'utf8')).toBe('their records')
    expect(existsSync(join(idb(), site('https_new.test_0')))).toBe(true)
    expect(existsSync(backupPath(userData, PARTITION))).toBe(false)
  })

  it('does nothing without a marker', () => {
    applyPendingStorage(userData)
    expect(readFileSync(join(ours(), 'leveldb', '000003.log'), 'utf8')).toBe('our records')
  })

  it('clears the marker even when the staged copy is gone', async () => {
    await stageLocalStorage(source, userData, PARTITION)
    rmSync(join(LIVE(), 'import-staged'), { recursive: true, force: true })
    applyPendingStorage(userData)
    expect(existsSync(join(userData, PENDING_FILE))).toBe(false)
    expect(readFileSync(join(ours(), 'leveldb', '000003.log'), 'utf8')).toBe('our records')
  })

  it('ignores a partition name that is not one of ours', () => {
    writeFileSync(join(userData, PENDING_FILE), JSON.stringify({ localStorage: ['../../escape'], indexedDb: ['a/b'] }))
    applyPendingStorage(userData)
    expect(existsSync(join(userData, PENDING_FILE))).toBe(false)
  })
})
