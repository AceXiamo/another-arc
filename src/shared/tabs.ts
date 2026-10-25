import type { TabState } from './types'

/**
 * A saved tab is a bookmark: a favorite tile, or a tab in the saved list (its
 * top level or a folder; Arc's pinned tabs). Closing it only unloads it and
 * returns it to `savedUrl`. Only today's tabs are ever closed for good.
 */
export function isSavedTab(tab: Pick<TabState, 'folderId' | 'savedUrl'>): boolean {
  return tab.folderId !== null || tab.savedUrl !== ''
}
