import { isSavedTab } from '@shared/tabs'
import type { FolderId, FolderState, SpaceId, SpaceState, TabId, TabState } from '@shared/types'
import type { NavState } from '../persistence/records'

// Pure browser model: spaces, folders, tab ordering and activation rules. It
// knows nothing about Electron so it can be unit tested; TabManager mirrors its
// changes onto WebContentsViews, the shell and the database.

export interface TabData extends TabState {
  createdAt: number
  /** Back/forward stack captured when the tab was last unloaded or saved. */
  navState: NavState | null
}

export interface SpaceData extends SpaceState {
  createdAt: number
}

export interface FolderData extends FolderState {
  createdAt: number
}

export interface ModelListener {
  tabAdded(tab: TabData): void
  tabUpdated(id: TabId, patch: Partial<TabData>): void
  tabRemoved(tab: TabData): void
  spaceAdded(space: SpaceData): void
  spaceUpdated(id: SpaceId, patch: Partial<SpaceData>): void
  spaceRemoved(id: SpaceId): void
  spaceOrderChanged(order: SpaceId[]): void
  activeSpaceChanged(id: SpaceId): void
  folderAdded(folder: FolderData): void
  folderUpdated(id: FolderId, patch: Partial<FolderData>): void
  folderRemoved(folder: FolderData): void
}

export interface MoveTarget {
  spaceId: SpaceId
  pinned: boolean
  /** Save into this folder (it must belong to `spaceId`); `index` then counts in its children. */
  folderId?: FolderId | null
  /** Without `folderId`: save at the top level of the saved list (`index` counts in `savedIds`). */
  saved?: boolean
  /** Position in the target list, counted after the tab was taken out. */
  index: number
}

export interface FolderMoveTarget {
  /** New parent in the same space; null = top level. */
  parentId: FolderId | null
  /** Position among the parent's children, counted after the folder was taken out. */
  index: number
}

/** A list holding sidebar items: a section of a space, or a folder's children. */
type Slot =
  | { space: SpaceData; key: 'pinnedTabIds' | 'tabIds' | 'savedIds'; folder?: undefined }
  | { folder: FolderData; space?: undefined }

export class BrowserModel {
  readonly tabs = new Map<TabId, TabData>()
  readonly spaces = new Map<SpaceId, SpaceData>()
  readonly folders = new Map<FolderId, FolderData>()
  spaceOrder: SpaceId[] = []
  activeSpaceId: SpaceId = ''

  constructor(private readonly listener: ModelListener) {}

  /**
   * Replace the whole state without emitting events (used on startup).
   * `sortOrder` positions folder children, which mix tabs and folders.
   */
  load(
    spaces: SpaceData[],
    tabs: TabData[],
    activeSpaceId: SpaceId | null,
    folders: FolderData[] = [],
    sortOrder: (id: string) => number = () => 0
  ): void {
    this.tabs.clear()
    this.spaces.clear()
    this.folders.clear()
    for (const s of spaces) this.spaces.set(s.id, { ...s, pinnedTabIds: [], savedIds: [], tabIds: [] })
    this.spaceOrder = spaces.map((s) => s.id)

    for (const f of folders) {
      if (this.spaces.has(f.spaceId)) this.folders.set(f.id, { ...f, childIds: [] })
    }
    for (const f of this.folders.values()) {
      const parent = f.parentId ? this.folders.get(f.parentId) : undefined
      if (!parent || parent.spaceId !== f.spaceId) f.parentId = null
    }
    // Break parent cycles (corrupt data) by lifting a member to the top level.
    for (const f of this.folders.values()) {
      const seen = new Set<FolderId>()
      for (let cur = f.parentId; cur; cur = this.folders.get(cur)?.parentId ?? null) {
        if (cur === f.id) {
          f.parentId = null
          break
        }
        if (seen.has(cur)) break
        seen.add(cur)
      }
    }

    const children = new Map<string, string[]>()
    const childList = (key: string) => children.get(key) ?? (children.set(key, []), children.get(key)!)
    for (const f of this.folders.values()) childList(f.parentId ?? `space:${f.spaceId}`).push(f.id)
    for (const t of tabs) {
      const space = this.spaces.get(t.spaceId)
      if (!space) continue
      // A tab whose folder is gone stays saved, at the top level.
      if (t.folderId && this.folders.get(t.folderId)?.spaceId !== t.spaceId) t.folderId = null
      if (t.folderId) t.pinned = false
      // Favorites saved before they were bookmarks: their page is the saved one.
      if (t.pinned && !t.savedUrl) Object.assign(t, { savedUrl: t.url, savedTitle: t.title })
      this.tabs.set(t.id, t)
      if (t.pinned) space.pinnedTabIds.push(t.id)
      else if (isSavedTab(t)) childList(t.folderId ?? `space:${t.spaceId}`).push(t.id)
      else space.tabIds.push(t.id)
    }
    const byOrder = (a: string, b: string) => sortOrder(a) - sortOrder(b)
    for (const [key, ids] of children) {
      ids.sort(byOrder)
      if (key.startsWith('space:')) this.spaces.get(key.slice(6))!.savedIds = ids
      else this.folders.get(key)!.childIds = ids
    }

    for (const s of this.spaces.values()) {
      if (s.activeTabId && !this.tabs.has(s.activeTabId)) s.activeTabId = null
    }
    this.activeSpaceId =
      activeSpaceId && this.spaces.has(activeSpaceId) ? activeSpaceId : (this.spaceOrder[0] ?? '')
  }

  // -- queries ---------------------------------------------------------------

  getTab(id: TabId): TabData | undefined {
    return this.tabs.get(id)
  }

  getSpace(id: SpaceId): SpaceData | undefined {
    return this.spaces.get(id)
  }

  getFolder(id: FolderId): FolderData | undefined {
    return this.folders.get(id)
  }

  activeSpace(): SpaceData | undefined {
    return this.spaces.get(this.activeSpaceId)
  }

  /** Active tab of the active space. */
  activeTab(): TabData | undefined {
    const space = this.activeSpace()
    return space?.activeTabId ? this.tabs.get(space.activeTabId) : undefined
  }

  /** Open tabs of a space: pinned section first, then regular tabs (no folder tabs). */
  orderedTabIds(spaceId: SpaceId): TabId[] {
    const space = this.spaces.get(spaceId)
    return space ? [...space.pinnedTabIds, ...space.tabIds] : []
  }

  /**
   * Saved tabs of a space (top level and folders), top to bottom. `visibleOnly`
   * skips collapsed folders, except for the active tab, which stays shown under them.
   */
  savedTabIds(spaceId: SpaceId, visibleOnly = false): TabId[] {
    const space = this.spaces.get(spaceId)
    const out: TabId[] = []
    const walk = (ids: readonly string[]) => {
      for (const id of ids) {
        const folder = this.folders.get(id)
        if (!folder) out.push(id)
        else if (!visibleOnly || !folder.collapsed) walk(folder.childIds)
        else if (space?.activeTabId && this.folderSubtree(id).tabs.includes(space.activeTabId)) out.push(space.activeTabId)
      }
    }
    if (space) walk(space.savedIds)
    return out
  }

  /** Every tab of a space in sidebar order. */
  allTabIds(spaceId: SpaceId): TabId[] {
    const space = this.spaces.get(spaceId)
    return space ? [...space.pinnedTabIds, ...this.savedTabIds(spaceId), ...space.tabIds] : []
  }

  /** What the user sees top to bottom; tab cycling and Cmd+N follow it. */
  visibleTabIds(spaceId: SpaceId): TabId[] {
    const space = this.spaces.get(spaceId)
    return space ? [...space.pinnedTabIds, ...this.savedTabIds(spaceId, true), ...space.tabIds] : []
  }

  /** A folder and everything below it (depth first, the folder itself first). */
  folderSubtree(id: FolderId): { folders: FolderId[]; tabs: TabId[] } {
    const folders: FolderId[] = []
    const tabs: TabId[] = []
    const walk = (folderId: FolderId) => {
      const folder = this.folders.get(folderId)
      if (!folder) return
      folders.push(folderId)
      for (const child of folder.childIds) {
        if (this.folders.has(child)) walk(child)
        else tabs.push(child)
      }
    }
    walk(id)
    return { folders, tabs }
  }

  /** Persisted sort order: position inside its section or folder. */
  sortOrderOf(tab: TabData): number {
    return this.read(this.slotOfTab(tab)).indexOf(tab.id)
  }

  sortOrderOfFolder(folder: FolderData): number {
    return this.read(this.slotOfFolder(folder)).indexOf(folder.id)
  }

  // -- spaces ----------------------------------------------------------------

  addSpace(space: SpaceData, index = this.spaceOrder.length): void {
    const record: SpaceData = { ...space, pinnedTabIds: [], savedIds: [], tabIds: [], activeTabId: null }
    this.spaces.set(record.id, record)
    this.spaceOrder = insertAt(this.spaceOrder, record.id, index)
    this.listener.spaceAdded(record)
    this.listener.spaceOrderChanged(this.spaceOrder)
    if (!this.activeSpaceId) this.setActiveSpace(record.id)
  }

  updateSpace(id: SpaceId, patch: Partial<Pick<SpaceData, 'name' | 'icon' | 'color' | 'theme'>>): void {
    const space = this.spaces.get(id)
    if (!space) return
    Object.assign(space, patch)
    this.listener.spaceUpdated(id, patch)
  }

  /** Removes a space with every tab and folder in it. Returns the removed tabs. */
  removeSpace(id: SpaceId): TabData[] {
    const space = this.spaces.get(id)
    if (!space || this.spaces.size <= 1) return []
    const removed: TabData[] = []
    for (const tabId of this.allTabIds(id)) {
      const tab = this.tabs.get(tabId)
      if (!tab) continue
      this.tabs.delete(tabId)
      removed.push(tab)
      this.listener.tabRemoved(tab)
    }
    for (const folder of [...this.folders.values()]) {
      if (folder.spaceId !== id) continue
      this.folders.delete(folder.id)
      this.listener.folderRemoved(folder)
    }
    const position = this.spaceOrder.indexOf(id)
    this.spaces.delete(id)
    this.spaceOrder = this.spaceOrder.filter((s) => s !== id)
    this.listener.spaceRemoved(id)
    this.listener.spaceOrderChanged(this.spaceOrder)
    if (this.activeSpaceId === id) {
      this.setActiveSpace(this.spaceOrder[Math.min(position, this.spaceOrder.length - 1)]!)
    }
    return removed
  }

  reorderSpaces(order: SpaceId[]): void {
    const known = new Set(this.spaceOrder)
    const next = order.filter((id) => known.delete(id))
    // Ids the caller did not mention keep their relative order at the end.
    next.push(...this.spaceOrder.filter((id) => known.has(id)))
    if (sameArray(next, this.spaceOrder)) return
    this.spaceOrder = next
    this.listener.spaceOrderChanged(next)
  }

  setActiveSpace(id: SpaceId): void {
    if (!this.spaces.has(id) || this.activeSpaceId === id) return
    this.activeSpaceId = id
    this.listener.activeSpaceChanged(id)
  }

  /** Neighbouring space in display order (wraps around). */
  adjacentSpace(direction: 1 | -1): SpaceId | undefined {
    const n = this.spaceOrder.length
    if (n === 0) return undefined
    const i = this.spaceOrder.indexOf(this.activeSpaceId)
    return this.spaceOrder[(i + direction + n) % n]
  }

  // -- tabs ------------------------------------------------------------------

  /** `select: false` never makes the tab its space's active tab (imports). */
  addTab(tab: TabData, opts: { index?: number; activate?: boolean; select?: boolean } = {}): void {
    const space = this.spaces.get(tab.spaceId)
    if (!space) throw new Error(`Unknown space ${tab.spaceId}`)
    if (tab.folderId && this.folders.get(tab.folderId)?.spaceId !== space.id) tab.folderId = null
    if (tab.folderId) tab.pinned = false
    if (tab.pinned && !tab.savedUrl) Object.assign(tab, { savedUrl: tab.url, savedTitle: tab.title })
    this.tabs.set(tab.id, tab)
    const slot = this.slotOfTab(tab)
    const list = this.read(slot)
    this.write(slot, insertAt(list, tab.id, opts.index ?? list.length), false)
    this.listener.tabAdded(tab)
    this.emit(slot)
    if (opts.activate) {
      this.activateTab(tab.id)
    } else if (opts.select !== false && !space.activeTabId && !isSavedTab(tab)) {
      // First tab of a background space: select it there without switching
      // (bookmarks never select themselves).
      space.activeTabId = tab.id
      this.listener.spaceUpdated(space.id, { activeTabId: tab.id })
    }
  }

  updateTab(id: TabId, patch: Partial<TabData>): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    let changed: Partial<TabData> | null = null
    for (const key in patch) {
      const k = key as keyof TabData
      if (tab[k] !== patch[k]) {
        ;(changed ??= {} as Partial<TabData>)[k] = patch[k] as never
        ;(tab as unknown as Record<string, unknown>)[k] = patch[k]
      }
    }
    if (changed) this.listener.tabUpdated(id, changed)
  }

  /** Make `id` the active tab of its space and switch to that space. */
  activateTab(id: TabId, now = Date.now()): void {
    const tab = this.tabs.get(id)
    if (!tab) return
    const space = this.spaces.get(tab.spaceId)!
    if (space.activeTabId !== id) {
      space.activeTabId = id
      this.listener.spaceUpdated(space.id, { activeTabId: id })
    }
    this.updateTab(id, { lastActiveAt: now })
    this.setActiveSpace(space.id)
  }

  /** If `id` is its space's active tab, hand activation to the next candidate. */
  deactivateTab(id: TabId): void {
    const tab = this.tabs.get(id)
    const space = tab && this.spaces.get(tab.spaceId)
    if (!tab || !space || space.activeTabId !== id) return
    this.setActiveTab(space, this.successor(tab))
  }

  /** Removes a tab, picking a new active tab for its space when needed. */
  removeTab(id: TabId): TabData | undefined {
    const tab = this.tabs.get(id)
    if (!tab) return undefined
    const space = this.spaces.get(tab.spaceId)!
    const next = space.activeTabId === id ? this.successor(tab) : undefined
    const slot = this.slotOfTab(tab)
    this.write(
      slot,
      this.read(slot).filter((t) => t !== id),
      false
    )
    this.tabs.delete(id)
    this.listener.tabRemoved(tab)
    this.emit(slot)
    if (next !== undefined) this.setActiveTab(space, next)
    return tab
  }

  /** Reorder, pin/unpin, save (top level or folder) or unsave, or move to another space. */
  moveTab(id: TabId, target: MoveTarget): void {
    const tab = this.tabs.get(id)
    const to = this.spaces.get(target.spaceId)
    if (!tab || !to) return
    const folder = target.folderId ? this.folders.get(target.folderId) : undefined
    if (target.folderId && folder?.spaceId !== to.id) return
    const from = this.spaces.get(tab.spaceId)!

    const fromSlot = this.slotOfTab(tab)
    // Everywhere but today's list is a bookmark: favorites, the saved list, folders.
    const toSaved = !folder && target.saved === true
    const toPinned = !folder && !toSaved && target.pinned
    const saving = !!folder || toSaved || toPinned
    const toSlot: Slot = folder
      ? { folder }
      : { space: to, key: toSaved ? 'savedIds' : toPinned ? 'pinnedTabIds' : 'tabIds' }
    const same = sameSlot(fromSlot, toSlot)
    const before = this.read(fromSlot)
    const fromList = before.filter((t) => t !== id)
    const toList = insertAt(same ? fromList : this.read(toSlot), id, target.index)
    if (same && sameArray(toList, before)) return

    const successor = from !== to && from.activeTabId === id ? this.successor(tab) : undefined
    if (same) {
      this.write(fromSlot, toList)
    } else {
      this.write(fromSlot, fromList)
      this.write(toSlot, toList)
    }

    const patch: Partial<TabData> = { spaceId: to.id, pinned: toPinned, folderId: folder?.id ?? null }
    if (!saving) Object.assign(patch, { savedUrl: '', savedTitle: '' })
    else if (!isSavedTab(tab)) Object.assign(patch, { savedUrl: tab.url, savedTitle: tab.title })
    this.updateTab(id, patch)

    if (successor !== undefined) this.setActiveTab(from, successor)
    if (from !== to && !to.activeTabId) this.setActiveTab(to, id)
  }

  /** Next/previous visible tab in the active space, wrapping around. */
  adjacentTab(direction: 1 | -1): TabId | undefined {
    const space = this.activeSpace()
    if (!space) return undefined
    const order = this.visibleTabIds(space.id)
    if (order.length === 0) return undefined
    const i = space.activeTabId ? order.indexOf(space.activeTabId) : -1
    return order[(i + direction + order.length) % order.length]
  }

  /** Cmd+1…8 select the n-th visible tab; Cmd+9 always selects the last one. */
  tabAtShortcut(n: number): TabId | undefined {
    const space = this.activeSpace()
    if (!space) return undefined
    const order = this.visibleTabIds(space.id)
    return n >= 9 ? order[order.length - 1] : order[n - 1]
  }

  // -- folders -----------------------------------------------------------------

  /** Insert a folder (top level or inside `parentId`) at `index` among its siblings. */
  addFolder(folder: FolderData, index = 0): void {
    const space = this.spaces.get(folder.spaceId)
    if (!space) return
    const parent = folder.parentId ? this.folders.get(folder.parentId) : undefined
    const record: FolderData = { ...folder, parentId: parent?.spaceId === space.id ? parent.id : null, childIds: [] }
    this.folders.set(record.id, record)
    this.listener.folderAdded(record)
    const slot = this.slotOfFolder(record)
    this.write(slot, insertAt(this.read(slot), record.id, index))
  }

  updateFolder(id: FolderId, patch: Partial<Pick<FolderData, 'name' | 'collapsed'>>): void {
    const folder = this.folders.get(id)
    if (!folder) return
    const changed: Partial<FolderData> = {}
    if (patch.name !== undefined && patch.name !== folder.name) changed.name = folder.name = patch.name
    if (patch.collapsed !== undefined && patch.collapsed !== folder.collapsed) {
      changed.collapsed = folder.collapsed = patch.collapsed
    }
    if (Object.keys(changed).length > 0) this.listener.folderUpdated(id, changed)
  }

  /** Reorder or re-parent a folder within its space (never into its own subtree). */
  moveFolder(id: FolderId, target: FolderMoveTarget): void {
    const folder = this.folders.get(id)
    if (!folder) return
    const parent = target.parentId ? this.folders.get(target.parentId) : undefined
    if (target.parentId && parent?.spaceId !== folder.spaceId) return
    if (parent && this.folderSubtree(id).folders.includes(parent.id)) return

    const fromSlot = this.slotOfFolder(folder)
    const toSlot: Slot = parent ? { folder: parent } : { space: this.spaces.get(folder.spaceId)!, key: 'savedIds' }
    const same = sameSlot(fromSlot, toSlot)
    const before = this.read(fromSlot)
    const fromList = before.filter((f) => f !== id)
    const toList = insertAt(same ? fromList : this.read(toSlot), id, target.index)
    if (same && sameArray(toList, before)) return
    if (same) {
      this.write(fromSlot, toList)
    } else {
      this.write(fromSlot, fromList)
      this.write(toSlot, toList)
      folder.parentId = parent?.id ?? null
      this.listener.folderUpdated(id, { parentId: folder.parentId })
    }
  }

  /** Removes a folder, its sub-folders and the tabs saved in them. Returns the removed tabs. */
  removeFolder(id: FolderId): TabData[] {
    const folder = this.folders.get(id)
    if (!folder) return []
    const { folders, tabs } = this.folderSubtree(id)
    const slot = this.slotOfFolder(folder)
    this.write(
      slot,
      this.read(slot).filter((f) => f !== id)
    )
    const removed: TabData[] = []
    for (const tabId of tabs) {
      const tab = this.removeTab(tabId)
      if (tab) removed.push(tab)
    }
    for (const folderId of folders.reverse()) {
      const doomed = this.folders.get(folderId)
      if (!doomed) continue
      this.folders.delete(folderId)
      this.listener.folderRemoved(doomed)
    }
    return removed
  }

  // -- internals ---------------------------------------------------------------

  private slotOfTab(tab: TabData): Slot {
    const folder = tab.folderId ? this.folders.get(tab.folderId) : undefined
    if (folder) return { folder }
    const space = this.spaces.get(tab.spaceId)
    if (!space) throw new Error(`Unknown space ${tab.spaceId}`)
    return { space, key: tab.pinned ? 'pinnedTabIds' : isSavedTab(tab) ? 'savedIds' : 'tabIds' }
  }

  private slotOfFolder(folder: FolderData): Slot {
    const parent = folder.parentId ? this.folders.get(folder.parentId) : undefined
    return parent ? { folder: parent } : { space: this.spaces.get(folder.spaceId)!, key: 'savedIds' }
  }

  private read(slot: Slot): string[] {
    return slot.folder ? slot.folder.childIds : slot.space[slot.key]
  }

  private write(slot: Slot, list: string[], emit = true): void {
    if (slot.folder) slot.folder.childIds = list
    else slot.space[slot.key] = list
    if (emit) this.emit(slot)
  }

  private emit(slot: Slot): void {
    if (slot.folder) this.listener.folderUpdated(slot.folder.id, { childIds: slot.folder.childIds })
    else this.listener.spaceUpdated(slot.space.id, { [slot.key]: slot.space[slot.key] })
  }

  private setActiveTab(space: SpaceData, id: TabId | null): void {
    if (space.activeTabId === id) return
    space.activeTabId = id
    this.listener.spaceUpdated(space.id, { activeTabId: id })
    if (id) this.updateTab(id, { lastActiveAt: Date.now() })
  }

  /**
   * Who takes over when `tab` stops being active. Open tabs hand over to their
   * open neighbour (next, then previous); the last one leaves the space empty.
   * Saved tabs are bookmarks: they go back to the most recently used live tab.
   * Neither ever wakes a bookmark (favorites included).
   */
  private successor(tab: TabData): TabId | null {
    const space = this.spaces.get(tab.spaceId)!
    const open = space.tabIds.filter((t) => t !== tab.id)
    if (!isSavedTab(tab)) {
      const position = space.tabIds.indexOf(tab.id)
      return open[Math.min(position, open.length - 1)] ?? null
    }
    let best: TabData | undefined
    for (const id of this.allTabIds(space.id)) {
      const t = this.tabs.get(id)
      if (t && id !== tab.id && t.live && (!best || t.lastActiveAt > best.lastActiveAt)) best = t
    }
    return best?.id ?? open[0] ?? null
  }
}

export function insertAt<T>(list: readonly T[], item: T, index: number): T[] {
  const i = Math.max(0, Math.min(list.length, Math.trunc(index)))
  return [...list.slice(0, i), item, ...list.slice(i)]
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function sameSlot(a: Slot, b: Slot): boolean {
  return a.folder ? a.folder === b.folder : !b.folder && a.space === b.space && a.key === b.key
}
