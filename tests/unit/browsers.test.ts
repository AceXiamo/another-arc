import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bookmarkSource,
  browserKeychain,
  browserName,
  browserRoot,
  browserRoots,
  lastUsedProfile,
  listProfiles,
  resolveRoot
} from '../../src/main/import/browsers'

// Fake browser folders: the two layouts (profiles at the root, and profiles
// under "User Data"), with and without a usable Local State.

let base: string

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function profile(root: string, dir: string): void {
  writeJson(join(root, dir, 'Preferences'), {})
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'browsers-test-'))

  // Chromium's own layout: profiles straight in the folder.
  const flat = join(base, 'Flat')
  profile(flat, 'Default')
  profile(flat, 'Profile 1')
  profile(flat, 'Profile 2')
  writeJson(join(flat, 'Local State'), {
    profile: { last_used: 'Profile 1', info_cache: { Default: { name: 'Personal' }, 'Profile 1': { name: 'Work' }, 'Profile 9': {} } }
  })

  // The Browser Company layout: one level down.
  const nested = join(base, 'Nested')
  profile(join(nested, 'User Data'), 'Default')
  writeJson(join(nested, 'User Data', 'Local State'), { profile: { info_cache: { Default: { name: '  ' } } } })

  // No Local State at all: the directories are the only list there is.
  const bare = join(base, 'Bare')
  profile(bare, 'Default')
  profile(bare, 'Profile 3')
  mkdirSync(join(bare, 'Crashpad'), { recursive: true })
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('the catalogue', () => {
  it('names every browser and derives its keychain account from the item', () => {
    expect(browserName('arc')).toBe('Arc')
    expect(browserName('chrome')).toBe('Google Chrome')
    expect(browserKeychain('arc')).toEqual({ service: 'Arc Safe Storage', account: 'Arc' })
    expect(browserKeychain('edge')).toEqual({ service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' })
    expect(browserKeychain('brave')).toEqual({ service: 'Brave Safe Storage', account: 'Brave' })
  })

  it('knows that only Arc keeps its bookmarks outside the profile', () => {
    expect(bookmarkSource('arc')).toBe('arc-sidebar')
    for (const other of ['chrome', 'edge', 'brave', 'dia', 'comet'] as const) {
      expect(bookmarkSource(other)).toBe('chromium')
    }
  })
})

describe('browserRoots', () => {
  it('uses ARC_IMPORT_ROOT alone, and looks nowhere under ARC_TEST', () => {
    expect(browserRoots({ ARC_IMPORT_ROOT: '/fake' }, '/Users/x')).toEqual([{ browser: 'arc', root: '/fake' }])
    expect(browserRoots({ ARC_TEST: '1' }, '/Users/x')).toEqual([])
  })

  it('points at each browser in Application Support', () => {
    const roots = browserRoots({}, '/Users/x')
    const support = '/Users/x/Library/Application Support'
    expect(roots.find((r) => r.browser === 'arc')?.root).toBe(`${support}/Arc/User Data`)
    expect(roots.find((r) => r.browser === 'chrome')?.root).toBe(`${support}/Google/Chrome`)
    expect(roots.find((r) => r.browser === 'brave')?.root).toBe(`${support}/BraveSoftware/Brave-Browser`)
    expect(roots).toHaveLength(11)
    expect(browserRoot('comet', {}, '/Users/x')).toBe(`${support}/Comet`)
  })
})

describe('resolveRoot', () => {
  it('finds the profiles in either layout', async () => {
    expect(await resolveRoot(join(base, 'Flat'))).toBe(join(base, 'Flat'))
    expect(await resolveRoot(join(base, 'Nested'))).toBe(join(base, 'Nested', 'User Data'))
  })

  it('is null for a browser that is not installed', async () => {
    expect(await resolveRoot(join(base, 'Missing'))).toBeNull()
  })
})

describe('listProfiles', () => {
  it('uses the names Local State holds and skips the ones with no folder', async () => {
    expect(await listProfiles(join(base, 'Flat'))).toEqual([
      { dir: 'Default', name: 'Personal' },
      { dir: 'Profile 1', name: 'Work' }
    ])
  })

  it('falls back to the directory when the profile has no name', async () => {
    expect(await listProfiles(join(base, 'Nested', 'User Data'))).toEqual([{ dir: 'Default', name: 'Default' }])
  })

  it('finds profile folders without a Local State, and ignores other folders', async () => {
    expect(await listProfiles(join(base, 'Bare'))).toEqual([
      { dir: 'Default', name: 'Default' },
      { dir: 'Profile 3', name: 'Profile 3' }
    ])
  })
})

describe('lastUsedProfile', () => {
  it('is the one Local State points at', async () => {
    expect(await lastUsedProfile(join(base, 'Flat'))).toEqual({ dir: 'Profile 1', name: 'Work' })
  })

  it('falls back to Default, then to the first profile', async () => {
    expect(await lastUsedProfile(join(base, 'Bare'))).toEqual({ dir: 'Default', name: 'Default' })
    expect(await lastUsedProfile(join(base, 'Missing'))).toBeNull()
  })
})
