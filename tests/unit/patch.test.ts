import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_WINDOW_STATE } from '@shared/defaults'
import { applyPatch, mergeKeyed, type ShellState } from '@shared/patch'
import type { TabState } from '@shared/types'

function tab(id: string, title = id): TabState {
  return {
    id,
    spaceId: 's',
    url: 'https://x.test/',
    title,
    favicon: null,
    pinned: false,
    folderId: null,
    savedUrl: '',
    savedTitle: '',
    live: false,
    loading: false,
    audible: false,
    muted: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    error: null,
    zoomFactor: 1,
    lastActiveAt: 0
  }
}

function state(): ShellState {
  return {
    tabs: { a: tab('a'), b: tab('b') },
    spaces: {},
    folders: {},
    spaceOrder: [],
    window: { ...DEFAULT_WINDOW_STATE, activeSpaceId: 's' },
    settings: DEFAULT_SETTINGS,
    extensions: [],
    extensionPartition: 'persist:default',
    downloads: {},
    permissionPrompts: [],
    pageDialogs: [],
    find: null,
    isDev: false
  }
}

describe('mergeKeyed', () => {
  it('keeps identity of untouched entries', () => {
    const base = state().tabs
    const next = mergeKeyed(base, { a: { title: 'A' } })
    expect(next.a!.title).toBe('A')
    expect(next.b).toBe(base.b)
    expect(next.a).not.toBe(base.a)
  })

  it('removes and inserts', () => {
    const next = mergeKeyed(state().tabs, { a: null, c: tab('c') })
    expect(Object.keys(next).sort()).toEqual(['b', 'c'])
  })
})

describe('applyPatch', () => {
  it('only returns changed top-level keys', () => {
    const s = state()
    const next = applyPatch(s, { window: { sidebarCollapsed: true } })
    expect(Object.keys(next)).toEqual(['window'])
    expect(next.window!.sidebarCollapsed).toBe(true)
    expect(next.window!.activeSpaceId).toBe('s')
  })

  it('clears find state with null', () => {
    const s = { ...state(), find: { tabId: 'a', text: 'x', activeMatch: 1, matches: 2 } }
    expect(applyPatch(s, { find: null })).toEqual({ find: null })
  })
})
