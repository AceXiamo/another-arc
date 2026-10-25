import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { translator } from '@shared/i18n'
import { scanImportSources, scanSource, skipReasonText, summarize } from '../../src/main/extensions/browser-import'
import { compareVersions, resolveExtensionSource } from '../../src/main/extensions/installer'

// Fake Chromium "User Data" tree: Local State, Preferences + Secure
// Preferences, Extensions/<id>/<version>_N folders.
const id = (c: string) => c.repeat(32)
const IDS = {
  multi: id('a'), // three version folders; 1.10.0 must win over 1.9.0 (numeric compare)
  localized: id('b'), // __MSG_ name, settings only in Preferences
  disabled: id('c'),
  installed: id('d'),
  mv1: id('e'),
  broken: id('f'),
  component: id('g'),
  unpacked: id('h'),
  otherNewTab: id('k'), // any manifest overriding the new tab page
  crasher: 'nlipoenfbbikpbjkfpfillcgkoblgpmj',
  newTab: 'nnnkddnnlpamobajfibfdgfnbcnkgngh'
}

let root: string
let unpackedDir: string

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function addExtension(profile: string, extId: string, folder: string, manifest: Record<string, unknown>): string {
  const dir = join(root, profile, 'Extensions', extId, folder)
  writeJson(join(dir, 'manifest.json'), manifest)
  return dir
}

const mv3 = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  manifest_version: 3,
  name,
  version,
  ...extra
})

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'arc-import-unit-'))
  writeJson(join(root, 'Local State'), {
    profile: {
      last_used: 'Profile 2',
      info_cache: { Default: { name: 'Someone else' }, 'Profile 2': { name: 'Ace' } }
    }
  })
  // A different profile that must be ignored.
  addExtension('Default', id('i'), '1.0_0', mv3('Other Profile Ext', '1.0'))
  writeJson(join(root, 'Default', 'Secure Preferences'), {
    extensions: { settings: { [id('i')]: { location: 1, disable_reasons: [] } } }
  })

  const P = 'Profile 2'
  addExtension(P, IDS.multi, '1.9.0_0', mv3('Multi', '1.9.0'))
  addExtension(P, IDS.multi, '1.10.0_0', mv3('Multi', '1.10.0'))
  addExtension(P, IDS.multi, '1.2.0_0', mv3('Multi', '1.2.0'))
  const localized = addExtension(P, IDS.localized, '2.0_0', mv3('__MSG_appName__', '2.0', { default_locale: 'en' }))
  writeJson(join(localized, '_locales', 'en', 'messages.json'), { appName: { message: 'Localized Name' } })
  addExtension(P, IDS.disabled, '3.0_0', mv3('Turned Off', '3.0'))
  addExtension(P, IDS.installed, '1.0_0', mv3('Already Here', '1.0'))
  addExtension(P, IDS.mv1, '1.0_0', { manifest_version: 1, name: 'Ancient', version: '1.0' })
  mkdirSync(join(root, P, 'Extensions', IDS.broken, '1.0_0'), { recursive: true }) // no manifest
  addExtension(P, IDS.crasher, '4.4.44_0', mv3('Awesome Screen Recorder', '4.4.44'))
  addExtension(P, IDS.newTab, '11.0.41_0', mv3('Infinity New Tab', '11.0.41'))
  addExtension(P, IDS.otherNewTab, '1.0_0', mv3('Some New Tab', '1.0', { chrome_url_overrides: { newtab: 'index.html' } }))
  mkdirSync(join(root, P, 'Extensions', 'Temp', 'scoped_dir'), { recursive: true })
  unpackedDir = join(root, 'my-unpacked')
  writeJson(join(unpackedDir, 'manifest.json'), mv3('My Unpacked', '0.1'))

  writeJson(join(root, P, 'Preferences'), {
    extensions: {
      pinned_extensions: [IDS.multi],
      settings: {
        [IDS.localized]: { location: 1, path: `${IDS.localized}/2.0_0` }, // no disable_reasons = enabled
        [IDS.disabled]: { location: 1, disable_reasons: [1] }
      }
    }
  })
  writeJson(join(root, P, 'Secure Preferences'), {
    extensions: {
      settings: {
        [IDS.multi]: { location: 1, disable_reasons: [], path: `${IDS.multi}/1.9.0_0` },
        [IDS.installed]: { location: 1, disable_reasons: [] },
        [IDS.mv1]: { location: 1, disable_reasons: [] },
        [IDS.broken]: { location: 1, disable_reasons: [], manifest: { name: 'Broken Stored Name', version: '1.0' } },
        [IDS.crasher]: { location: 1, disable_reasons: [] },
        [IDS.newTab]: { location: 1, disable_reasons: [] },
        [IDS.component]: { location: 5, path: '/Applications/Arc.app/Contents/Resources/pdf' },
        [IDS.unpacked]: { location: 4, path: unpackedDir, disable_reasons: [] },
        [IDS.otherNewTab]: { location: 1, disable_reasons: [] },
        Temp: { location: 1 }
      }
    }
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('compareVersions / resolveExtensionSource', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('4.21.0', '4.20.3')).toBeGreaterThan(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('2', '10')).toBeLessThan(0)
  })

  it('resolves Extensions/<id> to the newest version folder and leaves extension folders alone', async () => {
    const extDir = join(root, 'Profile 2', 'Extensions', IDS.multi)
    expect(await resolveExtensionSource(extDir)).toBe(join(extDir, '1.10.0_0'))
    expect(await resolveExtensionSource(unpackedDir)).toBe(unpackedDir)
    const broken = join(root, 'Profile 2', 'Extensions', IDS.broken)
    expect(await resolveExtensionSource(broken)).toBe(broken)
  })
})

describe('scanSource', () => {
  it('lists the last-used profile with names, versions and skip reasons', async () => {
    const source = await scanSource({ browser: 'arc', root }, new Set([IDS.installed]))
    expect(source).not.toBeNull()
    expect(source!.profileDir).toBe('Profile 2')
    expect(source!.profileName).toBe('Ace')
    expect(source!.browserName).toBe('Arc')

    const byId = new Map(source!.extensions.map((e) => [e.id, e]))
    // Component extensions, non-id folders and other profiles are not listed.
    expect([...byId.keys()].sort()).toEqual(
      [IDS.multi, IDS.localized, IDS.disabled, IDS.installed, IDS.mv1, IDS.broken, IDS.crasher, IDS.newTab, IDS.unpacked, IDS.otherNewTab].sort()
    )

    expect(byId.get(IDS.multi)).toMatchObject({
      name: 'Multi',
      version: '1.10.0',
      manifestVersion: 3,
      enabledInSource: true,
      skip: null,
      sourcePath: join(root, 'Profile 2', 'Extensions', IDS.multi)
    })
    expect(byId.get(IDS.multi)?.pinnedInSource).toBe(true)
    expect(byId.get(IDS.localized)).toMatchObject({ name: 'Localized Name', version: '2.0', skip: null, pinnedInSource: false })
    expect(byId.get(IDS.disabled)).toMatchObject({ name: 'Turned Off', enabledInSource: false, skip: 'disabled' })
    expect(byId.get(IDS.installed)?.skip).toBe('installed')
    expect(byId.get(IDS.mv1)).toMatchObject({ manifestVersion: 1, skip: 'manifestVersion' })
    expect(byId.get(IDS.broken)).toMatchObject({ name: 'Broken Stored Name', skip: 'unreadable' })
    expect(byId.get(IDS.crasher)?.skip).toBe('incompatible')
    expect(byId.get(IDS.newTab)?.skip).toBe('incompatible')
    expect(byId.get(IDS.otherNewTab)?.skip).toBe('newTab')
    expect(byId.get(IDS.unpacked)).toMatchObject({ name: 'My Unpacked', sourcePath: unpackedDir, skip: null })

    // Sorted by name.
    const names = source!.extensions.map((e) => e.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })))

    expect(summarize(source!)).toEqual({ id: 'arc', browserName: 'Arc', profileName: 'Ace', importable: 3, total: 10 })
  })

  it('explains skips in the UI language', async () => {
    const source = (await scanSource({ browser: 'arc', root }, new Set()))!
    const en = translator('en')
    const reason = (extId: string) => skipReasonText(source.extensions.find((e) => e.id === extId)!, 'Arc', en)
    expect(reason(IDS.disabled)).toBe('turned off in Arc')
    expect(reason(IDS.crasher)).toBe('crashes this browser')
    expect(reason(IDS.newTab)).toContain('new tab page')
    expect(reason(IDS.otherNewTab)).toBe(reason(IDS.newTab))
    expect(reason(IDS.mv1)).toContain('1')
    expect(skipReasonText(source.extensions.find((e) => e.id === IDS.disabled)!, 'Arc', translator('zh-CN'))).toContain('Arc')
  })

  it('falls back to Default without Local State, and finds nothing in an empty folder', async () => {
    const other = mkdtempSync(join(tmpdir(), 'arc-import-unit-'))
    try {
      expect(await scanSource({ browser: 'chrome', root: other }, new Set())).toBeNull()
      mkdirSync(join(other, 'Default', 'Extensions', id('j'), '1.0_0'), { recursive: true })
      writeJson(join(other, 'Default', 'Extensions', id('j'), '1.0_0', 'manifest.json'), mv3('Chrome Ext', '1.0'))
      writeJson(join(other, 'Default', 'Preferences'), { extensions: { settings: { [id('j')]: { location: 1 } } } })
      const source = await scanSource({ browser: 'chrome', root: other }, new Set())
      expect(source).toMatchObject({ id: 'chrome', browserName: 'Google Chrome', profileDir: 'Default', profileName: 'Default' })
      expect(source!.extensions.map((e) => e.name)).toEqual(['Chrome Ext'])
      // Missing roots are skipped, not errors.
      expect(await scanImportSources(new Set(), [{ browser: 'arc', root: join(other, 'nope') }])).toEqual([])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

