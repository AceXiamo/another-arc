// Data contracts shared by the main process, the preload bridge and the shell UI.
// The main process owns every piece of state below; the shell receives a
// snapshot on boot and incremental `StatePatch`es afterwards.

export type TabId = string
export type SpaceId = string
export type ProfileId = string
export type FolderId = string

export interface TabError {
  kind: 'network' | 'certificate'
  code: number
  description: string
  url: string
}

export interface TabState {
  id: TabId
  spaceId: SpaceId
  url: string
  title: string
  /** Original favicon URL; the shell renders it through the `favicon:` cache protocol. */
  favicon: string | null
  pinned: boolean
  /**
   * Folder the tab is saved in; null at the top level of the saved list or
   * outside it. A saved tab (see `isSavedTab`) is a bookmark — Arc's pinned
   * tab: closing it unloads it and returns it to `savedUrl` instead of
   * removing it.
   */
  folderId: FolderId | null
  /** Bookmarked URL and title of a saved tab; empty strings for every other tab. */
  savedUrl: string
  savedTitle: string
  /** A WebContents currently exists for this tab (false = unloaded / discarded). */
  live: boolean
  loading: boolean
  audible: boolean
  muted: boolean
  canGoBack: boolean
  canGoForward: boolean
  crashed: boolean
  error: TabError | null
  zoomFactor: number
  lastActiveAt: number
  /** An agent (MCP) is driving this tab right now. Not persisted. */
  agent?: boolean
}

/** Light/dark mode of the chrome while a space is active; 'system' follows Settings. */
export type SpaceAppearance = 'system' | 'light' | 'dark'

/**
 * How a space paints the sidebar and window chrome (Arc's "Edit Theme").
 * `SpaceState.color` stays the primary color and the accent; this holds the
 * rest. Always sanitized in main (see `sanitizeSpaceTheme`).
 */
export interface SpaceTheme {
  /** Extra gradient colors after `color`, as `#rrggbb` (0–2). */
  gradient: string[]
  /** Gradient direction in degrees, CSS convention (0 = to top, 90 = to right). 0–359. */
  angle: number
  /** 0–100: how strongly the colors tint the chrome. 50 is the classic tint. */
  intensity: number
  /** 0–100: film-grain overlay; 0 = off. */
  noise: number
  appearance: SpaceAppearance
}

export interface SpaceState {
  id: SpaceId
  name: string
  /** Emoji or short glyph. */
  icon: string
  /** Theme color as `#rrggbb`: the first gradient color and the accent. */
  color: string
  theme: SpaceTheme
  profileId: ProfileId
  pinnedTabIds: TabId[]
  /**
   * Top level of the saved list (Arc's pinned section), shown between the
   * pinned tiles and the tabs: folder ids and saved tab ids, mixed.
   */
  savedIds: string[]
  tabIds: TabId[]
  activeTabId: TabId | null
}

export interface FolderState {
  id: FolderId
  spaceId: SpaceId
  /** Enclosing folder; null for a top-level folder. */
  parentId: FolderId | null
  name: string
  collapsed: boolean
  /** Ordered children: tab ids and folder ids (look them up in `tabs` / `folders`). */
  childIds: string[]
}

export interface WindowState {
  activeSpaceId: SpaceId
  sidebarWidth: number
  sidebarCollapsed: boolean
  /** Native macOS fullscreen (traffic lights hidden). */
  fullscreen: boolean
  /** A page requested HTML fullscreen (video etc.); the shell hides itself. */
  htmlFullscreen: boolean
  focused: boolean
}

import type { Locale } from './i18n'

export type SearchEngineId = 'google' | 'bing' | 'duckduckgo' | 'baidu' | 'kagi' | 'custom'

export interface Settings {
  searchEngine: SearchEngineId
  /** Used when `searchEngine === 'custom'`; `%s` is replaced by the query. */
  customSearchUrl: string
  downloadAskWhere: boolean
  /** Empty string = the system Downloads folder. */
  downloadDir: string
  /** Background tabs idle for longer than this are discarded. 0 disables. */
  discardAfterMinutes: number
  /** Discard least-recently-used tabs once total memory exceeds this. 0 disables. */
  memoryBudgetMB: number
  theme: 'system' | 'light' | 'dark'
  /** UI language (menus, dialogs, shell). */
  language: Locale
  /** Serve the MCP endpoint that lets AI agents use the browser (src/main/agent). */
  agentEnabled: boolean
  /** Local port of that endpoint. */
  agentPort: number
}

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  manifestVersion: number
  enabled: boolean
  /** Shown in the sidebar toolbar. */
  pinned: boolean
  hasAction: boolean
  permissions: string[]
  hostPermissions: string[]
  /** Folder the extension was imported from (used for "update from source"). */
  sourcePath: string
  installedAt: number
  /** Load error from the last enable attempt. */
  error: string | null
  /** Small icon as a data URL (read from the manifest icons). */
  icon: string | null
  /** chrome-extension:// URL of the options page, if any. */
  optionsUrl: string | null
  /** Its popup or side panel window is open. */
  windowOpen?: boolean
}

export type DownloadStatus = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadState {
  id: string
  url: string
  filename: string
  savePath: string
  status: DownloadStatus
  paused: boolean
  receivedBytes: number
  totalBytes: number
  startedAt: number
  endedAt: number | null
  /** MIME type reported by the server; only known for downloads made this run. */
  mimeType?: string
}

export type PermissionKind =
  | 'media'
  | 'geolocation'
  | 'notifications'
  | 'midiSysex'
  | 'clipboard-read'
  | 'display-capture'
  | 'idle-detection'
  | 'window-management'
  | 'storage-access'
  | 'top-level-storage-access'
  | 'keyboardLock'
  | 'pointerLock'
  | 'fileSystem'
  | 'openExternal'
  | 'hid'
  | 'serial'
  | 'usb'

export type PermissionDecision = 'allow' | 'deny'

export interface PermissionPrompt {
  id: string
  tabId: TabId | null
  origin: string
  permission: PermissionKind
  /** Human readable extra info, e.g. ['camera', 'microphone'] or an external URL. */
  details: string[]
}

/** A page's alert() / confirm() / prompt(), waiting for the user; the shell draws it over that tab's page. */
export interface PageDialog {
  id: string
  tabId: TabId
  kind: 'alert' | 'confirm' | 'prompt'
  /** Origin of the frame that asked: 'null' for opaque ones, 'file://' for local files. */
  origin: string
  message: string
  /** prompt() only: what the field starts with. */
  defaultText: string
  /** safeDialogs: not the first from this origin, so the user may block the rest. */
  canSuppress: boolean
}

export interface SitePermission {
  origin: string
  permission: PermissionKind
  decision: PermissionDecision
  updatedAt: number
}

export interface FindState {
  tabId: TabId
  text: string
  activeMatch: number
  matches: number
}

export interface ShellSnapshot {
  tabs: Record<TabId, TabState>
  spaces: Record<SpaceId, SpaceState>
  folders: Record<FolderId, FolderState>
  spaceOrder: SpaceId[]
  window: WindowState
  settings: Settings
  extensions: ExtensionInfo[]
  /** Partition the extensions live in (for action buttons / crx icons). */
  extensionPartition: string
  downloads: Record<string, DownloadState>
  permissionPrompts: PermissionPrompt[]
  pageDialogs: PageDialog[]
  find: FindState | null
  isDev: boolean
}

/**
 * Incremental update. For keyed collections `null` removes an entry and an
 * object is shallow-merged into the existing entry (or inserted).
 */
export interface StatePatch {
  tabs?: Record<TabId, Partial<TabState> | null>
  spaces?: Record<SpaceId, Partial<SpaceState> | null>
  folders?: Record<FolderId, Partial<FolderState> | null>
  spaceOrder?: SpaceId[]
  window?: Partial<WindowState>
  settings?: Partial<Settings>
  extensions?: ExtensionInfo[]
  downloads?: Record<string, Partial<DownloadState> | null>
  permissionPrompts?: PermissionPrompt[]
  pageDialogs?: PageDialog[]
  find?: FindState | null
}

export interface HistoryEntry {
  id: number
  url: string
  title: string
  visitedAt: number
  /** Cached icon URL (see `faviconSrc`): the page's own, else one from its site. */
  favicon: string | null
}

export type SuggestionKind = 'history' | 'tab'

export interface Suggestion {
  kind: SuggestionKind
  url: string
  title: string
  /** History suggestions: the page's icon, as in `HistoryEntry`. */
  favicon?: string | null
  tabId?: TabId
}

export type ShellCommand =
  | { type: 'palette.open'; mode: 'new-tab' | 'edit-url' }
  | { type: 'palette.close' }
  | { type: 'find.open' }
  | { type: 'find.close' }
  /** `theme` opens the editor with its theme panel showing. */
  | { type: 'space.edit'; spaceId: SpaceId | 'new'; theme?: boolean }
  | { type: 'folder.rename'; folderId: FolderId }
  | { type: 'toast'; message: string }
  /**
   * Sign-in dropdown: what to list (null closes it), the row picked by
   * keyboard (-1: none), and whether it sits above the field.
   */
  | { type: 'autofill'; entries: import('./passwords').AutofillEntry[] | null; active: number; above: boolean }
  /** Offer to remember a sign-in the user just made. */
  | { type: 'password.offerSave'; origin: string; username: string }
  /** The site controls lost focus (a press anywhere else): close them. */
  | { type: 'sitePanel.dismiss' }
