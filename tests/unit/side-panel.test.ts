import { describe, expect, it } from 'vitest'
import { resolveExtensionUrl, SidePanelState, type StoredPanelState } from '../../src/main/extensions/side-panel'
import { clampToArea, placeWindow } from '../../src/main/extensions/window-placement'

const ID = 'mcohilncbfahbmgdjkbpemcciiolgcge'

function state(defaultPath: string | null = 'sidepanel-init.html', initial?: unknown) {
  const saved: Array<Record<string, StoredPanelState>> = []
  const s = new SidePanelState(initial, { defaultPath: () => defaultPath, persist: (all) => saved.push(all) })
  return { s, saved }
}

describe('SidePanelState', () => {
  it('defaults to the manifest path, enabled, with no behavior chosen', () => {
    const { s } = state()
    expect(s.behavior(ID)).toBeUndefined()
    expect(s.getPanelBehavior(ID)).toEqual({ openPanelOnActionClick: false })
    expect(s.getOptions(ID, {})).toEqual({ path: 'sidepanel-init.html', enabled: true })
    expect(s.panelUrl(ID)).toBe(`chrome-extension://${ID}/sidepanel-init.html`)
    expect(s.hasPanel(ID)).toBe(true)
  })

  it('keeps the behavior and global options, and persists only real changes', () => {
    const { s, saved } = state()
    s.setPanelBehavior(ID, { openPanelOnActionClick: true })
    s.setPanelBehavior(ID, { openPanelOnActionClick: true })
    s.setPanelBehavior(ID, { nonsense: 1 })
    expect(s.behavior(ID)).toBe(true)
    s.setOptions(ID, { path: 'sidepanel.html#?swap', enabled: true })
    expect(s.panelUrl(ID)).toBe(`chrome-extension://${ID}/sidepanel.html#?swap`)
    expect(saved).toHaveLength(2)
    expect(saved.at(-1)).toEqual({ [ID]: { openOnAction: true, path: 'sidepanel.html#?swap', enabled: true } })
    // A restart reads the persisted values back.
    const again = state('sidepanel-init.html', saved.at(-1)).s
    expect(again.behavior(ID)).toBe(true)
    expect(again.getOptions(ID, {})).toEqual({ path: 'sidepanel.html#?swap', enabled: true })
  })

  it('tab options override the global ones for that tab only', () => {
    const { s, saved } = state()
    s.setOptions(ID, { tabId: 7, enabled: false })
    expect(s.panelUrl(ID, 7)).toBeNull()
    expect(s.panelUrl(ID, 8)).not.toBeNull()
    expect(s.getOptions(ID, { tabId: 7 })).toEqual({ path: 'sidepanel-init.html', enabled: false, tabId: 7 })
    expect(saved).toHaveLength(0)
    s.tabRemoved(7)
    expect(s.panelUrl(ID, 7)).not.toBeNull()
  })

  it('has no panel without a path, and forgets an uninstalled extension', () => {
    const { s, saved } = state(null)
    expect(s.hasPanel(ID)).toBe(false)
    expect(s.panelUrl(ID)).toBeNull()
    s.setPanelBehavior(ID, { openPanelOnActionClick: false })
    s.forget(ID)
    expect(s.behavior(ID)).toBeUndefined()
    expect(saved.at(-1)).toEqual({})
  })

  it('only resolves pages of the extension itself', () => {
    expect(resolveExtensionUrl(ID, '/a/b.html?x#y')).toBe(`chrome-extension://${ID}/a/b.html?x#y`)
    expect(resolveExtensionUrl(ID, 'https://evil.example/')).toBeNull()
    expect(resolveExtensionUrl(ID, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html')).toBeNull()
  })
})

describe('placeWindow', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 }
  const size = { width: 300, height: 320 }

  it('opens below the toolbar button', () => {
    const anchor = { x: 266, y: 203, width: 23, height: 23 }
    expect(placeWindow(size, { anchor, workArea })).toEqual({ x: 266, y: 232 })
  })

  it('prefers the remembered position over the button', () => {
    const anchor = { x: 266, y: 203, width: 23, height: 23 }
    expect(placeWindow(size, { saved: { x: 900, y: 100 }, anchor, workArea })).toEqual({ x: 900, y: 100 })
  })

  it('without a button, goes to the browser window’s top-right corner', () => {
    const parent = { x: 100, y: 60, width: 1200, height: 800 }
    expect(placeWindow(size, { parent, workArea })).toEqual({ x: 988, y: 108 })
  })

  it('stays on screen', () => {
    expect(placeWindow(size, { saved: { x: 1400, y: 880 }, workArea })).toEqual({ x: 1140, y: 580 })
    expect(placeWindow(size, { saved: { x: -500, y: -40 }, workArea })).toEqual({ x: 0, y: 25 })
    expect(clampToArea({ x: 50, y: 50, width: 2000, height: 2000 }, workArea)).toEqual({ x: 0, y: 25 })
  })
})
