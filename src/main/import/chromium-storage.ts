import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

// Carries another Chromium profile's on-disk site storage over: localStorage
// and IndexedDB. Neither can be written through an API — they are LevelDB
// databases Chromium holds open for as long as the app runs — so the import
// copies them in beside ours and the next launch moves them into place
// before any session exists, the one moment they are not locked.
//
// The two differ in how they merge:
//
// - localStorage is one database for the whole partition, and nothing short
//   of a LevelDB of our own could merge two. It replaces what this profile
//   had, and the old database is kept beside the new one as a backup.
// - IndexedDB is a directory per site, so it merges for real: a site this
//   profile has never stored anything for is moved in, and a site that
//   already has data here is left alone. Nothing is overwritten.
//
// Extensions are never carried over (`chrome-extension_…`): an extension's
// own data stays in the other browser, as the confirmation says. Sites whose
// storage key is partitioned by a top-level site live under `WebStorage/`
// with a row in the quota database, and are not imported either.

/** Marker at the top of userData; its absence is the fast path on every launch. */
export const PENDING_FILE = 'import-pending.json'

const STAGED = 'import-staged'
const LOCAL_STORAGE = 'Local Storage'
const LEVELDB = 'leveldb'
const BACKUP = 'leveldb.before-import'
const INDEXED_DB = 'IndexedDB'

/** LevelDB's lock and its log of past runs; both belong to the copy's owner. */
const NOT_COPIED = new Set(['LOCK', 'LOG', 'LOG.old'])

/** `https_example.com_0.indexeddb.leveldb` / `….indexeddb.blob`. */
const INDEXED_DB_DIR = /^(.+)\.indexeddb\.(leveldb|blob)$/
const EXTENSION_KEY = /^chrome-extension_/

const SAFE_SEGMENT = /^[A-Za-z0-9 ._-]+$/

interface Pending {
  /** Partition directories with a staged localStorage database. */
  localStorage: string[]
  /** Partition directories with staged IndexedDB site folders. */
  indexedDb: string[]
}

export interface IndexedDbSurvey {
  /** Sites that would be moved in — the ones this profile has nothing for. */
  origins: number
  bytes: number
}

function partitionDir(userData: string, partition: string): string {
  return join(userData, 'Partitions', partition)
}

function stagedDir(userData: string, partition: string): string {
  return join(partitionDir(userData, partition), STAGED)
}

/** Where the replaced localStorage database is kept after a swap. */
export function backupPath(userData: string, partition: string): string {
  return join(partitionDir(userData, partition), LOCAL_STORAGE, BACKUP)
}

// -- localStorage ------------------------------------------------------------

/** Bytes the other browser's localStorage takes up; 0 when it has none. */
export async function localStorageBytes(profileDir: string): Promise<number> {
  return dirBytes(join(profileDir, LOCAL_STORAGE, LEVELDB))
}

/**
 * Copy `profileDir`'s localStorage next to ours and record that the next
 * launch should swap it in. Returns the bytes staged, or 0 when the other
 * profile has nothing. Safe to run again: a half-finished copy is discarded.
 */
export async function stageLocalStorage(profileDir: string, userData: string, partition: string): Promise<number> {
  const source = join(profileDir, LOCAL_STORAGE, LEVELDB)
  const bytes = await localStorageBytes(profileDir)
  if (bytes === 0) return 0

  const staged = join(stagedDir(userData, partition), LOCAL_STORAGE, LEVELDB)
  await mkdir(join(staged, '..'), { recursive: true })
  await rm(staged, { recursive: true, force: true })
  try {
    await cp(source, staged, { recursive: true, filter: (src) => !NOT_COPIED.has(basename(src)) })
  } catch (error) {
    await rm(staged, { recursive: true, force: true })
    throw error
  }
  addPending(userData, partition, 'localStorage')
  return bytes
}

// -- IndexedDB ---------------------------------------------------------------

/** The site folders worth moving over: not an extension's, and not already here. */
async function mergeableSites(profileDir: string, userData: string, partition: string): Promise<Map<string, string[]>> {
  const source = join(profileDir, INDEXED_DB)
  const sites = new Map<string, string[]>()
  let entries: string[]
  try {
    entries = await readdir(source)
  } catch {
    return sites
  }
  const here = new Set(listSiteKeys(join(partitionDir(userData, partition), INDEXED_DB)))
  for (const entry of entries.sort()) {
    const match = INDEXED_DB_DIR.exec(entry)
    if (!match) continue
    const key = match[1]!
    // An extension's own data stays where it is; a site we already store
    // anything for keeps what it has.
    if (EXTENSION_KEY.test(key) || here.has(key)) continue
    const dirs = sites.get(key)
    if (dirs) dirs.push(entry)
    else sites.set(key, [entry])
  }
  return sites
}

/** What an IndexedDB import would move over, without copying anything. */
export async function indexedDbSurvey(profileDir: string, userData: string, partition: string): Promise<IndexedDbSurvey> {
  const sites = await mergeableSites(profileDir, userData, partition)
  let bytes = 0
  for (const dirs of sites.values()) {
    for (const dir of dirs) bytes += await dirBytes(join(profileDir, INDEXED_DB, dir))
  }
  return { origins: sites.size, bytes }
}

/**
 * Copy the site folders this profile has nothing for, for the next launch to
 * move in. A site's `.leveldb` and its `.blob` folder travel together.
 */
export async function stageIndexedDb(profileDir: string, userData: string, partition: string): Promise<IndexedDbSurvey> {
  const sites = await mergeableSites(profileDir, userData, partition)
  if (sites.size === 0) return { origins: 0, bytes: 0 }

  const target = join(stagedDir(userData, partition), INDEXED_DB)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  let bytes = 0
  let origins = 0
  for (const [, dirs] of sites) {
    try {
      for (const dir of dirs) {
        await cp(join(profileDir, INDEXED_DB, dir), join(target, dir), {
          recursive: true,
          filter: (src) => !NOT_COPIED.has(basename(src))
        })
        bytes += await dirBytes(join(target, dir))
      }
      origins += 1
    } catch (error) {
      // One unreadable site does not stop the rest; a partly copied site is
      // dropped so nothing half-written is ever moved in.
      for (const dir of dirs) await rm(join(target, dir), { recursive: true, force: true })
      console.error('[import] skipped an IndexedDB site', error)
    }
  }
  if (origins === 0) {
    await rm(target, { recursive: true, force: true })
    return { origins: 0, bytes: 0 }
  }
  addPending(userData, partition, 'indexedDb')
  return { origins, bytes }
}

// -- the launch step ---------------------------------------------------------

/**
 * Launch step, before any session is created: move in whatever the last run
 * staged. Synchronous (a session must not open the databases first) and
 * silent on failure — a browser that cannot migrate still has to start.
 */
export function applyPendingStorage(userData: string): void {
  const marker = join(userData, PENDING_FILE)
  if (!existsSync(marker)) return
  let pending: Pending = { localStorage: [], indexedDb: [] }
  try {
    pending = readPending(userData)
  } catch (error) {
    console.error('[import] could not read the staged storage marker', error)
  }
  for (const partition of pending.localStorage) {
    try {
      swapLocalStorage(join(partitionDir(userData, partition), LOCAL_STORAGE), stagedDir(userData, partition))
    } catch (error) {
      console.error('[import] could not apply the staged localStorage', error)
    }
  }
  for (const partition of pending.indexedDb) {
    try {
      mergeIndexedDb(join(partitionDir(userData, partition), INDEXED_DB), stagedDir(userData, partition))
    } catch (error) {
      console.error('[import] could not apply the staged IndexedDB', error)
    }
  }
  // Whatever happened, do not try again on the next launch.
  for (const partition of new Set([...pending.localStorage, ...pending.indexedDb])) {
    rmSync(stagedDir(userData, partition), { recursive: true, force: true })
  }
  rmSync(marker, { force: true })
}

function swapLocalStorage(dir: string, staged: string): void {
  const incoming = join(staged, LOCAL_STORAGE, LEVELDB)
  if (!existsSync(incoming)) return
  const live = join(dir, LEVELDB)
  const backup = join(dir, BACKUP)
  rmSync(backup, { recursive: true, force: true })
  if (existsSync(live)) renameSync(live, backup)
  renameSync(incoming, ensureDir(dir, LEVELDB))
}

/**
 * Site folders move in one at a time, and only where this profile has
 * nothing: between staging and now, a site may have stored something here.
 */
function mergeIndexedDb(dir: string, staged: string): void {
  const incoming = join(staged, INDEXED_DB)
  if (!existsSync(incoming)) return
  const here = new Set(listSiteKeys(dir))
  for (const entry of readdirSync(incoming).sort()) {
    const match = INDEXED_DB_DIR.exec(entry)
    if (!match || here.has(match[1]!)) continue
    renameSync(join(incoming, entry), ensureDir(dir, entry))
  }
}

/** Creates `dir` if missing and returns the path of `name` inside it. */
function ensureDir(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

/** The site keys an IndexedDB folder already holds, extensions included. */
function listSiteKeys(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.map((entry) => INDEXED_DB_DIR.exec(entry)?.[1]).filter((key): key is string => key !== undefined)
}

// -- shared ------------------------------------------------------------------

/** Bytes of the files that would be copied out of one directory tree. */
async function dirBytes(dir: string): Promise<number> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    if (NOT_COPIED.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirBytes(path)
      continue
    }
    try {
      total += (await stat(path)).size
    } catch {
      // Removed between the listing and the stat; it would not be copied either.
    }
  }
  return total
}

function readPending(userData: string): Pending {
  const raw: unknown = JSON.parse(readFileSync(join(userData, PENDING_FILE), 'utf8'))
  const value = (raw ?? {}) as Partial<Record<keyof Pending, unknown>>
  return { localStorage: partitions(value.localStorage), indexedDb: partitions(value.indexedDb) }
}

/** These names end up in a path: only ever our own partition directories. */
function partitions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === 'string' && SAFE_SEGMENT.test(p)) : []
}

function addPending(userData: string, partition: string, kind: keyof Pending): void {
  let pending: Pending = { localStorage: [], indexedDb: [] }
  try {
    pending = readPending(userData)
  } catch {
    // No marker yet, or one we cannot read; start a fresh one.
  }
  if (!pending[kind].includes(partition)) pending[kind].push(partition)
  writeFileSync(join(userData, PENDING_FILE), JSON.stringify(pending))
}
