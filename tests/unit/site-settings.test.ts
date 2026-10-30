import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCloudGameLatency, isOfferedOn } from '../../src/shared/site-settings'

const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
vi.mock('electron', () => ({
  ipcMain: { on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => listeners.set(channel, listener) }
}))

const { Database } = await import('../../src/main/persistence/database')
const { SiteSettings } = await import('../../src/main/settings/site-settings')

const GENSHIN = 'https://ys.mihoyo.com'
const KEY = 'clgm_web_app_settings_hk4e_cn'

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial))
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k)
  }
}

describe('applyCloudGameLatency', () => {
  it('forces the canvas pipeline and leaves other settings alone', () => {
    const storage = memoryStorage({ [KEY]: JSON.stringify({ fpsSetting: 60, compatibleModeSwitch: true }) })
    applyCloudGameLatency(storage, true)
    expect(JSON.parse(storage.items.get(KEY)!)).toEqual({
      fpsSetting: 60,
      compatibleModeSwitch: false,
      hevcCodecSwitch: false,
      wrappedHevcSwitch: true
    })
  })

  it('puts back exactly what was there when switched off', () => {
    const before = { fpsSetting: 60, compatibleModeSwitch: true }
    const storage = memoryStorage({ [KEY]: JSON.stringify(before) })
    applyCloudGameLatency(storage, true)
    applyCloudGameLatency(storage, false)
    expect(JSON.parse(storage.items.get(KEY)!)).toEqual(before)
    expect([...storage.items.keys()]).toEqual([KEY])
  })

  it('keeps the first backup however many times the page loads', () => {
    const before = { compatibleModeSwitch: true }
    const storage = memoryStorage({ [KEY]: JSON.stringify(before) })
    applyCloudGameLatency(storage, true)
    // The client falling back on its own must not become the "original" value.
    const settings = JSON.parse(storage.items.get(KEY)!)
    storage.items.set(KEY, JSON.stringify({ ...settings, compatibleModeSwitch: false, wrappedHevcSwitch: false }))
    applyCloudGameLatency(storage, true)
    expect(JSON.parse(storage.items.get(KEY)!).wrappedHevcSwitch).toBe(true)
    applyCloudGameLatency(storage, false)
    expect(JSON.parse(storage.items.get(KEY)!)).toEqual(before)
  })

  it('touches nothing when off and never switched on', () => {
    const storage = memoryStorage({ [KEY]: 'left alone' })
    applyCloudGameLatency(storage, false)
    expect(storage.items.get(KEY)).toBe('left alone')
    expect(storage.items.size).toBe(1)
  })

  it('survives settings it cannot read', () => {
    for (const bad of ['not json', '[1]', 'null']) {
      const storage = memoryStorage({ [KEY]: bad })
      applyCloudGameLatency(storage, true)
      expect(JSON.parse(storage.items.get(KEY)!).wrappedHevcSwitch).toBe(true)
    }
  })
})

describe('SiteSettings', () => {
  let dir: string
  let db: InstanceType<typeof Database>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-settings-test-'))
    db = new Database(join(dir, 'browser.db'))
  })

  afterEach(() => {
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('offers a switch only on its own sites', () => {
    const settings = new SiteSettings(db)
    expect(settings.list(GENSHIN)).toEqual([{ id: 'cloudGameLowLatency', on: false }])
    expect(settings.list('https://example.com')).toEqual([])
    expect(isOfferedOn('cloudGameLowLatency', 'http://ys.mihoyo.com')).toBe(false)
  })

  it('ignores a switch set on a site it is not offered on', () => {
    const settings = new SiteSettings(db)
    settings.set('https://example.com', 'cloudGameLowLatency', true)
    expect(settings.isOn('https://example.com', 'cloudGameLowLatency')).toBe(false)
    expect(db.all('SELECT * FROM site_settings')).toEqual([])
  })

  it('remembers a switch across restarts until it is turned off', () => {
    new SiteSettings(db).set(GENSHIN, 'cloudGameLowLatency', true)
    const next = new SiteSettings(db)
    expect(next.isOn(GENSHIN, 'cloudGameLowLatency')).toBe(true)
    next.set(GENSHIN, 'cloudGameLowLatency', false)
    expect(new SiteSettings(db).isOn(GENSHIN, 'cloudGameLowLatency')).toBe(false)
  })

  it('answers a page by the origin of its frame, not by what it says', () => {
    new SiteSettings(db).set(GENSHIN, 'cloudGameLowLatency', true)
    const ask = (origin: string | undefined, id: unknown) => {
      const event: { returnValue?: unknown; senderFrame?: { origin: string } } = origin ? { senderFrame: { origin } } : {}
      listeners.get('arc:site-setting')!(event, id)
      return event.returnValue
    }
    expect(ask(GENSHIN, 'cloudGameLowLatency')).toBe(true)
    expect(ask('https://example.com', 'cloudGameLowLatency')).toBe(false)
    expect(ask(GENSHIN, 'constructor')).toBe(false)
    // A frame that is already gone still gets an answer: its renderer is blocked on it.
    expect(ask(undefined, 'cloudGameLowLatency')).toBe(false)
  })
})
