import { create } from 'zustand'
import { DEFAULT_SETTINGS, DEFAULT_WINDOW_STATE } from '@shared/defaults'
import { applyPatch, type ShellState } from '@shared/patch'
import { isSavedTab } from '@shared/tabs'
import type { MoveFolderOptions, MoveTabOptions } from '@shared/ipc'
import type { FolderId, FolderState, PageDialog, SpaceId, SpaceState, StatePatch, TabId, TabState } from '@shared/types'

/** Mirror of main-process state. Mutated only by patches (and optimistic moves). */
export const useBrowser = create<ShellState>()(() => ({
  tabs: {},
  spaces: {},
  folders: {},
  spaceOrder: [],
  window: { ...DEFAULT_WINDOW_STATE, activeSpaceId: '' },
  settings: DEFAULT_SETTINGS,
  extensions: [],
  extensionPartition: '',
  downloads: {},
  permissionPrompts: [],
  pageDialogs: [],
  find: null,
  isDev: false
}))

export function initBrowserState(snapshot: ShellState): void {
  useBrowser.setState(snapshot, true)
}

export function receivePatch(patch: StatePatch): void {
  useBrowser.setState((s) => applyPatch(s, patch))
}

// -- selectors -----------------------------------------------------------------

export const selectActiveSpace = (s: ShellState): SpaceState | undefined => s.spaces[s.window.activeSpaceId]

export const selectActiveTab = (s: ShellState): TabState | undefined => {
  const space = s.spaces[s.window.activeSpaceId]
  return space?.activeTabId ? s.tabs[space.activeTabId] : undefined
}

export function getActiveTab(): TabState | undefined {
  return selectActiveTab(useBrowser.getState())
}

/** The alert / confirm / prompt the page on screen is waiting on, if any. */
export const selectActiveDialog = (s: ShellState): PageDialog | null => {
  const tab = selectActiveTab(s)
  return (tab && s.pageDialogs.find((d) => d.tabId === tab.id)) ?? null
}

/**
 * Apply a tab move locally before main confirms it, so drag-and-drop never
 * shows a frame of the old order. Main's patch then lands with the same data.
 * Targets: a folder (`folderId`, index in its childIds), the top level of the
 * saved list (`saved`, index in savedIds), else the pinned tiles or today's
 * list. Like main, entering the saved list records savedUrl / savedTitle and
 * leaving it clears them.
 */
export function optimisticMove(tabId: TabId, target: MoveTabOptions): void {
  useBrowser.setState((s) => {
    const tab = s.tabs[tabId]
    const from = tab && s.spaces[tab.spaceId]
    const to = s.spaces[target.spaceId]
    const intoFolder = target.folderId ? s.folders[target.folderId] : undefined
    if (!tab || !from || !to || (target.folderId && intoFolder?.spaceId !== to.id)) return {}

    const spaces = { ...s.spaces }
    const folders = { ...s.folders }
    // Take the tab out of wherever it is now.
    const oldFolder = tab.folderId ? folders[tab.folderId] : undefined
    if (oldFolder) folders[oldFolder.id] = { ...oldFolder, childIds: oldFolder.childIds.filter((id) => id !== tabId) }
    const strip = (list: TabId[]) => (list.includes(tabId) ? list.filter((id) => id !== tabId) : list)
    spaces[from.id] = { ...from, savedIds: strip(from.savedIds), pinnedTabIds: strip(from.pinnedTabIds), tabIds: strip(from.tabIds) }

    const toSpace = spaces[to.id]!
    if (intoFolder) {
      const current = folders[intoFolder.id]!
      folders[intoFolder.id] = { ...current, childIds: insertAt(current.childIds, target.index, tabId) }
    } else {
      const key = target.saved ? 'savedIds' : target.pinned ? 'pinnedTabIds' : 'tabIds'
      spaces[to.id] = { ...toSpace, [key]: insertAt(toSpace[key], target.index, tabId) }
    }

    const folderId = intoFolder ? intoFolder.id : null
    // As in main: favorites, the saved list and folders are bookmarks; today's list is not.
    const pinned = !intoFolder && !target.saved && target.pinned
    const savedNow = folderId !== null || target.saved === true || pinned
    const wasSaved = isSavedTab(tab)
    const saved =
      savedNow && !wasSaved
        ? { savedUrl: tab.url, savedTitle: tab.title }
        : !savedNow && wasSaved
          ? { savedUrl: '', savedTitle: '' }
          : {}
    return {
      spaces,
      folders: oldFolder || intoFolder ? folders : s.folders,
      tabs: {
        ...s.tabs,
        [tabId]: { ...tab, ...saved, spaceId: to.id, pinned, folderId }
      }
    }
  })
}

/** Local counterpart of `folders.move` (same space; `index` counted after removal). */
export function optimisticFolderMove(folderId: FolderId, target: MoveFolderOptions): void {
  useBrowser.setState((s) => {
    const folder = s.folders[folderId]
    const space = folder && s.spaces[folder.spaceId]
    const parent = target.parentId ? s.folders[target.parentId] : undefined
    if (!folder || !space || (target.parentId && parent?.spaceId !== space.id)) return {}
    const folders = { ...s.folders }
    let savedIds = space.savedIds
    if (folder.parentId) {
      const old = folders[folder.parentId]
      if (old) folders[old.id] = { ...old, childIds: old.childIds.filter((id) => id !== folderId) }
    } else {
      savedIds = savedIds.filter((id) => id !== folderId)
    }
    if (parent) {
      const current = folders[parent.id]!
      folders[parent.id] = { ...current, childIds: insertAt(current.childIds, target.index, folderId) }
    } else {
      savedIds = insertAt(savedIds, target.index, folderId)
    }
    folders[folderId] = { ...folder, parentId: parent ? parent.id : null }
    const spaces = savedIds === space.savedIds ? s.spaces : { ...s.spaces, [space.id]: { ...space, savedIds } }
    return { folders, spaces }
  })
}

/** Optimistic field update for a folder (collapse state, name). */
export function optimisticFolder(folderId: FolderId, patch: Partial<Pick<FolderState, 'collapsed' | 'name'>>): void {
  useBrowser.setState((s) => {
    const folder = s.folders[folderId]
    return folder ? { folders: { ...s.folders, [folderId]: { ...folder, ...patch } } } : {}
  })
}

/** Space edits land locally first, so closing the editor never flashes the old theme. */
export function optimisticSpace(spaceId: SpaceId, patch: Partial<Pick<SpaceState, 'name' | 'icon' | 'color' | 'theme'>>): void {
  useBrowser.setState((s) => {
    const space = s.spaces[spaceId]
    return space ? { spaces: { ...s.spaces, [spaceId]: { ...space, ...patch } } } : {}
  })
}

function insertAt<T>(list: readonly T[], index: number, item: T): T[] {
  const i = Math.max(0, Math.min(list.length, index))
  return [...list.slice(0, i), item, ...list.slice(i)]
}

/** True when `folderId` is `ancestorId` or nested (at any depth) inside it. */
export function isWithinFolder(folders: ShellState['folders'], folderId: FolderId | null, ancestorId: FolderId): boolean {
  for (let id = folderId, guard = 0; id && guard < 256; guard++) {
    if (id === ancestorId) return true
    id = folders[id]?.parentId ?? null
  }
  return false
}
