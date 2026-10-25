import { describe, expect, it } from 'vitest'
import { sanitizeSpaceTheme } from '@shared/theme'
import { BrowserModel, type FolderData, type ModelListener, type SpaceData, type TabData } from '../../src/main/tabs/model'

function makeListener() {
  const events: string[] = []
  const listener: ModelListener = {
    tabAdded: (t) => events.push(`tabAdded:${t.id}`),
    tabUpdated: (id, p) => events.push(`tabUpdated:${id}:${Object.keys(p).join(',')}`),
    tabRemoved: (t) => events.push(`tabRemoved:${t.id}`),
    spaceAdded: (s) => events.push(`spaceAdded:${s.id}`),
    spaceUpdated: (id, p) => events.push(`spaceUpdated:${id}:${Object.keys(p).join(',')}`),
    spaceRemoved: (id) => events.push(`spaceRemoved:${id}`),
    spaceOrderChanged: (o) => events.push(`spaceOrder:${o.join(',')}`),
    activeSpaceChanged: (id) => events.push(`activeSpace:${id}`),
    folderAdded: (f) => events.push(`folderAdded:${f.id}`),
    folderUpdated: (id, p) => events.push(`folderUpdated:${id}:${Object.keys(p).join(',')}`),
    folderRemoved: (f) => events.push(`folderRemoved:${f.id}`)
  }
  return { events, listener }
}

function space(id: string): SpaceData {
  return {
    id,
    name: id,
    icon: '•',
    color: '#000000',
    theme: sanitizeSpaceTheme(null),
    profileId: 'default',
    pinnedTabIds: [],
    savedIds: [],
    tabIds: [],
    activeTabId: null,
    createdAt: 0
  }
}

function folder(id: string, spaceId: string, parentId: string | null = null): FolderData {
  return { id, spaceId, parentId, name: id, collapsed: false, childIds: [], createdAt: 0 }
}

function tab(id: string, spaceId: string, pinned = false): TabData {
  return {
    id,
    spaceId,
    url: `https://${id}.test/`,
    title: id,
    favicon: null,
    pinned,
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
    lastActiveAt: 0,
    createdAt: 0,
    navState: null
  }
}

function setup() {
  const { events, listener } = makeListener()
  const m = new BrowserModel(listener)
  m.addSpace(space('s1'))
  m.addSpace(space('s2'))
  for (const id of ['a', 'b', 'c']) m.addTab(tab(id, 's1'))
  m.addTab(tab('p', 's1', true))
  m.addTab(tab('x', 's2'))
  events.length = 0
  return { m, events }
}

describe('BrowserModel', () => {
  it('orders pinned tabs before regular tabs', () => {
    const { m } = setup()
    expect(m.orderedTabIds('s1')).toEqual(['p', 'a', 'b', 'c'])
    // The first tab added to an empty space becomes active.
    expect(m.getSpace('s1')!.activeTabId).toBe('a')
    expect(m.activeSpaceId).toBe('s1')
  })

  it('activating a tab in another space switches space', () => {
    const { m, events } = setup()
    m.activateTab('x')
    expect(m.activeSpaceId).toBe('s2')
    expect(events).toContain('activeSpace:s2')
  })

  it('picks the next tab (then previous) when closing the active tab', () => {
    const { m } = setup()
    m.activateTab('b')
    m.removeTab('b')
    expect(m.getSpace('s1')!.activeTabId).toBe('c')
    m.removeTab('c')
    expect(m.getSpace('s1')!.activeTabId).toBe('a')
    m.removeTab('a')
    expect(m.getSpace('s1')!.activeTabId).toBe('p')
    m.removeTab('p')
    expect(m.getSpace('s1')!.activeTabId).toBeNull()
  })

  it('closing a background tab keeps the active tab', () => {
    const { m } = setup()
    m.activateTab('a')
    m.removeTab('c')
    expect(m.getSpace('s1')!.activeTabId).toBe('a')
  })

  it('reorders within a section using post-removal indices', () => {
    const { m } = setup()
    m.moveTab('a', { spaceId: 's1', pinned: false, index: 2 })
    expect(m.getSpace('s1')!.tabIds).toEqual(['b', 'c', 'a'])
    m.moveTab('a', { spaceId: 's1', pinned: false, index: 0 })
    expect(m.getSpace('s1')!.tabIds).toEqual(['a', 'b', 'c'])
  })

  it('ignores no-op moves', () => {
    const { m, events } = setup()
    m.moveTab('b', { spaceId: 's1', pinned: false, index: 1 })
    expect(events).toEqual([])
  })

  it('pins and unpins by moving between sections', () => {
    const { m } = setup()
    m.moveTab('b', { spaceId: 's1', pinned: true, index: 0 })
    expect(m.getSpace('s1')!.pinnedTabIds).toEqual(['b', 'p'])
    expect(m.getTab('b')!.pinned).toBe(true)
    m.moveTab('p', { spaceId: 's1', pinned: false, index: 99 })
    expect(m.getSpace('s1')!.tabIds).toEqual(['a', 'c', 'p'])
    expect(m.getTab('p')!.pinned).toBe(false)
  })

  it('moves tabs across spaces and fixes active tabs on both sides', () => {
    const { m } = setup()
    m.activateTab('b')
    m.moveTab('b', { spaceId: 's2', pinned: false, index: 0 })
    expect(m.getTab('b')!.spaceId).toBe('s2')
    expect(m.getSpace('s2')!.tabIds).toEqual(['b', 'x'])
    // Source space falls back to the neighbour at the same position.
    expect(m.getSpace('s1')!.activeTabId).toBe('c')
    // Target space already had an active tab; it keeps it.
    expect(m.getSpace('s2')!.activeTabId).toBe('x')
  })

  it('cycles tabs and resolves Cmd+N shortcuts', () => {
    const { m } = setup()
    m.activateTab('c')
    expect(m.adjacentTab(1)).toBe('p')
    expect(m.adjacentTab(-1)).toBe('b')
    expect(m.tabAtShortcut(1)).toBe('p')
    expect(m.tabAtShortcut(3)).toBe('b')
    expect(m.tabAtShortcut(9)).toBe('c')
    expect(m.tabAtShortcut(8)).toBeUndefined()
  })

  it('removes a space with its tabs and activates a neighbour', () => {
    const { m } = setup()
    const removed = m.removeSpace('s1')
    expect(removed.map((t) => t.id).sort()).toEqual(['a', 'b', 'c', 'p'])
    expect(m.activeSpaceId).toBe('s2')
    expect(m.tabs.size).toBe(1)
    // The last space cannot be removed.
    expect(m.removeSpace('s2')).toEqual([])
    expect(m.spaces.size).toBe(1)
  })

  it('reorders spaces, keeping unknown ids at the end', () => {
    const { m } = setup()
    m.addSpace(space('s3'))
    m.reorderSpaces(['s3', 's1'])
    expect(m.spaceOrder).toEqual(['s3', 's1', 's2'])
    expect(m.adjacentSpace(1)).toBe('s2')
    expect(m.adjacentSpace(-1)).toBe('s3')
  })

  it('only reports fields that actually changed', () => {
    const { m, events } = setup()
    m.updateTab('a', { title: 'a', loading: true })
    expect(events).toEqual(['tabUpdated:a:loading'])
  })

  it('loads persisted state without events and drops dangling references', () => {
    const { events, listener } = makeListener()
    const m = new BrowserModel(listener)
    const s = { ...space('s1'), activeTabId: 'gone' }
    m.load([s], [tab('a', 's1'), tab('orphan', 'missing')], 'missing')
    expect(events).toEqual([])
    expect(m.getSpace('s1')!.activeTabId).toBeNull()
    expect(m.tabs.has('orphan')).toBe(false)
    expect(m.activeSpaceId).toBe('s1')
  })

  it('emits the final list when reordering inside one section', () => {
    const { m } = makeModelWithPatches()
    m.model.moveTab('a', { spaceId: 's1', pinned: false, index: 2 })
    expect(m.lastSpacePatch.tabIds).toEqual(['b', 'c', 'a'])
  })
})

/** Model that records the last spaces/folders patch payloads. */
function makeModelWithPatches() {
  const { listener } = makeListener()
  const lastSpacePatch: Partial<SpaceData> = {}
  const lastFolderPatch: Record<string, Partial<FolderData>> = {}
  const model = new BrowserModel({
    ...listener,
    spaceUpdated: (_id, p) => Object.assign(lastSpacePatch, p),
    folderUpdated: (id, p) => (lastFolderPatch[id] = { ...lastFolderPatch[id], ...p })
  })
  model.addSpace(space('s1'))
  for (const id of ['a', 'b', 'c']) model.addTab(tab(id, 's1'))
  return { m: { model, lastSpacePatch, lastFolderPatch } }
}

describe('BrowserModel folders', () => {
  function withFolders() {
    const { events, listener } = makeListener()
    const m = new BrowserModel(listener)
    m.addSpace(space('s1'))
    m.addSpace(space('s2'))
    for (const id of ['a', 'b', 'c']) m.addTab(tab(id, 's1'))
    m.addFolder(folder('f1', 's1'))
    m.addFolder(folder('f2', 's1'), 1)
    m.addFolder(folder('g', 's1', 'f1'))
    events.length = 0
    return { m, events }
  }

  it('saves a tab into a folder and takes it out again', () => {
    const { m } = withFolders()
    m.moveTab('b', { spaceId: 's1', pinned: false, folderId: 'f1', index: 0 })
    const b = m.getTab('b')!
    expect(b.folderId).toBe('f1')
    expect(b.savedUrl).toBe('https://b.test/')
    expect(b.savedTitle).toBe('b')
    expect(m.getFolder('f1')!.childIds).toEqual(['b', 'g'])
    expect(m.getSpace('s1')!.tabIds).toEqual(['a', 'c'])
    // Moving between folders keeps the saved page.
    m.updateTab('b', { url: 'https://elsewhere.test/' })
    m.moveTab('b', { spaceId: 's1', pinned: false, folderId: 'g', index: 0 })
    expect(m.getTab('b')!.savedUrl).toBe('https://b.test/')
    // Out of a folder it is an ordinary tab again.
    m.moveTab('b', { spaceId: 's1', pinned: false, index: 0 })
    expect(m.getTab('b')).toMatchObject({ folderId: null, savedUrl: '', savedTitle: '' })
    expect(m.getSpace('s1')!.tabIds).toEqual(['b', 'a', 'c'])
  })

  it('rejects folders of another space', () => {
    const { m, events } = withFolders()
    m.addFolder(folder('other', 's2'))
    events.length = 0
    m.moveTab('a', { spaceId: 's1', pinned: false, folderId: 'other', index: 0 })
    expect(events).toEqual([])
    expect(m.getTab('a')!.folderId).toBeNull()
  })

  it('orders tabs: open tabs, all tabs and visible tabs', () => {
    const { m } = withFolders()
    m.moveTab('b', { spaceId: 's1', pinned: false, folderId: 'g', index: 0 })
    m.moveTab('c', { spaceId: 's1', pinned: false, folderId: 'f2', index: 0 })
    expect(m.orderedTabIds('s1')).toEqual(['a'])
    expect(m.allTabIds('s1')).toEqual(['b', 'c', 'a'])
    m.updateFolder('f1', { collapsed: true })
    expect(m.visibleTabIds('s1')).toEqual(['c', 'a'])
    expect(m.allTabIds('s1')).toEqual(['b', 'c', 'a'])
    // The active tab stays visible under its collapsed folder.
    m.activateTab('b')
    expect(m.visibleTabIds('s1')).toEqual(['b', 'c', 'a'])
  })

  it('a closed folder tab hands over to the most recently used live tab', () => {
    const { m } = withFolders()
    m.moveTab('b', { spaceId: 's1', pinned: false, folderId: 'f1', index: 0 })
    m.updateTab('a', { live: true })
    m.updateTab('c', { live: true })
    m.activateTab('c', 100)
    m.activateTab('a', 200)
    m.activateTab('b', 300)
    m.deactivateTab('b')
    expect(m.getSpace('s1')!.activeTabId).toBe('a')
    expect(m.getTab('b')).toBeDefined()
  })

  it('closing the last open tab does not wake a bookmark', () => {
    const { m } = withFolders()
    m.moveTab('b', { spaceId: 's1', pinned: false, folderId: 'f1', index: 0 })
    m.moveTab('c', { spaceId: 's1', pinned: false, folderId: 'f1', index: 0 })
    m.activateTab('a')
    m.removeTab('a')
    expect(m.getSpace('s1')!.activeTabId).toBeNull()
  })

  it('reorders, nests and refuses to nest a folder into itself', () => {
    const { m } = withFolders()
    m.moveFolder('f2', { parentId: null, index: 0 })
    expect(m.getSpace('s1')!.savedIds).toEqual(['f2', 'f1'])
    m.moveFolder('f2', { parentId: 'g', index: 0 })
    expect(m.getFolder('f2')!.parentId).toBe('g')
    expect(m.getFolder('g')!.childIds).toEqual(['f2'])
    expect(m.getSpace('s1')!.savedIds).toEqual(['f1'])
    // f1 contains g contains f2: none of those may receive f1.
    for (const parentId of ['f1', 'g', 'f2']) m.moveFolder('f1', { parentId, index: 0 })
    expect(m.getFolder('f1')!.parentId).toBeNull()
  })

  it('deletes a folder subtree with its tabs', () => {
    const { m, events } = withFolders()
    m.moveTab('b', { spaceId: 's1', pinned: false, folderId: 'g', index: 0 })
    m.moveTab('c', { spaceId: 's1', pinned: false, folderId: 'f1', index: 0 })
    events.length = 0
    const removed = m.removeFolder('f1')
    expect(removed.map((t) => t.id).sort()).toEqual(['b', 'c'])
    expect(m.getSpace('s1')!.savedIds).toEqual(['f2'])
    expect(m.folders.has('g')).toBe(false)
    expect(events).toContain('folderRemoved:g')
    expect(events).toContain('folderRemoved:f1')
    expect(m.getSpace('s1')!.tabIds).toEqual(['a'])
  })

  it('removing a space removes its folders and folder tabs', () => {
    const { m, events } = withFolders()
    m.moveTab('b', { spaceId: 's1', pinned: false, folderId: 'g', index: 0 })
    m.activateTab('a')
    m.removeSpace('s1')
    expect(m.folders.size).toBe(0)
    expect(m.tabs.has('b')).toBe(false)
    expect(events).toContain('tabRemoved:b')
  })

  it('loads folders: mixed child order, dangling references and cycles', () => {
    const { listener } = makeListener()
    const m = new BrowserModel(listener)
    const order: Record<string, number> = { f1: 0, f2: 1, t1: 1, sub: 0, t2: 2, c1: 5, c2: 6, stray: 9 }
    const t1 = { ...tab('t1', 's1'), folderId: 'f1', savedUrl: 'https://t1.test/', savedTitle: 't1' }
    const t2 = { ...tab('t2', 's1'), folderId: 'f1', pinned: true }
    const stray = { ...tab('stray', 's1'), folderId: 'missing', savedUrl: 'x' }
    m.load(
      [space('s1')],
      [t1, t2, stray],
      's1',
      [folder('f1', 's1'), folder('f2', 's1'), folder('sub', 's1', 'f1'), folder('c1', 's1', 'c2'), folder('c2', 's1', 'c1')],
      (id) => order[id] ?? 0
    )
    expect(m.getFolder('f1')!.childIds).toEqual(['sub', 't1', 't2'])
    expect(m.getTab('t2')!.pinned).toBe(false)
    // Its folder is gone: it stays saved, at the top level.
    expect(m.getTab('stray')).toMatchObject({ folderId: null, savedUrl: 'x' })
    expect(m.getSpace('s1')!.tabIds).toEqual([])
    expect(m.getSpace('s1')!.savedIds).toContain('stray')
    // The c1 <-> c2 cycle is broken: exactly one of them ends up at the top level.
    const top = m.getSpace('s1')!.savedIds
    expect(top.filter((id) => id === 'c1' || id === 'c2')).toHaveLength(1)
    expect(top.slice(0, 2)).toEqual(['f1', 'f2'])
  })

  it('saves tabs at the top level, mixed with folders', () => {
    const { m } = withFolders()
    m.moveTab('a', { spaceId: 's1', pinned: false, saved: true, index: 1 })
    expect(m.getSpace('s1')!.savedIds).toEqual(['f1', 'a', 'f2'])
    expect(m.getTab('a')).toMatchObject({ folderId: null, savedUrl: 'https://a.test/', pinned: false })
    expect(m.getSpace('s1')!.tabIds).toEqual(['b', 'c'])
    expect(m.allTabIds('s1')).toEqual(['a', 'b', 'c'])
    // Into a folder and back out to the top level keeps the saved page.
    m.updateTab('a', { url: 'https://moved.test/' })
    m.moveTab('a', { spaceId: 's1', pinned: false, folderId: 'g', index: 0 })
    m.moveTab('a', { spaceId: 's1', pinned: false, saved: true, index: 0 })
    expect(m.getTab('a')).toMatchObject({ folderId: null, savedUrl: 'https://a.test/' })
    // Unsaving: an ordinary tab again.
    m.moveTab('a', { spaceId: 's1', pinned: false, index: 0 })
    expect(m.getTab('a')).toMatchObject({ folderId: null, savedUrl: '', savedTitle: '' })
    expect(m.getSpace('s1')!.savedIds).toEqual(['f1', 'f2'])
  })

  it('does not auto-select a bookmark added to an empty space', () => {
    const { m } = withFolders()
    m.addTab({ ...tab('saved', 's2'), savedUrl: 'https://saved.test/' })
    expect(m.getSpace('s2')!.savedIds).toEqual(['saved'])
    expect(m.getSpace('s2')!.activeTabId).toBeNull()
  })

  it('favorites are bookmarks: entering them keeps the page, today clears it', () => {
    const { m } = withFolders()
    m.moveTab('a', { spaceId: 's1', pinned: true, index: 0 })
    expect(m.getTab('a')).toMatchObject({ pinned: true, folderId: null, savedUrl: 'https://a.test/' })
    expect(m.getSpace('s1')!.pinnedTabIds).toEqual(['a'])
    // Favorite -> folder keeps the saved page; folder -> favorite too.
    m.updateTab('a', { url: 'https://elsewhere.test/' })
    m.moveTab('a', { spaceId: 's1', pinned: false, folderId: 'f1', index: 0 })
    expect(m.getTab('a')).toMatchObject({ pinned: false, folderId: 'f1', savedUrl: 'https://a.test/' })
    m.moveTab('a', { spaceId: 's1', pinned: true, index: 0 })
    expect(m.getTab('a')).toMatchObject({ pinned: true, folderId: null, savedUrl: 'https://a.test/' })
    // Back to today's list: an ordinary tab.
    m.moveTab('a', { spaceId: 's1', pinned: false, index: 0 })
    expect(m.getTab('a')).toMatchObject({ pinned: false, savedUrl: '' })
    expect(m.getSpace('s1')!.tabIds[0]).toBe('a')
  })

  it('gives favorites stored without a saved page one on load', () => {
    const { listener } = makeListener()
    const m = new BrowserModel(listener)
    m.load([space('s1')], [{ ...tab('fav', 's1', true), url: 'https://fav.test/', title: 'Fav' }], 's1')
    expect(m.getTab('fav')).toMatchObject({ pinned: true, savedUrl: 'https://fav.test/', savedTitle: 'Fav' })
    expect(m.getSpace('s1')!.pinnedTabIds).toEqual(['fav'])
    expect(m.getSpace('s1')!.savedIds).toEqual([])
  })
})
