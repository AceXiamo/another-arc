import type { SurfaceId } from './layout'
import type { InternalPage } from './url'
import type {
  ExtensionInfo,
  FolderId,
  HistoryEntry,
  PermissionDecision,
  SearchEngineId,
  Settings,
  ShellCommand,
  ShellSnapshot,
  SitePermission,
  SpaceId,
  StatePatch,
  Suggestion,
  TabId
} from './types'

/** Channel names. Everything shell-bound travels over these three. */
export const IPC = {
  invoke: 'arc:invoke',
  patch: 'arc:patch',
  command: 'arc:command'
} as const

export interface CreateTabOptions {
  url?: string
  spaceId?: SpaceId
  background?: boolean
  pinned?: boolean
  /** Insert position inside the target section. Defaults to the end. */
  index?: number
}

export interface MoveTabOptions {
  spaceId: SpaceId
  pinned: boolean
  /**
   * Save the tab into this folder (of `spaceId`); `index` is then a position
   * in the folder's `childIds`. Omitted / null = see `saved`.
   */
  folderId?: FolderId | null
  /**
   * Without `folderId`: true saves the tab at the top level of the saved list
   * (`index` counts in `space.savedIds`); false / omitted = the pinned tiles
   * or the tabs section, per `pinned`.
   */
  saved?: boolean
  /** Position in the target list, counted after the tab was taken out. */
  index: number
}

export interface CreateFolderOptions {
  /** Defaults to the active space. */
  spaceId?: SpaceId
  /** Create inside this folder; null / omitted = top level. */
  parentId?: FolderId | null
  /** Position among the parent's children. Defaults to the start. */
  index?: number
  /** Defaults to a localized "New Folder". */
  name?: string
  /** Tabs to save into the new folder right away. */
  tabIds?: TabId[]
}

export interface MoveFolderOptions {
  /** New parent within the same space; null = top level. */
  parentId: FolderId | null
  /** Position among the new parent's children, counted after the folder was taken out. */
  index: number
}

export interface SpaceInput {
  name: string
  icon: string
  color: string
}

export interface Point {
  x: number
  y: number
}

/**
 * Request/response methods the shell may call. The main process validates
 * every argument at runtime (see src/main/ipc/router.ts) — the types here are
 * a compile-time convenience, not a trust boundary.
 */
export interface ShellRpc {
  'shell.snapshot': () => ShellSnapshot
  'shell.ready': () => void

  'tabs.create': (opts: CreateTabOptions) => TabId
  'tabs.activate': (tabId: TabId) => void
  'tabs.close': (tabId: TabId) => void
  'tabs.navigate': (tabId: TabId, input: string) => void
  'tabs.reload': (tabId: TabId, ignoreCache: boolean) => void
  'tabs.stop': (tabId: TabId) => void
  'tabs.goBack': (tabId: TabId) => void
  'tabs.goForward': (tabId: TabId) => void
  'tabs.move': (tabId: TabId, opts: MoveTabOptions) => void
  'tabs.duplicate': (tabId: TabId) => void
  'tabs.setMuted': (tabId: TabId, muted: boolean) => void
  'tabs.reopenClosed': () => void
  'tabs.contextMenu': (tabId: TabId, at: Point) => void
  'tabs.copyUrl': (tabId: TabId) => void
  /** Proceed past a certificate error for this host (session only). */
  'tabs.allowCertificate': (tabId: TabId) => void
  'tabs.openInternal': (page: InternalPage) => void

  'spaces.create': (input: SpaceInput) => SpaceId
  'spaces.update': (spaceId: SpaceId, input: Partial<SpaceInput>) => void
  'spaces.delete': (spaceId: SpaceId) => void
  'spaces.activate': (spaceId: SpaceId) => void
  'spaces.reorder': (order: SpaceId[]) => void
  'spaces.contextMenu': (spaceId: SpaceId, at: Point) => void

  'folders.create': (opts: CreateFolderOptions) => FolderId
  'folders.rename': (folderId: FolderId, name: string) => void
  'folders.setCollapsed': (folderId: FolderId, collapsed: boolean) => void
  'folders.move': (folderId: FolderId, opts: MoveFolderOptions) => void
  /** Asks for confirmation in main when the folder still holds tabs. */
  'folders.delete': (folderId: FolderId) => void
  'folders.contextMenu': (folderId: FolderId, at: Point) => void
  /** Right-click on empty sidebar space: New Folder, Edit Space… */
  'sidebar.contextMenu': (spaceId: SpaceId, at: Point) => void

  'window.setSidebar': (opts: { width?: number; collapsed?: boolean }) => void
  'window.setOverlay': (open: boolean) => void
  'window.focusPage': () => void
  'surface.setVisible': (id: SurfaceId, visible: boolean) => void

  'history.suggest': (query: string, limit: number) => Suggestion[]
  'history.list': (query: string, before: number, limit: number) => HistoryEntry[]
  'history.delete': (ids: number[]) => void
  'history.clear': () => void

  'settings.update': (patch: Partial<Settings>) => void
  'settings.pickDownloadDir': () => string | null
  'settings.searchEngines': () => Array<{ id: SearchEngineId; name: string; template: string }>

  'extensions.install': () => ExtensionInfo | null
  'extensions.setEnabled': (id: string, enabled: boolean) => void
  'extensions.setPinned': (id: string, pinned: boolean) => void
  'extensions.uninstall': (id: string) => void
  'extensions.update': (id: string) => void
  'extensions.openOptions': (id: string) => void
  'extensions.contextMenu': (id: string, at: Point) => void
  /** Browsers (Arc, Chrome) whose last-used profile has extensions to import. Read-only scan. */
  'extensions.importSources': () => import('./ext-import').ImportSourceSummary[]
  /** Confirm, import and report, all with native dialogs in main. */
  'extensions.importFromBrowser': (source: import('./ext-import').ImportBrowser) => void

  /** Counts in Arc's sidebar (spaces with pinned items, folders, pinned tabs, favorites); null when not found. */
  'import.arcSidebarSummary': () => { spaces: number; folders: number; tabs: number; favorites: number } | null
  /** Confirm, import Arc's sidebar into spaces / folders / favorites, report — native dialogs in main. */
  'import.arcSidebar': () => void
  /** Sidebar and extensions from Arc in one confirmation (File menu, Settings, ⌘T). */
  'import.arc': () => void

  'downloads.open': (id: string) => void
  'downloads.reveal': (id: string) => void
  'downloads.cancel': (id: string) => void
  'downloads.pause': (id: string) => void
  'downloads.resume': (id: string) => void
  'downloads.remove': (id: string) => void
  'downloads.clear': () => void

  'find.update': (tabId: TabId, text: string, forward: boolean, findNext: boolean) => void
  'find.stop': (tabId: TabId) => void

  'zoom.adjust': (tabId: TabId, delta: -1 | 0 | 1) => void

  'permissions.respond': (promptId: string, decision: PermissionDecision, remember: boolean) => void
  'permissions.list': () => SitePermission[]
  'permissions.reset': (origin: string, permission: string) => void

  'devtools.toggle': (tabId: TabId) => void
}

export type RpcMethod = keyof ShellRpc
export type RpcArgs<M extends RpcMethod> = Parameters<ShellRpc[M]>
export type RpcResult<M extends RpcMethod> = ReturnType<ShellRpc[M]>

/** Messages pushed from main to the shell. */
export interface ShellEvents {
  [IPC.patch]: StatePatch
  [IPC.command]: ShellCommand
}
