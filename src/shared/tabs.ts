import type { TabState } from './types'

/**
 * A saved tab is a bookmark (Arc's pinned tab): it lives in the saved list,
 * at its top level or inside a folder, and closing it only unloads it.
 */
export function isSavedTab(tab: Pick<TabState, 'folderId' | 'savedUrl'>): boolean {
  return tab.folderId !== null || tab.savedUrl !== ''
}
