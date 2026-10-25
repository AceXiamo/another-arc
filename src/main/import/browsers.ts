import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImportBrowser } from '@shared/ext-import'

// The one place a browser is added. Everything that reads another browser's
// data — extensions, bookmarks, cookies, localStorage — goes through this
// table, so a new Chromium browser is a new row and nothing else.
//
// macOS only. Chromium browsers keep their profiles straight in their
// Application Support folder; the two from The Browser Company put them
// under "User Data" (the Windows layout). `resolveRoot` checks for both, so
// a wrong guess here still finds the profiles.

interface BrowserEntry {
  /** Product name, shown in the UI. Never translated. */
  name: string
  /** Profile folder, relative to $HOME. */
  path: string[]
  /**
   * Login keychain item holding the key the profile's cookies and passwords
   * are encrypted with. The account on the item is the product name, which
   * is the service without its suffix ("Arc Safe Storage" → "Arc").
   */
  keychain: string
  /** Where the bookmarks are: Arc has its own sidebar file, the rest use Chromium's. */
  bookmarks: 'arc-sidebar' | 'chromium'
}

const SAFE_STORAGE = ' Safe Storage'
const SUPPORT = ['Library', 'Application Support']

export const BROWSERS: Record<ImportBrowser, BrowserEntry> = {
  arc: { name: 'Arc', path: [...SUPPORT, 'Arc', 'User Data'], keychain: 'Arc Safe Storage', bookmarks: 'arc-sidebar' },
  dia: { name: 'Dia', path: [...SUPPORT, 'Dia', 'User Data'], keychain: 'Dia Safe Storage', bookmarks: 'chromium' },
  chrome: { name: 'Google Chrome', path: [...SUPPORT, 'Google', 'Chrome'], keychain: 'Chrome Safe Storage', bookmarks: 'chromium' },
  chromeBeta: {
    name: 'Google Chrome Beta',
    path: [...SUPPORT, 'Google', 'Chrome Beta'],
    keychain: 'Chrome Safe Storage',
    bookmarks: 'chromium'
  },
  chromeCanary: {
    name: 'Google Chrome Canary',
    path: [...SUPPORT, 'Google', 'Chrome Canary'],
    keychain: 'Chrome Safe Storage',
    bookmarks: 'chromium'
  },
  edge: { name: 'Microsoft Edge', path: [...SUPPORT, 'Microsoft Edge'], keychain: 'Microsoft Edge Safe Storage', bookmarks: 'chromium' },
  brave: {
    name: 'Brave',
    path: [...SUPPORT, 'BraveSoftware', 'Brave-Browser'],
    keychain: 'Brave Safe Storage',
    bookmarks: 'chromium'
  },
  vivaldi: { name: 'Vivaldi', path: [...SUPPORT, 'Vivaldi'], keychain: 'Vivaldi Safe Storage', bookmarks: 'chromium' },
  opera: {
    name: 'Opera',
    path: [...SUPPORT, 'com.operasoftware.Opera'],
    keychain: 'Opera Safe Storage',
    bookmarks: 'chromium'
  },
  chromium: { name: 'Chromium', path: [...SUPPORT, 'Chromium'], keychain: 'Chromium Safe Storage', bookmarks: 'chromium' },
  comet: { name: 'Comet', path: [...SUPPORT, 'Comet'], keychain: 'Comet Safe Storage', bookmarks: 'chromium' }
}

export interface BrowserRoot {
  browser: ImportBrowser
  /** The folder holding `Local State` and the profile directories. */
  root: string
}

export interface BrowserProfile {
  /** Directory name under the root ("Default", "Profile 1"). */
  dir: string
  /** The profile's own display name, falling back to its directory. */
  name: string
}

export function browserName(browser: ImportBrowser): string {
  return BROWSERS[browser].name
}

/** The keychain item and account a browser's encrypted values are behind. */
export function browserKeychain(browser: ImportBrowser): { service: string; account: string } {
  const service = BROWSERS[browser].keychain
  return { service, account: service.endsWith(SAFE_STORAGE) ? service.slice(0, -SAFE_STORAGE.length) : service }
}

export function bookmarkSource(browser: ImportBrowser): BrowserEntry['bookmarks'] {
  return BROWSERS[browser].bookmarks
}

/**
 * Where to look. `ARC_IMPORT_ROOT` replaces everything with one fake Arc
 * profile folder; integration tests (ARC_TEST) without it look nowhere, so
 * no test ever reads the real browsers' folders.
 */
export function browserRoots(env: NodeJS.ProcessEnv = process.env, home = homedir()): BrowserRoot[] {
  const override = env.ARC_IMPORT_ROOT
  if (override) return [{ browser: 'arc', root: override }]
  if (env.ARC_TEST === '1') return []
  return (Object.keys(BROWSERS) as ImportBrowser[]).map((browser) => ({ browser, root: join(home, ...BROWSERS[browser].path) }))
}

export function browserRoot(browser: ImportBrowser, env?: NodeJS.ProcessEnv, home?: string): string | null {
  return browserRoots(env, home).find((r) => r.browser === browser)?.root ?? null
}

/**
 * The folder that actually holds the profiles: the configured one, or a
 * "User Data" inside it for the browsers laid out the Windows way. Null when
 * the browser is not installed.
 */
export async function resolveRoot(root: string): Promise<string | null> {
  if (await hasProfiles(root)) return root
  const nested = join(root, 'User Data')
  return (await hasProfiles(nested)) ? nested : null
}

async function hasProfiles(root: string): Promise<boolean> {
  return (await isDirectory(join(root, 'Default'))) || (await isFile(join(root, 'Local State')))
}

/**
 * Every profile in a resolved root, in `Local State`'s order. Browsers that
 * keep no profile list (or lost it) still report the directories that are
 * laid out like one.
 */
export async function listProfiles(root: string): Promise<BrowserProfile[]> {
  const profile = asObject((await readJsonObject(join(root, 'Local State')))?.profile)
  const names = asObject(profile?.info_cache) ?? {}
  const found: BrowserProfile[] = []
  for (const dir of Object.keys(names)) {
    if (!isPlainSegment(dir) || !(await isDirectory(join(root, dir)))) continue
    const name = asObject(names[dir])?.name
    found.push({ dir, name: typeof name === 'string' && name.trim() ? name.trim() : dir })
  }
  if (found.length > 0) return found
  // No usable list: anything with a Preferences file is a profile.
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const fallback: BrowserProfile[] = []
  for (const dir of entries.sort()) {
    if (!/^(Default|Profile \d+)$/.test(dir)) continue
    if (await isFile(join(root, dir, 'Preferences'))) fallback.push({ dir, name: dir })
  }
  return fallback
}

/** The profile the browser had open last, which is the one to offer first. */
export async function lastUsedProfile(root: string): Promise<BrowserProfile | null> {
  const profiles = await listProfiles(root)
  if (profiles.length === 0) return null
  const lastUsed = asObject((await readJsonObject(join(root, 'Local State')))?.profile)?.last_used
  if (typeof lastUsed === 'string') {
    const match = profiles.find((p) => p.dir === lastUsed)
    if (match) return match
  }
  return profiles.find((p) => p.dir === 'Default') ?? profiles[0]!
}

/** Rejects anything that would climb out of the root. */
export function isPlainSegment(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..'
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    return asObject(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
