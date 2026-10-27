import type { ShellSnapshot, StatePatch } from './types'

export type ShellState = ShellSnapshot

/**
 * Merge a keyed patch. Untouched entries keep their object identity, which
 * is what lets per-row selectors in the shell skip re-rendering.
 */
export function mergeKeyed<T extends object>(
  base: Record<string, T>,
  patch: Record<string, Partial<T> | null>
): Record<string, T> {
  const out: Record<string, T> = { ...base }
  for (const id of Object.keys(patch)) {
    const value = patch[id]
    if (value === null || value === undefined) {
      delete out[id]
    } else {
      const existing = out[id]
      out[id] = existing ? { ...existing, ...value } : (value as T)
    }
  }
  return out
}

/** Pure reducer: returns only the top-level fields that changed. */
export function applyPatch(state: ShellState, patch: StatePatch): Partial<ShellState> {
  const next: Partial<ShellState> = {}
  if (patch.tabs) next.tabs = mergeKeyed(state.tabs, patch.tabs)
  if (patch.spaces) next.spaces = mergeKeyed(state.spaces, patch.spaces)
  if (patch.folders) next.folders = mergeKeyed(state.folders, patch.folders)
  if (patch.downloads) next.downloads = mergeKeyed(state.downloads, patch.downloads)
  if (patch.spaceOrder) next.spaceOrder = patch.spaceOrder
  if (patch.window) next.window = { ...state.window, ...patch.window }
  if (patch.settings) next.settings = { ...state.settings, ...patch.settings }
  if (patch.extensions) next.extensions = patch.extensions
  if (patch.permissionPrompts) next.permissionPrompts = patch.permissionPrompts
  if (patch.pageDialogs) next.pageDialogs = patch.pageDialogs
  if ('find' in patch) next.find = patch.find ?? null
  return next
}
