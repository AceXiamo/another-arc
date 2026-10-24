import type { FolderId, ProfileId, SpaceId, TabId } from '@shared/types'

/** Serialized back/forward stack, as produced by `navigationHistory.getAllEntries()`. */
export interface NavState {
  entries: Array<{ url: string; title: string; pageState?: string }>
  index: number
}

export interface TabRecord {
  id: TabId
  spaceId: SpaceId
  url: string
  title: string
  favicon: string | null
  pinned: boolean
  sortOrder: number
  createdAt: number
  lastActiveAt: number
  navState: NavState | null
  zoom: number
  muted: boolean
  folderId: FolderId | null
  savedUrl: string
  savedTitle: string
}

export interface FolderRecord {
  id: FolderId
  spaceId: SpaceId
  parentId: FolderId | null
  name: string
  collapsed: boolean
  /** Position among its siblings (which mix folders and tabs). */
  sortOrder: number
  createdAt: number
}

export interface SpaceRecord {
  id: SpaceId
  name: string
  icon: string
  color: string
  sortOrder: number
  profileId: ProfileId
  activeTabId: TabId | null
  createdAt: number
}

export interface ProfileRecord {
  id: ProfileId
  name: string
  partition: string
  createdAt: number
}

export interface ExtensionRecord {
  id: string
  name: string
  version: string
  /** Managed copy inside the user data directory. */
  path: string
  /** Where it was imported from. */
  sourcePath: string
  enabled: boolean
  pinned: boolean
  installedAt: number
}
