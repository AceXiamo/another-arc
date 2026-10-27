import { create } from 'zustand'
import type { AutofillEntry } from '@shared/passwords'
import type { FolderId, SpaceId, TabId } from '@shared/types'

export type PaletteMode = 'new-tab' | 'edit-url'

/** What is being dragged in the sidebar. */
export type DragItem = { kind: 'tab'; id: TabId } | { kind: 'folder'; id: FolderId }

/**
 * Where the dragged item would land. `index` uses post-removal semantics (what
 * tabs.move / folders.move expect); `displayIndex` is the position in the list
 * as rendered, which is what the drop indicators compare against.
 */
export type DropTarget =
  /** Pinned tiles or today's tab list. */
  | { kind: 'section'; spaceId: SpaceId; pinned: boolean; index: number; displayIndex: number }
  /** Between the children of a folder, or among the top-level folders (`parentId` null). */
  | { kind: 'child'; spaceId: SpaceId; parentId: FolderId | null; index: number; displayIndex: number }
  /** Onto a folder row: appended to that folder. */
  | { kind: 'into'; spaceId: SpaceId; folderId: FolderId; index: number }
  /** Onto a space button in the space bar (tabs only). */
  | { kind: 'space'; spaceId: SpaceId }

export interface DragState {
  item: DragItem
  /** Pointer position (window coordinates). */
  x: number
  y: number
  target: DropTarget | null
}

export interface Toast {
  id: number
  message: string
}

interface UiState {
  palette: PaletteMode | null
  findOpen: boolean
  /** Space being created (`'new'`) or edited (its id). */
  spaceEditor: SpaceId | 'new' | null
  /**
   * The editor's theme panel, floating beside the sidebar: next to the space
   * card (`'attached'`), or on its own with Cancel / Save (`'standalone'`,
   * from "Edit Theme…").
   */
  themePanel: 'attached' | 'standalone' | null
  /** Folder whose name is being edited inline in the sidebar. */
  renamingFolder: FolderId | null
  /** Collapsed sidebar temporarily revealed by hovering the window edge. */
  peek: boolean
  drag: DragState | null
  toasts: Toast[]
  /** Logins offered over the focused sign-in field, the row picked by keyboard, and its side; null when closed. */
  autofill: { entries: AutofillEntry[]; active: number; above: boolean } | null
  /** A sign-in that just went through, waiting to be saved or waved off. */
  passwordPrompt: { origin: string; username: string } | null
  /** Site controls popover, hanging from the address pill button at this point (window coordinates). */
  sitePanel: { x: number; y: number } | null
}

export const useUi = create<UiState>()(() => ({
  palette: null,
  findOpen: false,
  spaceEditor: null,
  themePanel: null,
  renamingFolder: null,
  peek: false,
  drag: null,
  toasts: [],
  autofill: null,
  passwordPrompt: null,
  sitePanel: null
}))

let toastSeq = 0

export function toast(message: string): void {
  const id = ++toastSeq
  useUi.setState((s) => ({ toasts: [...s.toasts, { id, message }] }))
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2200)
}
