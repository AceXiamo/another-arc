import type { MoveFolderOptions, MoveTabOptions } from '@shared/ipc'
import type { FolderId, SpaceId } from '@shared/types'
import type { ShellState } from '@shared/patch'
import { send } from '../../lib/rpc'
import { isWithinFolder, optimisticFolderMove, optimisticMove, useBrowser } from '../../stores/browser'
import { useUi, type DragItem, type DragState, type DropTarget } from '../../stores/ui'

const THRESHOLD = 5
/** Band at the top / bottom of the tab list that scrolls it while dragging. */
const SCROLL_EDGE = 32
const SCROLL_STEP = 14
/** Share of a folder row's height, at its top and bottom, that drops beside it instead of into it. */
const FOLDER_EDGE = 0.25

/** Folder tree indentation. */
export const TREE_INDENT = 16
const MAX_TREE_DEPTH = 6
/** Left inset (px) of a tree row's content at `depth`. Deep trees stop indenting. */
export function treeInset(depth: number): number {
  return 10 + Math.min(depth, MAX_TREE_DEPTH) * TREE_INDENT
}

// -- where things are ------------------------------------------------------------
//
// Every drop position is "list + index". Lists are named by string keys so the
// item's current place and the target can be compared directly:
//   pinned:<spaceId>, tabs:<spaceId>   pinned tiles / today's tabs
//   top:<spaceId>                      top level of a space's saved list (folders and saved tabs)
//   <folderId>                         children of a folder

interface Place {
  list: string
  index: number
}

function placeOf(item: DragItem, s: ShellState): Place | null {
  if (item.kind === 'tab') {
    const tab = s.tabs[item.id]
    if (!tab) return null
    if (tab.folderId) return { list: tab.folderId, index: s.folders[tab.folderId]?.childIds.indexOf(item.id) ?? -1 }
    const space = s.spaces[tab.spaceId]
    if (!space) return null
    const saved = space.savedIds.indexOf(item.id)
    if (saved >= 0) return { list: `top:${space.id}`, index: saved }
    return tab.pinned
      ? { list: `pinned:${space.id}`, index: space.pinnedTabIds.indexOf(item.id) }
      : { list: `tabs:${space.id}`, index: space.tabIds.indexOf(item.id) }
  }
  const folder = s.folders[item.id]
  if (!folder) return null
  if (folder.parentId) return { list: folder.parentId, index: s.folders[folder.parentId]?.childIds.indexOf(item.id) ?? -1 }
  return { list: `top:${folder.spaceId}`, index: s.spaces[folder.spaceId]?.savedIds.indexOf(item.id) ?? -1 }
}

function listOf(target: Exclude<DropTarget, { kind: 'space' }>): string {
  switch (target.kind) {
    case 'section':
      return `${target.pinned ? 'pinned' : 'tabs'}:${target.spaceId}`
    case 'child':
      return target.parentId ?? `top:${target.spaceId}`
    case 'into':
      return target.folderId
  }
}

/** Convert a rendered position into the post-removal index the RPCs expect. */
function postRemoval(own: Place | null, list: string, displayIndex: number): number {
  return own && own.list === list && own.index >= 0 && own.index < displayIndex ? displayIndex - 1 : displayIndex
}

// -- hit testing ------------------------------------------------------------------

/** Resolve the drop target under the pointer from data attributes. */
function hitTest(x: number, y: number, item: DragItem): DropTarget | null {
  const el = document.elementFromPoint(x, y)
  if (!el) return null
  const spaceButton = el.closest<HTMLElement>('[data-space-drop]')
  if (spaceButton) return item.kind === 'tab' ? { kind: 'space', spaceId: spaceButton.dataset.spaceDrop! } : null
  const section = el.closest<HTMLElement>('[data-tab-section]')
  if (!section) return null
  const spaceId = section.dataset.spaceId!
  const s = useBrowser.getState()
  if (section.dataset.tabSection === 'folders') return hitTree(section, y, item, spaceId, s)
  // Only the folder area accepts folders.
  if (item.kind !== 'tab') return null
  return hitList(section, x, y, item, spaceId, s)
}

/** Pinned tiles (a grid) or today's list. */
function hitList(section: HTMLElement, x: number, y: number, item: DragItem, spaceId: SpaceId, s: ShellState): DropTarget {
  const pinned = section.dataset.tabSection === 'pinned'
  const items = section.querySelectorAll<HTMLElement>('[data-tab-id]')
  let displayIndex = items.length
  for (let i = 0; i < items.length; i++) {
    const r = items[i]!.getBoundingClientRect()
    const before = pinned ? y < r.top || (y <= r.bottom && x < r.left + r.width / 2) : y < r.top + r.height / 2
    if (before) {
      displayIndex = i
      break
    }
  }
  const target = { kind: 'section', spaceId, pinned, index: displayIndex, displayIndex } as const
  return { ...target, index: postRemoval(placeOf(item, s), listOf(target), displayIndex) }
}

function childTarget(spaceId: SpaceId, parentId: FolderId | null, displayIndex: number, own: Place | null): DropTarget {
  const target = { kind: 'child', spaceId, parentId, index: displayIndex, displayIndex } as const
  return { ...target, index: postRemoval(own, listOf(target), displayIndex) }
}

/**
 * The saved list (top-level saved tabs and the folder tree). Rows are stacked
 * full-width, so only `y` matters:
 * - tab row: upper half drops before it, lower half after it (same parent);
 * - folder row: the top quarter drops before it, the bottom quarter after it
 *   (or before its first child when it is open), the middle appends into it;
 * - the empty-folder hint drops into its folder;
 * - below the last row (the separator gap): folders go to the end of the top
 *   level, tabs to the start of today's list.
 * A folder never lands inside itself or its descendants.
 */
function hitTree(section: HTMLElement, y: number, item: DragItem, spaceId: SpaceId, s: ShellState): DropTarget | null {
  let row: HTMLElement | null = null
  let rect: DOMRect | null = null
  for (const r of section.querySelectorAll<HTMLElement>('[data-tree-row]')) {
    const b = r.getBoundingClientRect()
    if (y < b.bottom) {
      row = r
      rect = b
      break
    }
  }
  const own = placeOf(item, s)
  if (!row || !rect) {
    if (item.kind === 'folder') return childTarget(spaceId, null, s.spaces[spaceId]?.savedIds.length ?? 0, own)
    return { kind: 'section', spaceId, pinned: false, index: 0, displayIndex: 0 }
  }

  const kind = row.dataset.treeRow as 'folder' | 'tab' | 'empty'
  const id = row.dataset.id!
  const parentId = row.dataset.parent || null
  const index = Number(row.dataset.index)
  if (item.kind === 'folder' && isWithinFolder(s.folders, kind === 'tab' ? parentId : id, item.id)) return null

  const into = (folderId: FolderId): DropTarget | null => {
    const folder = s.folders[folderId]
    if (!folder) return null
    const n = folder.childIds.length
    return { kind: 'into', spaceId, folderId, index: own?.list === folderId ? n - 1 : n }
  }
  if (kind === 'empty') return into(id)
  if (kind === 'tab') {
    const before = y < rect.top + rect.height / 2
    return childTarget(spaceId, parentId, before ? index : index + 1, own)
  }

  const folder = s.folders[id]
  if (!folder) return null
  if (y < rect.top + rect.height * FOLDER_EDGE) return childTarget(spaceId, parentId, index, own)
  if (y > rect.bottom - rect.height * FOLDER_EDGE) {
    if (!folder.collapsed && folder.childIds.length > 0) return childTarget(spaceId, id, 0, own)
    if (folder.collapsed) return childTarget(spaceId, parentId, index + 1, own)
  }
  return into(id)
}

// -- committing -------------------------------------------------------------------

function commit(item: DragItem, target: DropTarget): void {
  const s = useBrowser.getState()
  if (target.kind === 'space') {
    const space = s.spaces[target.spaceId]
    const tab = item.kind === 'tab' ? s.tabs[item.id] : undefined
    if (!space || !tab || tab.spaceId === space.id) return
    const move: MoveTabOptions = { spaceId: space.id, pinned: false, index: space.tabIds.length }
    optimisticMove(item.id, move)
    send('tabs.move', item.id, move)
    return
  }
  const own = placeOf(item, s)
  // Dropped where it already is.
  if (own && own.list === listOf(target) && own.index === target.index) return

  if (item.kind === 'tab') {
    let move: MoveTabOptions
    if (target.kind === 'section') move = { spaceId: target.spaceId, pinned: target.pinned, index: target.index }
    else if (target.kind === 'into') move = { spaceId: target.spaceId, pinned: false, folderId: target.folderId, index: target.index }
    else if (target.parentId) move = { spaceId: target.spaceId, pinned: false, folderId: target.parentId, index: target.index }
    else move = { spaceId: target.spaceId, pinned: false, saved: true, index: target.index }
    optimisticMove(item.id, move)
    send('tabs.move', item.id, move)
    return
  }

  let move: MoveFolderOptions
  if (target.kind === 'child') move = { parentId: target.parentId, index: target.index }
  else if (target.kind === 'into') move = { parentId: target.folderId, index: target.index }
  else return
  if (move.parentId && isWithinFolder(s.folders, move.parentId, item.id)) return
  optimisticFolderMove(item.id, move)
  send('folders.move', item.id, move)
}

// -- pointer loop -----------------------------------------------------------------

/** Scroll the tab list when the pointer rests near its top or bottom edge. */
function autoScroll(x: number, y: number): boolean {
  const el = document.querySelector<HTMLElement>('[data-sidebar-scroll]')
  if (!el) return false
  const r = el.getBoundingClientRect()
  if (x < r.left || x > r.right) return false
  let step = 0
  if (y >= r.top - 4 && y < r.top + SCROLL_EDGE) step = -Math.ceil(((r.top + SCROLL_EDGE - y) / SCROLL_EDGE) * SCROLL_STEP)
  else if (y <= r.bottom + 4 && y > r.bottom - SCROLL_EDGE) step = Math.ceil(((y - r.bottom + SCROLL_EDGE) / SCROLL_EDGE) * SCROLL_STEP)
  if (step === 0) return false
  const before = el.scrollTop
  el.scrollTop += Math.max(-SCROLL_STEP, Math.min(SCROLL_STEP, step))
  return el.scrollTop !== before
}

let suppressClick = false

/**
 * True while the click that trails a drag's pointerup is being dispatched
 * (same task), so a drop does not also toggle the folder it started on.
 */
export function dragJustEnded(): boolean {
  return suppressClick
}

/**
 * Pointer-driven drag for tab rows, pinned tiles and folder rows. Nothing
 * happens until the pointer travels THRESHOLD px, so plain clicks stay clicks.
 */
export function beginDrag(event: React.PointerEvent, item: DragItem): void {
  if (event.button !== 0) return
  const startX = event.clientX
  const startY = event.clientY
  let dragging = false
  let frame = 0
  let last: PointerEvent | null = null

  const update = () => {
    frame = 0
    if (!last) return
    const target = hitTest(last.clientX, last.clientY, item)
    useUi.setState({ drag: { item, x: last.clientX, y: last.clientY, target } })
    // Keep scrolling (and re-resolving the target) while the pointer rests at an edge.
    if (autoScroll(last.clientX, last.clientY)) frame = requestAnimationFrame(update)
  }
  const onMove = (e: PointerEvent) => {
    if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return
    dragging = true
    last = e
    frame ||= requestAnimationFrame(update)
  }
  const finish = (e: PointerEvent, cancelled: boolean) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    if (frame) cancelAnimationFrame(frame)
    const target = dragging && !cancelled ? hitTest(e.clientX, e.clientY, item) : null
    if (dragging) {
      suppressClick = true
      setTimeout(() => (suppressClick = false), 0)
    }
    useUi.setState({ drag: null })
    if (target) commit(item, target)
  }
  const onUp = (e: PointerEvent) => finish(e, false)
  const onCancel = (e: PointerEvent) => finish(e, true)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
}

// -- selectors for drop indicators ------------------------------------------------

type DragSlice = { drag: DragState | null }

/** Rendered index of the drop indicator in a section; -1 when the pointer is elsewhere. */
export function dropIndexFor(spaceId: SpaceId, pinned: boolean) {
  return (s: DragSlice): number => {
    const t = s.drag?.target
    return t?.kind === 'section' && t.spaceId === spaceId && t.pinned === pinned ? t.displayIndex : -1
  }
}

/** True when the pointer would drop the dragged tab right before `index`. */
export function dropBefore(spaceId: SpaceId, pinned: boolean, index: number) {
  const get = dropIndexFor(spaceId, pinned)
  return (s: DragSlice): boolean => get(s) === index
}

/** Rendered index of the drop indicator among a folder's children (or the top level). */
export function childDropIndexFor(spaceId: SpaceId, parentId: FolderId | null) {
  return (s: DragSlice): number => {
    const t = s.drag?.target
    return t?.kind === 'child' && t.spaceId === spaceId && t.parentId === parentId ? t.displayIndex : -1
  }
}

export function dropBeforeChild(spaceId: SpaceId, parentId: FolderId | null, index: number) {
  const get = childDropIndexFor(spaceId, parentId)
  return (s: DragSlice): boolean => get(s) === index
}

/** True while the pointer would append the dragged item into this folder. */
export function dropInto(folderId: FolderId) {
  return (s: DragSlice): boolean => {
    const t = s.drag?.target
    return t?.kind === 'into' && t.folderId === folderId
  }
}

export function isDragging(kind: DragItem['kind'], id: string) {
  return (s: DragSlice): boolean => s.drag?.item.kind === kind && s.drag.item.id === id
}
