import { randomUUID } from 'node:crypto'
import {
  clipboard,
  type BrowserWindowConstructorOptions,
  type ContextMenuParams,
  type Event as ElectronEvent,
  type HandlerDetails,
  type Input,
  type Result as FoundInPageResult,
  type WebContents,
  type WindowOpenHandlerResponse
} from 'electron'
import { DEFAULT_PROFILE_ID, DEFAULT_SPACE, LIMITS } from '@shared/defaults'
import type { CreateFolderOptions, MoveFolderOptions, MoveTabOptions, SpaceInput } from '@shared/ipc'
import { type Locale, LOCALES, translate } from '@shared/i18n'
import type { FolderId, FolderState, SpaceId, TabId, TabState } from '@shared/types'
import { isSavedTab } from '@shared/tabs'
import { sanitizeSpaceTheme, themesEqual } from '@shared/theme'
import { isInternalUrl, originOf, resolveInput, searchTemplate, tabPresentsView } from '@shared/url'
import type { FaviconCache } from '../history/favicon-cache'
import type { HistoryService } from '../history/history-service'
import type { FolderRecord, NavState, SpaceRecord, TabRecord } from '../persistence/records'
import type { Persister } from '../persistence/persister'
import type { ProfileManager } from '../profiles/profile-manager'
import type { SettingsService } from '../settings/settings-service'
import type { BrowserWindowController } from '../windows/browser-window'
import type { ShellSync } from '../windows/shell-sync'
import { BrowserModel, type FolderData, type ModelListener, type SpaceData, type TabData } from './model'
import { TabRuntime, type TabRuntimeHost } from './tab-runtime'
import { nextZoomFactor, type ZoomStore } from './zoom'

export interface ClosedTab {
  spaceId: SpaceId
  pinned: boolean
  /** Folder it was saved in; reopening puts it back when the folder still exists. */
  folderId: FolderId | null
  savedUrl: string
  savedTitle: string
  index: number
  url: string
  title: string
  favicon: string | null
  navState: NavState | null
}

/** Integration points owned by other subsystems (extensions, menus, keys). */
export interface TabManagerDelegate {
  contextMenu(tab: TabData, wc: WebContents, params: ContextMenuParams): void
  beforeInput(tabId: TabId, event: ElectronEvent, input: Input): void
  popupCreated(window: Electron.BrowserWindow): void
  confirmLeave(tab: TabData): Promise<boolean>
  runtimeCreated(tab: TabData, wc: WebContents): void
  runtimeDestroyed(wc: WebContents): void
  activeChanged(wc: WebContents | null): void
  htmlFullscreen(on: boolean): void
  /** The active space or its color / theme changed (the window background follows it). */
  activeThemeChanged?(): void
  /** A tab left the model for good (closed, its space or folder deleted). */
  tabRemoved?(tabId: TabId): void
}

export interface TabManagerDeps {
  profiles: ProfileManager
  persister: Persister
  shell: ShellSync
  history: HistoryService
  favicons: FaviconCache
  settings: SettingsService
  zoom: ZoomStore
}

const PERSISTED_TAB_FIELDS = new Set<keyof TabData>([
  'spaceId',
  'url',
  'title',
  'favicon',
  'pinned',
  'lastActiveAt',
  'navState',
  'zoomFactor',
  'muted',
  'folderId',
  'savedUrl',
  'savedTitle'
])

const PRESENTATION_FIELDS = new Set<keyof TabData>(['url', 'error', 'crashed', 'live'])

export function toTabState(t: TabData): TabState {
  const { createdAt: _c, navState: _n, ...state } = t
  return state
}

function stateOnly(patch: Partial<TabData>): Partial<TabState> {
  if (!('navState' in patch) && !('createdAt' in patch)) return patch
  const { createdAt: _c, navState: _n, ...rest } = patch
  return rest
}

function newTabData(init: { id?: TabId; spaceId: SpaceId; url: string; pinned?: boolean } & Partial<TabData>): TabData {
  const now = Date.now()
  return {
    title: '',
    favicon: null,
    live: false,
    loading: false,
    audible: false,
    muted: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    error: null,
    zoomFactor: 1,
    lastActiveAt: now,
    createdAt: now,
    navState: null,
    ...init,
    id: init.id ?? randomUUID(),
    pinned: init.pinned ?? false,
    folderId: init.folderId ?? null,
    savedUrl: init.savedUrl ?? '',
    savedTitle: init.savedTitle ?? ''
  }
}

function toFolderState(f: FolderData): FolderState {
  const { createdAt: _c, ...state } = f
  return state
}

/** Popup windows requested with explicit window features (OAuth flows, etc). */
function popupOptions(features: string): BrowserWindowConstructorOptions {
  const map = new Map<string, number>()
  for (const part of features.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim().toLowerCase())
    if (k && v && /^\d+$/.test(v)) map.set(k, Number(v))
  }
  const clamp = (n: number | undefined, lo: number, hi: number, d: number) =>
    n === undefined ? d : Math.max(lo, Math.min(hi, n))
  return {
    width: clamp(map.get('width') ?? map.get('innerwidth'), 280, 2000, 520),
    height: clamp(map.get('height') ?? map.get('innerheight'), 240, 1600, 680),
    ...(map.has('left') && map.has('top') ? { x: map.get('left')!, y: map.get('top')! } : {}),
    backgroundColor: '#ffffff',
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      safeDialogs: true,
      webviewTag: false
    }
  }
}

const FAVICON_PREFETCH_CONCURRENCY = 4

const OPENABLE_SCHEMES = /^(https?:|about:blank|blob:|chrome-extension:|file:)/

export class TabManager implements TabRuntimeHost {
  readonly model: BrowserModel
  private readonly runtimes = new Map<TabId, TabRuntime>()
  /** Runtimes whose tab was removed from the model and that are shutting down. */
  private readonly closing = new Map<TabId, { tab: TabData; closed: ClosedTab; wasActive: boolean; rt: TabRuntime }>()
  /** Runtimes being discarded; they can be revived if the page refuses to unload. */
  private readonly discarding = new Map<TabId, TabRuntime>()
  private readonly byWebContents = new Map<number, TabId>()
  private readonly findText = new Map<TabId, string>()
  private closedTabs: ClosedTab[] = []
  /** When a tab last went onto the reopen stack (for ⌘Z). */
  lastClosedAt = 0
  private window: BrowserWindowController | null = null
  private delegate: TabManagerDelegate | null = null
  private presentQueued = false
  private shownTabId: TabId | null = null
  private frozen = false

  constructor(private readonly deps: TabManagerDeps) {
    this.model = new BrowserModel(this.modelListener())
  }

  setDelegate(delegate: TabManagerDelegate): void {
    this.delegate = delegate
  }

  attachWindow(window: BrowserWindowController): void {
    this.window = window
    this.present()
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  restore(spaces: SpaceRecord[], tabs: TabRecord[], activeSpaceId: SpaceId | null, folders: FolderRecord[] = []): void {
    const spaceData: SpaceData[] = spaces.map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      color: s.color,
      theme: s.theme,
      profileId: s.profileId,
      pinnedTabIds: [],
      savedIds: [],
      tabIds: [],
      activeTabId: s.activeTabId,
      createdAt: s.createdAt
    }))
    const tabData = tabs.map((t) =>
      newTabData({
        id: t.id,
        spaceId: t.spaceId,
        url: t.url,
        title: t.title,
        favicon: t.favicon,
        pinned: t.pinned,
        createdAt: t.createdAt,
        lastActiveAt: t.lastActiveAt,
        navState: t.navState,
        zoomFactor: t.zoom,
        muted: t.muted,
        folderId: t.folderId,
        savedUrl: t.savedUrl,
        savedTitle: t.savedTitle
      })
    )
    const folderData: FolderData[] = folders.map((f) => ({
      id: f.id,
      spaceId: f.spaceId,
      parentId: f.parentId,
      name: f.name,
      collapsed: f.collapsed,
      childIds: [],
      createdAt: f.createdAt
    }))
    const order = new Map<string, number>()
    for (const r of [...tabs, ...folders]) order.set(r.id, r.sortOrder)
    this.model.load(spaceData, tabData, activeSpaceId, folderData, (id) => order.get(id) ?? 0)
    // Favorites stored before they kept a saved page got one on load; persist it.
    for (const t of tabs) if (t.pinned && !t.savedUrl) this.deps.persister.markTab(t.id)
    if (this.model.spaces.size === 0) {
      const { nameKey, icon, color } = DEFAULT_SPACE
      this.createSpace({ name: translate(this.deps.settings.get().language, nameKey), icon, color })
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  runtime(tabId: TabId): TabRuntime | undefined {
    return this.runtimes.get(tabId)
  }

  tabIdFor(wc: WebContents): TabId | undefined {
    return this.byWebContents.get(wc.id)
  }

  /** Give a tab a live page without selecting it (agents work in background tabs). */
  wake(tabId: TabId): TabRuntime | undefined {
    const tab = this.model.getTab(tabId)
    if (!tab || isInternalUrl(tab.url)) return undefined
    let rt = this.runtimes.get(tabId)
    if (!rt) {
      rt = this.spawnRuntime(tab)
      rt.load(tab)
    }
    return rt
  }

  activeRuntime(): TabRuntime | undefined {
    const tab = this.model.activeTab()
    return tab ? this.runtimes.get(tab.id) : undefined
  }

  liveRuntimes(): TabRuntime[] {
    return [...this.runtimes.values()]
  }

  tabRecord(id: TabId): TabRecord | null {
    const t = this.model.getTab(id)
    if (!t) return null
    const rt = this.runtimes.get(id)
    return {
      id: t.id,
      spaceId: t.spaceId,
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      pinned: t.pinned,
      sortOrder: this.model.sortOrderOf(t),
      createdAt: t.createdAt,
      lastActiveAt: t.lastActiveAt,
      navState: (rt && rt.snapshot()) ?? t.navState,
      zoom: t.zoomFactor,
      muted: t.muted,
      folderId: t.folderId,
      savedUrl: t.savedUrl,
      savedTitle: t.savedTitle
    }
  }

  folderRecord(id: FolderId): FolderRecord | null {
    const f = this.model.getFolder(id)
    if (!f) return null
    return {
      id: f.id,
      spaceId: f.spaceId,
      parentId: f.parentId,
      name: f.name,
      collapsed: f.collapsed,
      sortOrder: this.model.sortOrderOfFolder(f),
      createdAt: f.createdAt
    }
  }

  spaceRecord(id: SpaceId): SpaceRecord | null {
    const s = this.model.getSpace(id)
    if (!s) return null
    return {
      id: s.id,
      name: s.name,
      icon: s.icon,
      color: s.color,
      theme: s.theme,
      sortOrder: this.model.spaceOrder.indexOf(id),
      profileId: s.profileId,
      activeTabId: s.activeTabId,
      createdAt: s.createdAt
    }
  }

  snapshot() {
    const tabs: Record<TabId, TabState> = {}
    for (const t of this.model.tabs.values()) tabs[t.id] = toTabState(t)
    const spaces: Record<SpaceId, SpaceData> = {}
    for (const s of this.model.spaces.values()) spaces[s.id] = { ...s }
    const folders: Record<FolderId, FolderState> = {}
    for (const f of this.model.folders.values()) folders[f.id] = toFolderState(f)
    return {
      tabs,
      spaces,
      folders,
      spaceOrder: [...this.model.spaceOrder],
      activeSpaceId: this.model.activeSpaceId
    }
  }

  // ---------------------------------------------------------------------------
  // Tab operations (shared by IPC, shortcuts, menus and extensions)
  // ---------------------------------------------------------------------------

  createTab(opts: {
    url?: string
    spaceId?: SpaceId
    background?: boolean
    pinned?: boolean
    index?: number
    typed?: boolean
    /** Runs once the page exists, before it starts loading (agents attach their recorders here). */
    beforeLoad?: (tabId: TabId, view: TabRuntime['view']) => void
  }): TabData {
    const spaceId = opts.spaceId && this.model.getSpace(opts.spaceId) ? opts.spaceId : this.model.activeSpaceId
    const url = opts.url ?? 'about:blank'
    const tab = newTabData({ spaceId, url, pinned: opts.pinned ?? false })
    if (!isInternalUrl(url)) {
      const rt = this.spawnRuntime(tab)
      opts.beforeLoad?.(tab.id, rt.view)
      rt.loadUrl(url, opts.typed ?? false)
    }
    this.model.addTab(tab, { index: opts.index, activate: !opts.background })
    return tab
  }

  /** Resolve omnibox input and open it in a new tab. */
  openInput(
    input: string,
    opts: Pick<Parameters<TabManager['createTab']>[0], 'background' | 'spaceId' | 'pinned' | 'index' | 'beforeLoad'> = {}
  ): TabData | null {
    const resolved = resolveInput(input, searchTemplate(this.deps.settings.get()))
    if (!resolved) return null
    return this.createTab({ ...opts, url: resolved.url, typed: true })
  }

  navigate(tabId: TabId, input: string): void {
    const tab = this.model.getTab(tabId)
    const resolved = resolveInput(input, searchTemplate(this.deps.settings.get()))
    if (!tab || !resolved) return
    this.navigateTo(tab, resolved.url, true)
  }

  navigateTo(tab: TabData, url: string, typed: boolean): void {
    if (isInternalUrl(url)) {
      const rt = this.runtimes.get(tab.id)
      if (rt) this.retireRuntime(tab.id, rt)
      this.model.updateTab(tab.id, { url, title: '', favicon: null, error: null, crashed: false, live: false, navState: null })
      return
    }
    const rt = this.runtimes.get(tab.id) ?? this.spawnRuntime(tab)
    rt.loadUrl(url, typed)
    this.model.updateTab(tab.id, { url, error: null, crashed: false })
  }

  activateTab(tabId: TabId): void {
    this.model.activateTab(tabId)
  }

  /** Close a tab. A folder tab is a bookmark: it unloads and returns to its saved page instead. */
  closeTab(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (!tab) return
    if (isSavedTab(tab)) this.resetSavedTab(tab)
    else this.deleteTab(tabId)
  }

  /** Remove a tab for good (for folder tabs too). It can be brought back with reopen. */
  deleteTab(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (!tab) return
    const space = this.model.getSpace(tab.spaceId)!
    const rt = this.runtimes.get(tabId)
    const closed: ClosedTab = {
      spaceId: tab.spaceId,
      pinned: tab.pinned,
      folderId: tab.folderId,
      savedUrl: tab.savedUrl,
      savedTitle: tab.savedTitle,
      index: this.model.sortOrderOf(tab),
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      navState: (rt && rt.snapshot()) ?? tab.navState
    }
    this.pushClosed(closed)
    const wasActive = space.activeTabId === tabId
    this.findText.delete(tabId)
    this.model.removeTab(tabId)
    if (rt) {
      this.runtimes.delete(tabId)
      this.closing.set(tabId, { tab, closed, wasActive, rt })
      rt.close()
    }
  }

  closeOtherTabs(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (!tab) return
    const space = this.model.getSpace(tab.spaceId)!
    for (const id of [...space.tabIds]) if (id !== tabId) this.closeTab(id)
  }

  closeTabsBelow(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (!tab) return
    const order = this.model.orderedTabIds(tab.spaceId)
    for (const id of order.slice(order.indexOf(tabId) + 1)) {
      if (!this.model.getTab(id)?.pinned) this.closeTab(id)
    }
  }

  /** Whether there is a closed tab to bring back. */
  canReopen(): boolean {
    return this.closedTabs.length > 0
  }

  /** The system print dialog for a page (internal pages have nothing to print). */
  print(tabId: TabId): void {
    this.runtimes.get(tabId)?.wc.print({}, () => undefined)
  }

  reopenClosedTab(): void {
    const closed = this.closedTabs.pop()
    if (!closed) return
    const spaceId = this.model.getSpace(closed.spaceId) ? closed.spaceId : this.model.activeSpaceId
    // A saved tab goes back to its folder, or to the top level if the folder is gone.
    const saved = closed.savedUrl !== ''
    const inFolder = closed.folderId !== null && this.model.getFolder(closed.folderId)?.spaceId === spaceId
    const tab = newTabData({
      spaceId,
      url: closed.url,
      title: closed.title,
      favicon: closed.favicon,
      pinned: closed.pinned,
      navState: closed.navState,
      ...(saved
        ? {
            folderId: inFolder && !closed.pinned ? closed.folderId : null,
            savedUrl: closed.savedUrl,
            savedTitle: closed.savedTitle
          }
        : {})
    })
    if (!isInternalUrl(tab.url)) this.spawnRuntime(tab).load(tab)
    this.model.addTab(tab, { index: closed.index, activate: true })
  }

  duplicateTab(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (!tab) return
    const rt = this.runtimes.get(tabId)
    const copy = newTabData({
      spaceId: tab.spaceId,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      pinned: false,
      navState: (rt && rt.snapshot()) ?? tab.navState
    })
    if (!isInternalUrl(copy.url)) this.spawnRuntime(copy).load(copy)
    const index = tab.pinned || isSavedTab(tab) ? 0 : this.model.sortOrderOf(tab) + 1
    this.model.addTab(copy, { index, activate: true })
  }

  moveTab(tabId: TabId, target: MoveTabOptions): void {
    this.model.moveTab(tabId, target)
  }

  /**
   * Add a tab without loading or selecting it (imports). A saved tab
   * (`saved` or a `folderId`) keeps `url` as its saved page.
   */
  addUnloadedTab(init: {
    spaceId: SpaceId
    url: string
    title: string
    pinned?: boolean
    saved?: boolean
    folderId?: FolderId | null
  }): TabId {
    const pinned = init.pinned === true && !init.saved && !init.folderId
    const saved = init.saved === true || !!init.folderId || pinned
    const tab = newTabData({
      spaceId: init.spaceId,
      url: init.url,
      title: init.title,
      pinned,
      folderId: init.folderId ?? null,
      savedUrl: saved ? init.url : '',
      savedTitle: saved ? init.title : ''
    })
    this.model.addTab(tab, { select: false })
    return tab.id
  }

  /**
   * Fetch `<origin>/favicon.ico` for tabs that have no icon yet (imported
   * bookmarks that were never loaded here), a few origins at a time. Pages
   * replace it with their real icon once they load.
   */
  async prefetchFavicons(tabIds: readonly TabId[]): Promise<void> {
    const byOrigin = new Map<string, TabId[]>()
    for (const id of tabIds) {
      const tab = this.model.getTab(id)
      if (!tab || tab.favicon) continue
      let origin: string
      try {
        const url = new URL(tab.url)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
        origin = url.origin
      } catch {
        continue
      }
      byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), id])
    }
    const queue = [...byOrigin]
    const session = this.deps.profiles.sessionFor(DEFAULT_PROFILE_ID)
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [origin, ids] = next
        const icon = `${origin}/favicon.ico`
        if (!(await this.deps.favicons.ensure(icon, session))) continue
        for (const id of ids) {
          if (this.model.getTab(id)?.favicon === null) this.model.updateTab(id, { favicon: icon })
        }
      }
    }
    await Promise.all(Array.from({ length: FAVICON_PREFETCH_CONCURRENCY }, worker))
  }

  /** Save a tab into a folder (appended), or move it there from another folder. */
  saveToFolder(tabId: TabId, folderId: FolderId): void {
    const folder = this.model.getFolder(folderId)
    if (!folder) return
    const tab = this.model.getTab(tabId)
    const index = folder.childIds.filter((id) => id !== tabId).length
    if (tab?.spaceId === folder.spaceId) this.model.moveTab(tabId, { spaceId: folder.spaceId, pinned: false, folderId, index })
  }

  /** Take a tab out of its folder; it stays saved, at the end of the top level. */
  removeFromFolder(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    const space = tab && this.model.getSpace(tab.spaceId)
    if (tab?.folderId && space) {
      this.model.moveTab(tabId, { spaceId: space.id, pinned: false, saved: true, index: space.savedIds.length })
    }
  }

  /**
   * Arc's "Pin Tab" (⌘D): save an open tab at the end of the saved list's top
   * level, or turn a saved tab back into an ordinary tab at the top of the list.
   */
  toggleSaved(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    const space = tab && this.model.getSpace(tab.spaceId)
    // Favorites stay favorites; they leave through "Remove from Favorites".
    if (!tab || !space || tab.pinned) return
    if (isSavedTab(tab)) this.model.moveTab(tabId, { spaceId: space.id, pinned: false, index: 0 })
    else this.model.moveTab(tabId, { spaceId: space.id, pinned: false, saved: true, index: space.savedIds.length })
  }

  /** Navigate a saved tab back to its saved page. */
  backToSaved(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (tab && isSavedTab(tab)) this.navigateTo(tab, tab.savedUrl, false)
  }

  /** Make the page a saved tab currently shows its saved page. */
  updateSaved(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (tab && isSavedTab(tab)) this.model.updateTab(tabId, { savedUrl: tab.url, savedTitle: tab.title })
  }

  togglePinned(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (!tab) return
    const space = this.model.getSpace(tab.spaceId)!
    this.model.moveTab(tabId, {
      spaceId: tab.spaceId,
      pinned: !tab.pinned,
      index: tab.pinned ? 0 : space.pinnedTabIds.length
    })
  }

  moveTabToSpace(tabId: TabId, spaceId: SpaceId): void {
    const tab = this.model.getTab(tabId)
    const space = this.model.getSpace(spaceId)
    if (!tab || !space) return
    this.model.moveTab(tabId, { spaceId, pinned: false, index: space.tabIds.length })
  }

  setMuted(tabId: TabId, muted: boolean): void {
    this.runtimes.get(tabId)?.wc.setAudioMuted(muted)
    this.model.updateTab(tabId, { muted })
  }

  reload(tabId: TabId, ignoreCache = false): void {
    const tab = this.model.getTab(tabId)
    if (!tab || isInternalUrl(tab.url)) return
    const rt = this.runtimes.get(tabId)
    if (!rt) {
      this.spawnRuntime(tab).load(tab)
      return
    }
    this.model.updateTab(tabId, { crashed: false, error: null })
    rt.whenSettled(() => (ignoreCache ? rt.wc.reloadIgnoringCache() : rt.wc.reload()))
  }

  stop(tabId: TabId): void {
    this.runtimes.get(tabId)?.wc.stop()
  }

  goBack(tabId: TabId): void {
    const rt = this.runtimes.get(tabId)
    rt?.whenSettled(() => {
      if (rt.wc.navigationHistory.canGoBack()) rt.wc.navigationHistory.goBack()
    })
  }

  goForward(tabId: TabId): void {
    const rt = this.runtimes.get(tabId)
    rt?.whenSettled(() => {
      if (rt.wc.navigationHistory.canGoForward()) rt.wc.navigationHistory.goForward()
    })
  }

  copyUrl(tabId: TabId): void {
    const tab = this.model.getTab(tabId)
    if (tab) clipboard.writeText(tab.url)
  }

  adjustZoom(tabId: TabId, delta: -1 | 0 | 1): void {
    const rt = this.runtimes.get(tabId)
    if (!rt) return
    const factor = nextZoomFactor(rt.wc.getZoomFactor(), delta)
    rt.wc.setZoomFactor(factor)
    // Chromium zoom is per host; mirror it onto every live tab of that host.
    const host = originOf(rt.wc.getURL())
    for (const other of this.runtimes.values()) {
      if (other === rt || originOf(other.wc.getURL()) === host) {
        this.model.updateTab(other.tabId, { zoomFactor: factor })
      }
    }
    this.deps.zoom.set(rt.wc.getURL(), factor)
  }

  toggleDevTools(tabId: TabId): void {
    const wc = this.runtimes.get(tabId)?.wc
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  }

  // -- find in page ------------------------------------------------------------

  find(tabId: TabId, text: string, forward: boolean, findNext: boolean): void {
    const rt = this.runtimes.get(tabId)
    if (!rt) return
    if (!text) {
      this.stopFind(tabId)
      return
    }
    const previous = this.findText.get(tabId)
    this.findText.set(tabId, text)
    // Electron's `findNext: true` means "start a new find session".
    rt.wc.findInPage(text, { forward, findNext: !findNext || previous !== text, matchCase: false })
  }

  stopFind(tabId: TabId): void {
    this.findText.delete(tabId)
    this.runtimes.get(tabId)?.wc.stopFindInPage('keepSelection')
    this.deps.shell.find(null)
  }

  // -- keyboard navigation -----------------------------------------------------

  selectAdjacent(direction: 1 | -1): void {
    const id = this.model.adjacentTab(direction)
    if (id) this.model.activateTab(id)
  }

  selectIndex(n: number): void {
    const id = this.model.tabAtShortcut(n)
    if (id) this.model.activateTab(id)
  }

  // ---------------------------------------------------------------------------
  // Spaces
  // ---------------------------------------------------------------------------

  createSpace(input: SpaceInput): SpaceId {
    const id = randomUUID()
    this.model.addSpace({
      id,
      name: input.name.slice(0, LIMITS.spaceName) || translate(this.deps.settings.get().language, 'space.untitled'),
      icon: input.icon.slice(0, LIMITS.spaceIcon) || '•',
      color: input.color,
      theme: sanitizeSpaceTheme(input.theme),
      profileId: DEFAULT_PROFILE_ID,
      pinnedTabIds: [],
      savedIds: [],
      tabIds: [],
      activeTabId: null,
      createdAt: Date.now()
    })
    return id
  }

  updateSpace(id: SpaceId, input: Partial<SpaceInput>): void {
    const patch: Partial<Pick<SpaceData, 'name' | 'icon' | 'color' | 'theme'>> = {}
    if (input.name !== undefined) {
      patch.name = input.name.slice(0, LIMITS.spaceName) || translate(this.deps.settings.get().language, 'space.untitled')
    }
    if (input.icon !== undefined) patch.icon = input.icon.slice(0, LIMITS.spaceIcon) || '•'
    if (input.color !== undefined) patch.color = input.color
    const current = this.model.getSpace(id)
    if (input.theme !== undefined && current) {
      // A partial theme is merged over the current one; unchanged themes are not re-sent.
      const theme = sanitizeSpaceTheme({ ...current.theme, ...input.theme }, current.theme)
      if (!themesEqual(theme, current.theme)) patch.theme = theme
    }
    if (Object.keys(patch).length > 0) this.model.updateSpace(id, patch)
  }

  /**
   * Space names still equal to a built-in default ("Personal", "New Space" in
   * any language) were never chosen by the user, so they follow the UI language.
   */
  relocalizeSpaceNames(locale: Locale): void {
    for (const key of ['space.defaultName', 'space.untitled'] as const) {
      const names = new Set(LOCALES.map((l) => translate(l.id, key)))
      const name = translate(locale, key)
      for (const space of this.model.spaces.values()) {
        if (space.name !== name && names.has(space.name)) this.model.updateSpace(space.id, { name })
      }
    }
  }

  deleteSpace(id: SpaceId): void {
    const removed = this.model.removeSpace(id)
    for (const tab of removed) {
      const rt = this.runtimes.get(tab.id)
      if (rt) this.retireRuntime(tab.id, rt, true)
    }
  }

  // ---------------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------------

  createFolder(opts: CreateFolderOptions): FolderId | null {
    const parent = opts.parentId ? this.model.getFolder(opts.parentId) : undefined
    const spaceId = parent?.spaceId ?? (opts.spaceId && this.model.getSpace(opts.spaceId) ? opts.spaceId : this.model.activeSpaceId)
    if (!this.model.getSpace(spaceId)) return null
    const id = randomUUID()
    this.model.addFolder(
      {
        id,
        spaceId,
        parentId: parent?.id ?? null,
        name: this.folderName(opts.name),
        collapsed: false,
        childIds: [],
        createdAt: Date.now()
      },
      opts.index ?? 0
    )
    for (const tabId of opts.tabIds ?? []) this.saveToFolder(tabId, id)
    return id
  }

  renameFolder(id: FolderId, name: string): void {
    this.model.updateFolder(id, { name: this.folderName(name) })
  }

  setFolderCollapsed(id: FolderId, collapsed: boolean): void {
    this.model.updateFolder(id, { collapsed })
  }

  moveFolder(id: FolderId, target: MoveFolderOptions): void {
    this.model.moveFolder(id, target)
  }

  /** Delete a folder with its sub-folders and saved tabs. */
  deleteFolder(id: FolderId): void {
    for (const tab of this.model.removeFolder(id)) {
      this.findText.delete(tab.id)
      const rt = this.runtimes.get(tab.id)
      if (rt) this.retireRuntime(tab.id, rt, true)
    }
  }

  private folderName(name: string | undefined): string {
    return name?.trim().slice(0, LIMITS.folderName) || translate(this.deps.settings.get().language, 'folder.defaultName')
  }

  /** Closing a saved tab: unload it and return it to the saved page; it stays where it is. */
  private resetSavedTab(tab: TabData): void {
    this.model.deactivateTab(tab.id)
    this.findText.delete(tab.id)
    const rt = this.runtimes.get(tab.id)
    if (rt) this.retireRuntime(tab.id, rt)
    this.model.updateTab(tab.id, {
      url: tab.savedUrl || tab.url,
      title: tab.savedTitle || tab.title,
      navState: null,
      live: false,
      loading: false,
      audible: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      error: null
    })
  }

  activateSpace(id: SpaceId): void {
    this.model.setActiveSpace(id)
  }

  switchSpace(direction: 1 | -1): void {
    const id = this.model.adjacentSpace(direction)
    if (id) this.model.setActiveSpace(id)
  }

  // ---------------------------------------------------------------------------
  // Memory management
  // ---------------------------------------------------------------------------

  /**
   * Unload a background tab: keep its back/forward stack, destroy the
   * WebContents. Pages that refuse to unload (beforeunload) stay alive.
   */
  discardTab(tabId: TabId): boolean {
    const tab = this.model.getTab(tabId)
    const rt = this.runtimes.get(tabId)
    if (!tab || !rt || tabId === this.shownTabId) return false
    if (tab.audible || rt.wc.isDevToolsOpened() || rt.wc.isCurrentlyAudible()) return false
    const navState = rt.snapshot()
    this.runtimes.delete(tabId)
    this.discarding.set(tabId, rt)
    this.model.updateTab(tabId, { navState, live: false, loading: false, audible: false })
    rt.close()
    return true
  }

  /** Background tabs ordered from least to most recently used. */
  discardCandidates(): TabData[] {
    const out: TabData[] = []
    for (const id of this.runtimes.keys()) {
      if (id === this.shownTabId) continue
      const tab = this.model.getTab(id)
      // An agent may be in the middle of working in it.
      if (tab && !tab.audible && !tab.agent) out.push(tab)
    }
    return out.sort((a, b) => a.lastActiveAt - b.lastActiveAt)
  }

  /** Stop reacting to WebContents teardown (app is quitting). */
  freeze(): void {
    this.frozen = true
  }

  /**
   * Quitting: close every page now, without beforeunload. Left to Chromium,
   * pages carrying extension content scripts can hold up process exit for
   * many seconds.
   */
  closeAllForQuit(): void {
    const all = [...this.runtimes.values(), ...[...this.closing.values()].map((c) => c.rt), ...this.discarding.values()]
    for (const rt of all) {
      if (!rt.wc.isDestroyed()) rt.close(true)
    }
  }

  /** Capture navigation state of every live tab (before quitting). */
  snapshotAll(): void {
    for (const rt of this.runtimes.values()) {
      const nav = rt.snapshot()
      if (nav) this.model.updateTab(rt.tabId, { navState: nav })
    }
  }

  // ---------------------------------------------------------------------------
  // Presentation
  // ---------------------------------------------------------------------------

  private schedulePresent(): void {
    if (this.presentQueued) return
    this.presentQueued = true
    queueMicrotask(() => {
      this.presentQueued = false
      this.present()
    })
  }

  /** Make the window show whatever the model says is active. */
  present(): void {
    const window = this.window
    if (!window || window.destroyed || this.frozen) return
    const tab = this.model.activeTab()
    let rt: TabRuntime | undefined
    if (tab && !isInternalUrl(tab.url)) {
      rt = this.runtimes.get(tab.id)
      if (!rt) {
        rt = this.spawnRuntime(tab)
        rt.load(tab)
      }
    }
    window.showPage(tab && rt && tabPresentsView(tab) ? rt.view : null)

    const nextId = tab?.id ?? null
    if (nextId !== this.shownTabId) {
      const previous = this.shownTabId ? this.model.getTab(this.shownTabId) : undefined
      if (previous) this.model.updateTab(previous.id, { lastActiveAt: Date.now() })
      if (this.shownTabId) this.stopFind(this.shownTabId)
      this.shownTabId = nextId
      this.delegate?.activeChanged(rt?.wc ?? null)
      if (!window.isOverlayOpen) window.focusPage()
    }
  }

  // ---------------------------------------------------------------------------
  // Runtime lifecycle
  // ---------------------------------------------------------------------------

  private spawnRuntime(tab: TabData, adopt?: { webContents: WebContents; webPreferences?: Electron.WebPreferences }): TabRuntime {
    const session = this.deps.profiles.sessionFor(this.model.getSpace(tab.spaceId)?.profileId ?? 'default')
    const rt = new TabRuntime(tab.id, session, this, adopt)
    this.runtimes.set(tab.id, rt)
    this.byWebContents.set(rt.wc.id, tab.id)
    tab.live = true
    if (this.model.getTab(tab.id)) this.model.updateTab(tab.id, { live: true, crashed: false })
    if (tab.muted) rt.wc.setAudioMuted(true)
    this.delegate?.runtimeCreated(tab, rt.wc)
    return rt
  }

  /** Destroy a runtime without removing its tab (navigating to an internal page, space deletion). */
  private retireRuntime(tabId: TabId, rt: TabRuntime, force = false): void {
    this.runtimes.delete(tabId)
    this.discarding.set(tabId, rt)
    rt.close(force)
  }

  private pushClosed(closed: ClosedTab): void {
    if (closed.url === 'about:blank' && !closed.navState) return
    this.closedTabs.push(closed)
    this.lastClosedAt = Date.now()
    if (this.closedTabs.length > LIMITS.closedTabs) this.closedTabs.shift()
  }

  // ---------------------------------------------------------------------------
  // TabRuntimeHost
  // ---------------------------------------------------------------------------

  update(tabId: TabId, patch: Partial<TabData>): void {
    if (!this.frozen && this.runtimes.has(tabId)) this.model.updateTab(tabId, patch)
  }

  navigated(tabId: TabId, url: string, typed: boolean, sameDocument: boolean): void {
    const tab = this.model.getTab(tabId)
    if (!tab) return
    if (!sameDocument) {
      const rt = this.runtimes.get(tabId)
      const stored = this.deps.zoom.get(url)
      if (rt && Math.abs(rt.wc.getZoomFactor() - stored) > 0.001) rt.wc.setZoomFactor(stored)
      if (tab.zoomFactor !== stored) this.model.updateTab(tabId, { zoomFactor: stored })
      if (tab.favicon && originOf(tab.favicon) !== originOf(url) && !this.deps.favicons.has(tab.favicon)) {
        this.model.updateTab(tabId, { favicon: null })
      }
    }
    this.deps.history.recordVisit(url, sameDocument ? tab.title : '', typed)
  }

  titleChanged(tabId: TabId, url: string, title: string): void {
    this.deps.history.updateTitle(url, title)
    const tab = this.model.getTab(tabId)
    if (tab && isSavedTab(tab) && !tab.savedTitle && title && url === tab.savedUrl) this.model.updateTab(tabId, { savedTitle: title })
  }

  faviconsChanged(tabId: TabId, urls: string[]): void {
    const url = urls.find((u) => /^(https?|data):/.test(u))
    const tab = this.model.getTab(tabId)
    if (!url || !tab) return
    // The page the icon belongs to; the tab may move on while it downloads.
    const page = tab.url
    if (this.deps.favicons.has(url)) {
      this.model.updateTab(tabId, { favicon: url })
      this.deps.history.updateFavicon(page, url)
      return
    }
    const session = this.runtimes.get(tabId)?.wc.session
    if (!session) return
    void this.deps.favicons.ensure(url, session).then((ok) => {
      if (!ok) return
      this.model.updateTab(tabId, { favicon: url })
      this.deps.history.updateFavicon(page, url)
    })
  }

  windowOpen(tabId: TabId, details: HandlerDetails): WindowOpenHandlerResponse {
    const { url, disposition } = details
    if (!OPENABLE_SCHEMES.test(url)) return { action: 'deny' }
    const opener = this.model.getTab(tabId)
    if (!opener) return { action: 'deny' }
    if (disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: popupOptions(details.features) }
    }
    const background = disposition === 'background-tab'
    return {
      action: 'allow',
      // Electron destroys children with their opener by default; a tab must
      // survive its opener being closed or unloaded.
      outlivesOpener: true,
      createWindow: (options) => this.adoptOpenedWindow(opener, url, options, background)
    }
  }

  /** Turn a `window.open` / target=_blank child into a tab, keeping its opener. */
  private adoptOpenedWindow(
    opener: TabData,
    url: string,
    options: BrowserWindowConstructorOptions,
    background: boolean
  ): WebContents {
    const tab = newTabData({ spaceId: opener.spaceId, url })
    const guest = (options as { webContents?: WebContents }).webContents
    const rt = guest
      ? this.spawnRuntime(tab, { webContents: guest, webPreferences: options.webPreferences })
      : this.spawnRuntime(tab)
    if (!guest) rt.loadUrl(url)
    const index = opener.pinned ? 0 : this.model.sortOrderOf(opener) + 1
    this.model.addTab(tab, { index, activate: !background })
    return rt.wc
  }

  contextMenu(tabId: TabId, params: ContextMenuParams): void {
    const tab = this.model.getTab(tabId)
    const rt = this.runtimes.get(tabId)
    if (tab && rt) this.delegate?.contextMenu(tab, rt.wc, params)
  }

  beforeInput(tabId: TabId, event: ElectronEvent, input: Input): void {
    this.delegate?.beforeInput(tabId, event, input)
  }

  foundInPage(tabId: TabId, result: FoundInPageResult): void {
    const text = this.findText.get(tabId)
    if (text === undefined) return
    this.deps.shell.find({ tabId, text, activeMatch: result.activeMatchOrdinal, matches: result.matches })
  }

  htmlFullscreen(tabId: TabId, on: boolean): void {
    if (tabId === this.shownTabId || !on) this.delegate?.htmlFullscreen(on)
  }

  zoomWheel(tabId: TabId, direction: 'in' | 'out'): void {
    this.adjustZoom(tabId, direction === 'in' ? 1 : -1)
  }

  popupCreated(window: Electron.BrowserWindow): void {
    this.delegate?.popupCreated(window)
  }

  preventedUnload(tabId: TabId): void {
    const closing = this.closing.get(tabId)
    const discarding = this.discarding.get(tabId)
    if (discarding) {
      // The page has unsaved state: keep it alive instead of discarding.
      this.discarding.delete(tabId)
      discarding.cancelClose()
      this.runtimes.set(tabId, discarding)
      if (this.model.getTab(tabId)) this.model.updateTab(tabId, { live: true, navState: null })
      return
    }
    const tab = closing?.tab ?? this.model.getTab(tabId)
    const rt = closing?.rt ?? this.runtimes.get(tabId)
    if (!tab || !rt || !this.delegate) return
    void this.delegate.confirmLeave(tab).then((leave) => {
      if (closing) {
        if (leave) {
          rt.close(true)
        } else {
          this.reviveClosing(tabId)
        }
      } else if (leave) {
        rt.allowUnloadOnce = true
        rt.wc.reload()
      }
    })
  }

  private reviveClosing(tabId: TabId): void {
    const entry = this.closing.get(tabId)
    if (!entry) return
    this.closing.delete(tabId)
    entry.rt.cancelClose()
    const idx = this.closedTabs.lastIndexOf(entry.closed)
    if (idx >= 0) this.closedTabs.splice(idx, 1)
    const spaceId = this.model.getSpace(entry.tab.spaceId) ? entry.tab.spaceId : this.model.activeSpaceId
    const tab: TabData = { ...entry.tab, spaceId, live: true }
    this.runtimes.set(tabId, entry.rt)
    this.model.addTab(tab, { index: entry.closed.index, activate: entry.wasActive })
  }

  destroyed(tabId: TabId): void {
    if (this.frozen) return
    const closing = this.closing.get(tabId)
    const discarding = this.discarding.get(tabId)
    const rt = closing?.rt ?? discarding ?? this.runtimes.get(tabId)
    if (rt) {
      this.byWebContents.delete(rt.wc.id)
      this.delegate?.runtimeDestroyed(rt.wc)
    }
    if (closing) {
      this.closing.delete(tabId)
      return
    }
    if (discarding) {
      this.discarding.delete(tabId)
      return
    }
    // The page closed itself (window.close() on a script-opened tab).
    if (rt && this.runtimes.get(tabId) === rt) {
      this.runtimes.delete(tabId)
      if (this.model.getTab(tabId)) {
        this.model.updateTab(tabId, { live: false })
        this.model.removeTab(tabId)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Model → shell / persistence / presentation
  // ---------------------------------------------------------------------------

  private modelListener(): ModelListener {
    const { shell, persister } = this.deps
    const activeSpace = () => this.model.activeSpaceId
    return {
      tabAdded: (tab) => {
        shell.tab(tab.id, toTabState(tab), true)
        persister.markTab(tab.id)
      },
      tabUpdated: (id, patch) => {
        shell.tab(id, stateOnly(patch))
        let persist = false
        let presentation = false
        for (const key in patch) {
          if (PERSISTED_TAB_FIELDS.has(key as keyof TabData)) persist = true
          if (PRESENTATION_FIELDS.has(key as keyof TabData)) presentation = true
        }
        if (persist) persister.markTab(id)
        if (presentation && this.model.activeTab()?.id === id) this.schedulePresent()
      },
      tabRemoved: (tab) => {
        shell.tab(tab.id, null)
        persister.removeTab(tab.id)
        this.delegate?.tabRemoved?.(tab.id)
      },
      spaceAdded: (space) => {
        shell.space(space.id, { ...space }, true)
        persister.markSpace(space.id)
      },
      spaceUpdated: (id, patch) => {
        shell.space(id, patch)
        persister.markSpace(id)
        for (const list of [patch.tabIds, patch.pinnedTabIds]) {
          if (list) for (const tabId of list) persister.markTab(tabId)
        }
        // The saved list's top level mixes folders and tabs; sort order is the index here.
        for (const itemId of patch.savedIds ?? []) {
          if (this.model.getFolder(itemId)) persister.markFolder(itemId)
          else persister.markTab(itemId)
        }
        if ('activeTabId' in patch && id === activeSpace()) this.schedulePresent()
        if (('color' in patch || 'theme' in patch) && id === activeSpace()) this.delegate?.activeThemeChanged?.()
      },
      spaceRemoved: (id) => {
        shell.space(id, null)
        persister.removeSpace(id)
      },
      spaceOrderChanged: (order) => {
        shell.spaceOrder(order)
        for (const id of order) persister.markSpace(id)
      },
      folderAdded: (folder) => {
        shell.folder(folder.id, toFolderState(folder), true)
        persister.markFolder(folder.id)
      },
      folderUpdated: (id, patch) => {
        const { createdAt: _c, ...state } = patch
        shell.folder(id, state)
        persister.markFolder(id)
        // Children mix tabs and folders; their sort order is their index here.
        for (const child of patch.childIds ?? []) {
          if (this.model.getFolder(child)) persister.markFolder(child)
          else persister.markTab(child)
        }
      },
      folderRemoved: (folder) => {
        shell.folder(folder.id, null)
        persister.removeFolder(folder.id)
      },
      activeSpaceChanged: (id) => {
        shell.window({ activeSpaceId: id })
        persister.setSetting('session.activeSpaceId', id)
        this.schedulePresent()
        this.delegate?.activeThemeChanged?.()
      }
    }
  }
}

