import type { Rect, SurfaceId } from './layout'
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
  SpaceTheme,
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

/** Page preload → main, synchronous: a page's prompt(); the reply is the text, or null. */
export const PAGE_PROMPT_IPC = 'arc:page:prompt'

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
  /** Merged into the current theme (or the defaults) and sanitized in main. */
  theme?: Partial<SpaceTheme>
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
  /** The macOS share menu for the page's address. */
  'tabs.share': (tabId: TabId, at: Point) => void
  /** Copy what the page shows to the clipboard as an image; false when it has no live page. */
  'tabs.copyScreenshot': (tabId: TabId) => boolean
  /** The site controls' "more" menu. */
  'tabs.siteMenu': (tabId: TabId, at: Point) => void
  /** Proceed past a certificate error for this host (session only). */
  'tabs.allowCertificate': (tabId: TabId) => void
  'tabs.openInternal': (page: InternalPage) => void

  /** Whether macOS opens http(s) links with this app. */
  'defaultBrowser.get': () => boolean
  /** Ask macOS to make this app the default browser (it confirms with the user itself). */
  'defaultBrowser.set': () => boolean

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
  /** Title-bar areas: the pointer went down / up (main moves the window in between). */
  'window.drag': (phase: 'start' | 'end') => void
  /** Double-click on a title-bar area: the system action (zoom, minimize or nothing). */
  'window.titleBarDoubleClick': () => void
  'surface.setVisible': (id: SurfaceId, visible: boolean) => void
  /** Bounds of the site controls surface, in window coordinates. */
  'sitePanel.place': (bounds: Rect) => void

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
  /** Browsers whose last-used profile has extensions to import. Read-only scan. */
  'extensions.importSources': () => import('./ext-import').ImportSourceSummary[]
  /** Confirm, import and report, all with native dialogs in main. */
  'extensions.importFromBrowser': (source: import('./ext-import').ImportBrowser) => void

  /** Counts in Arc's sidebar (spaces with pinned items, folders, pinned tabs, favorites); null when not found. */
  'import.arcSidebarSummary': () => { spaces: number; folders: number; tabs: number; favorites: number } | null
  /** Confirm, import Arc's sidebar into spaces / folders / favorites, report — native dialogs in main. */
  'import.arcSidebar': () => void
  /**
   * Every installed browser and what its chosen profile would bring over.
   * `chosen` maps a browser id to a profile directory; anything else falls
   * back to that browser's last-used profile. Read-only scan.
   */
  'import.browsers': (chosen?: Record<string, string>) => import('./ext-import').ImportableBrowser[]
  /** Bookmarks, extensions and logins from one browser profile, in one confirmation. */
  'import.run': (browser: import('./ext-import').ImportBrowser, profileDir?: string) => void
  /** Same, for whichever browser has the most to bring over (palette). */
  'import.best': () => void

  /** Saved logins, without their passwords. */
  'passwords.list': () => import('./passwords').SavedLogin[]
  /** False when the OS will not give us a key, so nothing can be saved. */
  'passwords.available': () => boolean
  /** Fill the pick from the sign-in dropdown into the page that asked for it. */
  'passwords.fill': (id: string) => void
  /** Close the dropdown without filling anything. */
  'passwords.dismiss': () => void
  /** Close the dropdown and open the saved passwords in Settings. */
  'passwords.manage': () => void
  /** Answer the "save this password?" prompt. */
  'passwords.resolveSave': (accept: boolean) => void
  'passwords.remove': (id: string) => void
  /** Put one password on the clipboard. It never travels to the shell. */
  'passwords.copy': (id: string) => boolean
  /** Show one password, behind Touch ID. Null when it cannot be unlocked. */
  'passwords.reveal': (id: string) => string | null

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
  /** Change a remembered decision (site controls). */
  'permissions.set': (origin: string, permission: string, decision: PermissionDecision) => void

  /** Answer a page's alert / confirm / prompt; `suppress` blocks further ones from that origin. */
  'pageDialogs.respond': (dialogId: string, accept: boolean, text: string, suppress: boolean) => void

  'devtools.toggle': (tabId: TabId) => void

  /** State of the agent (MCP) server; waits for a start or stop in progress. */
  'agent.info': () => import('./agent').AgentInfo
  /** Put the token or a client's setup snippet on the clipboard. */
  'agent.copy': (what: import('./agent').AgentSnippet) => void
  /** Replace the token; every agent has to be set up again. */
  'agent.regenerateToken': () => import('./agent').AgentInfo
}

export type RpcMethod = keyof ShellRpc
export type RpcArgs<M extends RpcMethod> = Parameters<ShellRpc[M]>
export type RpcResult<M extends RpcMethod> = ReturnType<ShellRpc[M]>

/** Messages pushed from main to the shell. */
export interface ShellEvents {
  [IPC.patch]: StatePatch
  [IPC.command]: ShellCommand
}
