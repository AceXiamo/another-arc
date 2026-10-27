import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
  screen,
  session,
  webContents,
  WebContentsView,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { agentSnippet, agentUrl, type AgentInfo, type AgentSnippet } from '@shared/agent'
import { DEFAULT_PROFILE_ID, DEFAULT_SPACE, DEFAULT_WINDOW_STATE } from '@shared/defaults'
import type { ImportableBrowser, ImportBrowser } from '@shared/ext-import'
import { chromeColor } from '@shared/theme'
import { clampSidebarWidth, FLIGHT_FRAME, SURFACE_FRAME_PREFIX, surfaceBounds, SURFACES, type Rect, type SurfaceId } from '@shared/layout'
import type { ShellSnapshot, WindowState } from '@shared/types'
import { translator, type Translate } from '@shared/i18n'
import { buildSearchUrl, internalUrl, SEARCH_ENGINES, searchTemplate, type InternalPage } from '@shared/url'
import type { AgentService } from '../agent/agent-service'
import { DownloadManager } from '../downloads/download-manager'
import { PasswordManager } from '../passwords/password-manager'
import { PasswordStore } from '../passwords/password-store'
import { ExtensionManager } from '../extensions/extension-manager'
import { WebStore } from '../extensions/web-store'
import { FaviconCache } from '../history/favicon-cache'
import { HistoryService } from '../history/history-service'
import { RpcRouter } from '../ipc/router'
import { registerHandlers } from '../ipc/handlers'
import { showPageContextMenu } from '../navigation/context-menu'
import { Database } from '../persistence/database'
import { Persister } from '../persistence/persister'
import { SessionStore } from '../persistence/session-store'
import { PermissionManager } from '../permissions/permission-manager'
import { ProfileManager } from '../profiles/profile-manager'
import { SettingsService } from '../settings/settings-service'
import type { CommandId } from '../shortcuts/commands'
import { isReservedKeyUp, reservedCommandFor } from '../shortcuts/keymap'
import { buildAppMenu } from '../shortcuts/menu'
import { decideUndo, isEditingText, isTyping } from '../shortcuts/undo'
import {
  bestImportCandidate,
  importFromBrowser,
  isFreshProfile,
  scanImportable,
  type ImportHost
} from '../import/import-flow'
import { TabDiscarder } from '../tabs/discarder'
import { PageDialogs } from '../tabs/page-dialogs'
import { TabManager } from '../tabs/tab-manager'
import { ZOOM_SETTINGS_KEY, ZoomStore } from '../tabs/zoom'
import { BrowserWindowController } from '../windows/browser-window'
import { ShellSync } from '../windows/shell-sync'
import { isDev, outPath, rendererDevUrl, userDataPath } from './environment'
import { mark, startupMarks } from './perf'
import { handleAppProtocols, SHELL_ORIGIN, shellUrl } from './protocols'

const ARC_IMPORT_OFFERED_KEY = 'import.arcOffered'
const AGENT_TOKEN_KEY = 'agent.token'
/** Let the window paint before asking. */
const ARC_IMPORT_OFFER_DELAY_MS = 600

interface StoredBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Composition root: owns every service and wires them together. */
export class Browser {
  readonly db: Database
  readonly store: SessionStore
  readonly persister: Persister
  readonly settings: SettingsService
  readonly profiles: ProfileManager
  readonly history: HistoryService
  readonly favicons: FaviconCache
  readonly zoom: ZoomStore
  readonly shell = new ShellSync()
  readonly tabs: TabManager
  readonly downloads: DownloadManager
  readonly passwords: PasswordManager
  readonly permissions: PermissionManager
  readonly dialogs: PageDialogs
  readonly extensions: ExtensionManager
  readonly discarder: TabDiscarder
  readonly router: RpcRouter
  window: BrowserWindowController | null = null

  private windowState: WindowState
  private readonly certExceptions = new Set<string>()
  private enteredFullscreenForHtml = false
  private shellReady = false
  private quitting = false
  private shutDown = false
  private readonly pendingUrls: string[] = []
  /** Visibility requested before the surface's view finished being created. */
  private readonly pendingSurfaces = new Map<SurfaceId, boolean>()
  /** Where the shell last placed the site controls (window coordinates). */
  private sitePanelBounds: Rect = { x: 0, y: 0, width: SURFACES.sitePanel.width, height: SURFACES.sitePanel.height }
  /** The one-time "Import from Arc?" offer was already shown on this profile. */
  private arcImportOffered = false
  /** When a key was last typed anywhere in the app (for ⌘Z). */
  private lastTypedAt = 0
  private recordingShortcut = false
  private flightLayer: BrowserWindow | null = null
  /** Last native window background set (see syncWindowBackground). */
  private windowColor = ''
  /** Agents (MCP): loaded the first time they are turned on. */
  private agent: AgentService | null = null
  private agentToken: string
  /** Starts and stops run one after another, however fast the toggle flips. */
  private agentSync: Promise<void> = Promise.resolve()

  constructor() {
    this.db = new Database(userDataPath('browser.db'))
    this.store = new SessionStore(this.db)
    this.persister = new Persister(this.db, this.store)
    const stored = this.store.loadSettings()
    this.settings = new SettingsService(stored, this.persister)
    this.profiles = new ProfileManager(this.store)
    this.history = new HistoryService(this.db)
    this.favicons = new FaviconCache(this.db)
    this.zoom = new ZoomStore(stored.get(ZOOM_SETTINGS_KEY), this.persister)
    this.persister.addFlusher(() => this.history.flush())

    this.tabs = new TabManager({
      profiles: this.profiles,
      persister: this.persister,
      shell: this.shell,
      history: this.history,
      favicons: this.favicons,
      settings: this.settings,
      zoom: this.zoom
    })
    this.persister.attach(this.tabs)

    this.downloads = new DownloadManager(this.db, this.shell, this.settings)
    this.passwords = new PasswordManager(new PasswordStore(this.db), {
      tabIdFor: (wc) => this.tabs.tabIdFor(wc) ?? null,
      setDropdownVisible: (visible) => {
        if (!visible) this.shell.command({ type: 'autofill', entries: null, active: -1, above: false })
        this.setSurfaceVisible('autofill', visible)
      },
      showEntries: (entries, active, above) => this.shell.command({ type: 'autofill', entries, active, above }),
      reposition: () => this.window?.repositionSurface('autofill'),
      dropdownFocused: () => this.window?.getSurface('autofill')?.view.webContents.isFocused() ?? false,
      offerToSave: (origin, username) => this.shell.command({ type: 'password.offerSave', origin, username })
    })
    this.passwords.attach()
    this.permissions = new PermissionManager(this.db, {
      tabIdFor: (wc) => this.tabs.tabIdFor(wc),
      promptsChanged: (prompts) => {
        this.shell.permissionPrompts(prompts)
        // Prompts live in the sidebar; make sure it is visible.
        if (prompts.length > 0 && this.windowState.sidebarCollapsed) this.setSidebar({ collapsed: false })
      }
    })
    this.dialogs = new PageDialogs({
      tabIdFor: (wc) => this.tabs.tabIdFor(wc),
      isShown: (wc) => this.window?.currentPage?.webContents === wc,
      heldForAgent: (wc) => this.agent?.drives(wc) ?? false,
      changed: (dialogs) => this.shell.pageDialogs(dialogs)
    })
    this.profiles.setSessionInitializer((_profile, ses) => {
      this.permissions.attach(ses)
      this.downloads.attach(ses)
    })
    this.downloads.setStartListener((state, asked) => this.downloadStarted(state.id, state.filename, state.mimeType, asked))

    const profileSession = this.profiles.defaultSession()
    const browser = this
    this.extensions = new ExtensionManager(
      this.store,
      profileSession,
      this.profiles.get('default').partition,
      app.getPath('userData'),
      outPath('preload', 'extension-compat.cjs'),
      {
        tabs: this.tabs,
        window: () => this.window,
        shell: this.shell,
        confirm: (message, detail) => this.confirm(message, detail),
        get t() {
          return browser.t
        }
      }
    )
    // The Chrome Web Store's install buttons (answers its pages over IPC).
    new WebStore({
      extensions: this.extensions,
      session: profileSession,
      isTab: (wc) => this.tabs.tabIdFor(wc) !== undefined,
      window: () => this.window?.win ?? null,
      confirm: (message, detail) => this.confirm(message, detail),
      toast: (message) => this.shell.command({ type: 'toast', message }),
      get t() {
        return browser.t
      }
    })
    this.discarder = new TabDiscarder(this.tabs, this.settings)

    this.arcImportOffered = stored.get(ARC_IMPORT_OFFERED_KEY) === true
    const token = stored.get(AGENT_TOKEN_KEY)
    this.agentToken = typeof token === 'string' ? token : ''
    const layout = (stored.get('window.layout') ?? {}) as Partial<WindowState>
    this.windowState = {
      ...DEFAULT_WINDOW_STATE,
      activeSpaceId: '',
      sidebarWidth: clampSidebarWidth(layout.sidebarWidth ?? DEFAULT_WINDOW_STATE.sidebarWidth),
      sidebarCollapsed: layout.sidebarCollapsed === true
    }

    this.tabs.restore(
      this.store.loadSpaces(),
      this.store.loadTabs(),
      (stored.get('session.activeSpaceId') as string | undefined) ?? null,
      this.store.loadFolders()
    )
    this.windowState.activeSpaceId = this.tabs.model.activeSpaceId

    this.settings.onChange((patch) => {
      this.shell.settings(patch)
      if (patch.theme) nativeTheme.themeSource = patch.theme
      if (patch.language) {
        this.installMenu()
        this.tabs.relocalizeSpaceNames(patch.language)
      }
      if (patch.agentEnabled !== undefined || patch.agentPort !== undefined) this.syncAgent()
    })
    // Pages follow the browser theme through prefers-color-scheme.
    nativeTheme.themeSource = this.settings.get().theme
    nativeTheme.on('updated', () => this.syncWindowBackground())

    this.wireDelegates()
    this.router = new RpcRouter((event) => this.isTrustedSender(event))
    registerHandlers(this.router, this)
    this.router.install()
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    // Packaged builds get the icon from the bundle; dev runs borrow it here.
    const devIcon = join(app.getAppPath(), 'resources', 'icon.png')
    if (!app.isPackaged && existsSync(devIcon)) app.dock?.setIcon(devIcon)
    handleAppProtocols(
      this.favicons,
      (request) => this.extensions.handleIconRequest(request),
      () => this.profiles.sessionFor(DEFAULT_PROFILE_ID)
    )
    hardenDefaultSession()
    this.installMenu()

    mark('browser-constructed')
    const window = this.createWindow()
    mark('window-created')
    window.shellContents.once('did-finish-load', () => mark('shell-loaded'))
    // Extensions must be registered before the first page loads so their
    // content scripts apply; this overlaps with the shell booting.
    const extensionsReady = this.extensions.init().catch((error) => console.error('[extensions]', error))
    void window.shellContents.loadURL(shellUrl(rendererDevUrl))
    await extensionsReady
    mark('extensions-ready')
    this.tabs.attachWindow(window)
    const first = window.currentPage?.webContents
    if (first) first.once('did-finish-load', () => mark('first-page-loaded'))
    else mark('first-page-loaded')
    for (const url of this.pendingUrls.splice(0)) this.openExternalUrl(url)

    setTimeout(() => {
      if (!window.win.isDestroyed() && !window.win.isVisible()) this.revealWindow(window)
    }, 500).unref()

    this.discarder.start()
    this.syncAgent()
    // Housekeeping once the UI is up.
    setTimeout(() => {
      this.history.store.prune(180)
      this.favicons.prune()
    }, 30_000).unref()
  }

  private createWindow(): BrowserWindowController {
    const bounds = this.store.loadSettings().get('window.bounds') as StoredBounds | undefined
    const window = new BrowserWindowController({
      bounds: bounds ?? null,
      layout: {
        sidebarWidth: this.windowState.sidebarWidth,
        sidebarCollapsed: this.windowState.sidebarCollapsed,
        htmlFullscreen: false
      },
      preload: outPath('preload', 'shell.cjs'),
      backgroundColor: (this.windowColor = this.windowBackground()),
      devTools: true
    })
    this.window = window
    this.shell.attach(window.shellContents)
    this.wireShell(window)
    this.syncTrafficLights()

    const saveBounds = () => {
      if (window.win.isDestroyed() || window.win.isFullScreen() || window.win.isMinimized()) return
      this.persister.setSetting('window.bounds', window.win.getNormalBounds())
    }
    window.win.on('resized', saveBounds)
    window.win.on('moved', saveBounds)
    window.win.on('enter-full-screen', () => this.patchWindow({ fullscreen: true }))
    window.win.on('leave-full-screen', () => {
      this.enteredFullscreenForHtml = false
      this.patchWindow({ fullscreen: false })
    })
    window.win.on('focus', () => this.patchWindow({ focused: true }))
    window.win.on('blur', () => this.patchWindow({ focused: false }))
    window.win.on('close', (event) => {
      saveBounds()
      if (!this.quitting) {
        // Closing the window keeps the session alive; the dock icon brings it back.
        event.preventDefault()
        if (window.win.isFullScreen()) {
          window.win.once('leave-full-screen', () => window.win.hide())
          window.win.setFullScreen(false)
        } else {
          window.win.hide()
        }
      }
    })
    return window
  }

  private wireShell(window: BrowserWindowController): void {
    const wc = window.shellContents
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('before-input-event', (event, input) => this.handleReservedKeys(event, input))
    wc.on('render-process-gone', (_e, details) => {
      console.error('[shell] renderer gone', details.reason)
      if (!this.quitting) setTimeout(() => wc.reload(), 300)
    })
    wc.setWindowOpenHandler((details) => {
      if (details.url === 'about:blank' && details.frameName === FLIGHT_FRAME) {
        return { action: 'allow', createWindow: (options) => this.createFlightLayer(window, options) }
      }
      if (details.url === 'about:blank' && details.frameName.startsWith(SURFACE_FRAME_PREFIX)) {
        const id = details.frameName.slice(SURFACE_FRAME_PREFIX.length) as SurfaceId
        if (!(id in SURFACES)) return { action: 'deny' }
        return {
          action: 'allow',
          createWindow: (options) => this.createSurface(window, id, options)
        }
      }
      // Links clicked inside internal pages open as normal tabs.
      if (/^https?:|^chrome-extension:/.test(details.url)) this.tabs.createTab({ url: details.url })
      return { action: 'deny' }
    })
  }

  /**
   * The flight layer (see FLIGHT_FRAME): a child window, unlike the surfaces,
   * because only a window can let clicks through. Lives in the shell's
   * renderer like them; hidden until a flight starts.
   */
  private createFlightLayer(window: BrowserWindowController, options: Electron.BrowserWindowConstructorOptions): WebContents {
    const layer = new BrowserWindow({
      ...options,
      parent: window.win,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      roundedCorners: false
    })
    layer.setIgnoreMouseEvents(true)
    this.flightLayer = layer
    layer.on('closed', () => {
      if (this.flightLayer === layer) this.flightLayer = null
    })
    return layer.webContents
  }

  setFlightLayerVisible(visible: boolean): void {
    const layer = this.flightLayer
    const win = this.window?.win
    if (!layer || layer.isDestroyed() || !win || win.isDestroyed()) return
    if (!visible) {
      layer.hide()
      return
    }
    layer.setBounds(win.getContentBounds())
    if (!layer.isVisible()) layer.showInactive()
  }

  /** Tell the shell, with where the pointer is, so the file can fly from there. */
  private downloadStarted(id: string, filename: string, mimeType: string | undefined, asked: boolean): void {
    const win = this.window?.win
    let from: { x: number; y: number } | null = null
    if (win && !win.isDestroyed() && win.isVisible() && !asked) {
      const p = screen.getCursorScreenPoint()
      const b = win.getContentBounds()
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) from = { x: p.x - b.x, y: p.y - b.y }
    }
    this.shell.command({ type: 'download.started', id, filename, mimeType, from })
  }

  /** Adopt a shell-opened child window as a floating surface view. */
  private createSurface(window: BrowserWindowController, id: SurfaceId, options: Electron.BrowserWindowConstructorOptions): WebContents {
    const guest = (options as { webContents?: WebContents }).webContents
    const view = new WebContentsView(guest ? { webContents: guest } : { webPreferences: options.webPreferences })
    view.setBackgroundColor('#00000000')
    const visible = this.pendingSurfaces.get(id) ?? false
    this.pendingSurfaces.delete(id)
    const place =
      id === 'autofill'
        ? (card: Rect) => this.passwords.place(card)
        : id === 'sitePanel'
          ? () => this.sitePanelBounds
          : (card: Rect) => surfaceBounds(id, card)
    window.addSurface(id, { view, visible, place, topmost: id === 'sitePanel' })
    if (id === 'sitePanel') {
      // A press anywhere else takes the focus: the panel closes, like a menu.
      // (Hiding it moves the focus too, but it is no longer visible then.)
      view.webContents.on('blur', () => {
        if (window.getSurface('sitePanel')?.visible) this.shell.command({ type: 'sitePanel.dismiss' })
      })
    }
    view.webContents.on('before-input-event', (event, input) => this.handleReservedKeys(event, input))
    if (visible && SURFACES[id].takesFocus) setImmediate(() => view.webContents.focus())
    return view.webContents
  }

  // ---------------------------------------------------------------------------
  // Shell state
  // ---------------------------------------------------------------------------

  snapshot(): ShellSnapshot {
    const t = this.tabs.snapshot()
    return {
      tabs: t.tabs,
      spaces: t.spaces,
      folders: t.folders,
      spaceOrder: t.spaceOrder,
      window: { ...this.windowState, activeSpaceId: t.activeSpaceId },
      settings: this.settings.get(),
      extensions: this.extensions.info(),
      extensionPartition: this.extensions.partition,
      downloads: this.downloads.list(),
      permissionPrompts: this.permissions.prompts(),
      pageDialogs: this.dialogs.list(),
      find: null,
      isDev
    }
  }

  onShellReady(): void {
    const window = this.window
    if (!window) return
    if (!this.shellReady) {
      this.shellReady = true
      mark('shell-first-paint')
      this.revealWindow(window)
      // Tests call offerArcImport() themselves, after stubbing the dialogs.
      if (process.env.ARC_TEST !== '1') setTimeout(() => void this.offerArcImport(), ARC_IMPORT_OFFER_DELAY_MS)
    }
    window.focusPage()
  }

  private get importHost(): ImportHost {
    const browser = this
    return {
      tabs: this.tabs,
      favicons: this.favicons,
      extensions: this.extensions,
      get t() {
        return browser.t
      },
      parent: () => this.window?.win ?? null,
      toast: (message: string) => this.shell.command({ type: 'toast', message }),
      profileSession: () => this.profiles.defaultSession(),
      profilePartition: () => this.profiles.get(DEFAULT_PROFILE_ID).partition,
      userData: () => app.getPath('userData'),
      passwordStore: () => this.passwords.store,
      relaunch: () => {
        app.relaunch()
        app.quit()
      }
    }
  }

  /** Every installed browser and what its chosen profile would bring over. */
  importableBrowsers(chosen?: Record<string, string>): Promise<ImportableBrowser[]> {
    return scanImportable(this.importHost, chosen).catch((error: unknown) => {
      console.error('[import]', error)
      return []
    })
  }

  /** Settings / File menu: import bookmarks, extensions and logins from one browser. */
  importFrom(browser: ImportBrowser, profileDir?: string): Promise<void> {
    return importFromBrowser(this.importHost, browser, profileDir === undefined ? {} : { profileDir }).catch(
      (error: unknown) => console.error('[import]', error)
    )
  }

  /** ⌘T / palette: import from whichever browser has the most to bring over. */
  async importFromBestBrowser(): Promise<void> {
    const browser = await bestImportCandidate(this.importHost).catch(() => null)
    if (browser) await this.importFrom(browser)
  }

  /** Once per profile, while it is still empty: offer to bring everything over. */
  async offerArcImport(): Promise<void> {
    if (this.arcImportOffered || this.quitting || !isFreshProfile(this.importHost)) return
    const browser = await bestImportCandidate(this.importHost).catch(() => null)
    if (!browser) return
    this.arcImportOffered = true
    this.persister.setSetting(ARC_IMPORT_OFFERED_KEY, true)
    await importFromBrowser(this.importHost, browser, { firstRun: true }).catch((error: unknown) =>
      console.error('[import]', error)
    )
  }

  /** Integration tests (ARC_TEST) show the window without stealing focus. */
  private revealWindow(window: BrowserWindowController): void {
    if (process.env.ARC_TEST === '1') window.win.showInactive()
    else window.win.show()
  }

  setSidebar(opts: { width?: number; collapsed?: boolean }): void {
    const patch: Partial<WindowState> = {}
    if (opts.width !== undefined) patch.sidebarWidth = clampSidebarWidth(opts.width)
    if (opts.collapsed !== undefined) patch.sidebarCollapsed = opts.collapsed
    this.window?.setLayout({
      sidebarWidth: patch.sidebarWidth ?? this.windowState.sidebarWidth,
      sidebarCollapsed: patch.sidebarCollapsed ?? this.windowState.sidebarCollapsed
    })
    this.patchWindow(patch)
    this.syncTrafficLights()
    this.persister.setSetting('window.layout', {
      sidebarWidth: this.windowState.sidebarWidth,
      sidebarCollapsed: this.windowState.sidebarCollapsed
    })
  }

  setOverlay(open: boolean): void {
    this.window?.setOverlay(open)
    if (!open) this.window?.focusPage()
    this.syncTrafficLights()
  }

  /** With the sidebar collapsed the page reaches the top-left corner; hide the
   * traffic lights there unless the sidebar is peeking or an overlay is open. */
  private syncTrafficLights(): void {
    const window = this.window
    if (!window || window.win.isDestroyed()) return
    window.win.setWindowButtonVisibility(!this.windowState.sidebarCollapsed || window.isOverlayOpen)
  }

  placeSitePanel(bounds: Rect): void {
    this.sitePanelBounds = bounds
    this.window?.repositionSurface('sitePanel')
  }

  setSurfaceVisible(id: SurfaceId, visible: boolean): void {
    const window = this.window
    if (!window) return
    if (!window.getSurface(id)) {
      this.pendingSurfaces.set(id, visible)
      return
    }
    const surface = window.getSurface(id)
    // A click on a surface that does not take focus still moves the keyboard
    // there; when it goes, the keyboard goes back to the page. Only once the
    // view is gone: removing a view that still has focus clears it again.
    const hadFocus = !visible && (surface?.view.webContents.isFocused() ?? false)
    window.setSurfaceVisible(id, visible)
    if (SURFACES[id].takesFocus) {
      if (visible) surface?.view.webContents.focus()
      else window.focusPage()
    } else if (hadFocus) {
      window.focusPage()
    }
  }

  private patchWindow(patch: Partial<WindowState>): void {
    this.windowState = { ...this.windowState, ...patch }
    this.shell.window(patch)
  }

  // ---------------------------------------------------------------------------
  // Commands (menu, shortcuts)
  // ---------------------------------------------------------------------------

  runCommand(id: CommandId): void {
    const window = this.window
    const tabs = this.tabs
    const active = tabs.model.activeTab()
    const wasHidden = window !== null && !window.win.isVisible()
    if (wasHidden && id !== 'window.close') this.showWindow()
    switch (id) {
      case 'edit.undo':
        return void this.undo(wasHidden)
      case 'page.print':
        return active && tabs.print(active.id)
      case 'tab.new':
        return this.openPalette('new-tab')
      case 'address.focus':
        return this.openPalette(active ? 'edit-url' : 'new-tab')
      case 'tab.close':
        if (window?.isOverlayOpen) return this.shell.command({ type: 'palette.close' })
        if (active) tabs.closeTab(active.id)
        return
      case 'tab.reopen':
        return tabs.reopenClosedTab()
      case 'tab.next':
        return tabs.selectAdjacent(1)
      case 'tab.prev':
        return tabs.selectAdjacent(-1)
      case 'tab.reload':
        return active && tabs.reload(active.id)
      case 'tab.hardReload':
        return active && tabs.reload(active.id, true)
      case 'tab.stop':
        return active && tabs.stop(active.id)
      case 'tab.back':
        return active && tabs.goBack(active.id)
      case 'tab.forward':
        return active && tabs.goForward(active.id)
      case 'tab.duplicate':
        return active && tabs.duplicateTab(active.id)
      case 'tab.pin':
        return active && tabs.toggleSaved(active.id)
      case 'tab.copyUrl':
        if (active) {
          tabs.copyUrl(active.id)
          this.shell.command({ type: 'toast', message: this.t('toast.urlCopied') })
        }
        return
      case 'space.next':
        return tabs.switchSpace(1)
      case 'space.prev':
        return tabs.switchSpace(-1)
      case 'find.open':
        if (active && tabs.runtime(active.id)) this.shell.command({ type: 'find.open' })
        return
      case 'find.next':
      case 'find.prev':
        return this.shell.command({ type: 'find.open' })
      case 'zoom.in':
        return active && tabs.adjustZoom(active.id, 1)
      case 'zoom.out':
        return active && tabs.adjustZoom(active.id, -1)
      case 'zoom.reset':
        return active && tabs.adjustZoom(active.id, 0)
      case 'sidebar.toggle':
        return this.setSidebar({ collapsed: !this.windowState.sidebarCollapsed })
      case 'page.devtools':
        return active && tabs.toggleDevTools(active.id)
      case 'shell.devtools':
        return window?.shellContents.openDevTools({ mode: 'detach' })
      case 'open.history':
        return this.openInternal('history')
      case 'open.downloads':
        return this.openInternal('downloads')
      case 'open.extensions':
        return this.openInternal('extensions')
      case 'open.settings':
        return this.openInternal('settings')
      case 'import.browser':
        return void this.importFromBestBrowser()
      case 'window.close':
        return window?.win.close()
      default: {
        const n = /^tab\.select\.(\d)$/.exec(id)
        if (n) tabs.selectIndex(Number(n[1]))
      }
    }
  }

  private openPalette(mode: 'new-tab' | 'edit-url'): void {
    // Raise the shell right away; the palette renders on the next frame.
    this.window?.setOverlay(true)
    this.shell.command({ type: 'palette.open', mode })
  }

  /** Focus an existing internal page tab in this space, or open one. */
  openInternal(page: InternalPage): void {
    const url = internalUrl(page)
    const space = this.tabs.model.activeSpace()
    const existing = space && this.tabs.model.orderedTabIds(space.id).find((id) => this.tabs.model.getTab(id)?.url === url)
    if (existing) this.tabs.activateTab(existing)
    else this.tabs.createTab({ url })
  }

  /** The Extensions page records a shortcut: the keys are for it. */
  setShortcutRecording(recording: boolean): void {
    this.recordingShortcut = recording
    this.extensions.setRecording(recording)
  }

  handleReservedKeys(event: Electron.Event, input: Electron.Input): void {
    if (isTyping(input)) this.lastTypedAt = Date.now()
    if (this.recordingShortcut) return
    const command = reservedCommandFor(input)
    if (command) {
      event.preventDefault()
      this.runCommand(command)
    } else if (isReservedKeyUp(input)) {
      event.preventDefault()
    } else if (this.extensions.handleKey(input)) {
      // An extension's chrome.commands shortcut.
      event.preventDefault()
    }
  }

  // ---------------------------------------------------------------------------
  // Integrations
  // ---------------------------------------------------------------------------

  private wireDelegates(): void {
    this.tabs.setDelegate({
      contextMenu: (tab, wc, params) => {
        // An agent's right-click: a native menu would stall everything until someone closes it.
        if (this.agent?.ownsContextMenu(wc)) return
        const settings = this.settings.get()
        showPageContextMenu(wc, params, {
          t: this.t,
          searchEngineName: this.searchEngineName(),
          openUrl: (url, background) => {
            const index = tab.pinned ? 0 : this.tabs.model.sortOrderOf(tab) + 1
            this.tabs.createTab({ url, background, spaceId: tab.spaceId, index })
          },
          search: (text) => this.tabs.createTab({ url: buildSearchUrl(text, searchTemplate(settings)) }),
          extensionItems: () => this.extensions.contextMenuItems(wc, params)
        })
      },
      beforeInput: (_tabId, event, input) => this.handleReservedKeys(event, input),
      popupCreated: (win) => this.wirePopup(win),
      confirmLeave: async () => {
        const options: Electron.MessageBoxOptions = {
          type: 'question',
          message: this.t('dialog.leave.title'),
          detail: this.t('dialog.leave.detail'),
          buttons: [this.t('dialog.leave.confirm'), this.t('common.cancel')],
          defaultId: 0,
          cancelId: 1
        }
        const res = this.window
          ? await dialog.showMessageBox(this.window.win, options)
          : await dialog.showMessageBox(options)
        return res.response === 0
      },
      runtimeCreated: (tab, wc) => {
        this.dialogs.attach(wc)
        this.extensions.tabCreated(wc)
        this.agent?.runtimeCreated(tab.id, wc)
      },
      tabRemoved: (tabId) => {
        this.dialogs.dismissTab(tabId)
        this.agent?.tabRemoved(tabId)
      },
      runtimeDestroyed: () => undefined,
      activeChanged: (wc) => {
        this.dialogs.dismissHidden()
        this.extensions.tabSelected(wc)
        if (this.window?.getSurface('find')?.visible) this.shell.command({ type: 'find.close' })
      },
      htmlFullscreen: (on) => this.setHtmlFullscreen(on),
      activeThemeChanged: () => this.syncWindowBackground()
    })
  }

  /**
   * The native window background shows wherever the shell has not painted
   * yet (live resize, first frame); keep it on the active space's chrome color.
   */
  private windowBackground(): string {
    const space = this.tabs.model.activeSpace()
    const appearance = space?.theme.appearance ?? 'system'
    const dark = appearance === 'system' ? nativeTheme.shouldUseDarkColors : appearance === 'dark'
    return chromeColor(space?.color ?? DEFAULT_SPACE.color, space?.theme.intensity ?? 50, dark)
  }

  private syncWindowBackground(): void {
    const win = this.window?.win
    if (!win || win.isDestroyed()) return
    const color = this.windowBackground()
    if (color !== this.windowColor) {
      this.windowColor = color
      win.setBackgroundColor(color)
    }
  }

  private setHtmlFullscreen(on: boolean): void {
    const window = this.window
    if (!window) return
    window.setLayout({ htmlFullscreen: on })
    this.patchWindow({ htmlFullscreen: on })
    if (on && !window.win.isFullScreen()) {
      this.enteredFullscreenForHtml = true
      window.win.setFullScreen(true)
    } else if (!on && this.enteredFullscreenForHtml) {
      this.enteredFullscreenForHtml = false
      window.win.setFullScreen(false)
    }
  }

  /** window.open() popups with features (OAuth etc.) are real windows. */
  private wirePopup(win: BrowserWindow): void {
    const wc = win.webContents
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.meta && !input.shift && !input.alt && input.code === 'KeyW') {
        event.preventDefault()
        win.close()
      }
    })
    wc.on('context-menu', (_e, params) =>
      showPageContextMenu(wc, params, {
        t: this.t,
        searchEngineName: this.searchEngineName(),
        openUrl: (url, background) => this.tabs.createTab({ url, background }),
        search: (text) => this.tabs.createTab({ url: buildSearchUrl(text, searchTemplate(this.settings.get())) }),
        extensionItems: () => this.extensions.contextMenuItems(wc, params)
      })
    )
    wc.setWindowOpenHandler((details) => {
      if (/^https?:/.test(details.url)) this.tabs.createTab({ url: details.url })
      return { action: 'deny' }
    })
  }

  handleCertificateError(
    event: Electron.Event,
    url: string,
    error: string,
    callback: (trusted: boolean) => void
  ): void {
    let host = ''
    try {
      host = new URL(url).host
    } catch {
      // fall through: deny
    }
    if (host && this.certExceptions.has(host)) {
      console.warn(`[cert] proceeding past ${error} for ${host} (user exception)`)
      event.preventDefault()
      callback(true)
      return
    }
    callback(false)
  }

  allowCertificate(tabId: string): void {
    const tab = this.tabs.model.getTab(tabId)
    if (!tab?.error || tab.error.kind !== 'certificate') return
    try {
      this.certExceptions.add(new URL(tab.error.url || tab.url).host)
    } catch {
      return
    }
    this.tabs.reload(tabId)
  }

  /** URLs handed to us by macOS (default browser, `open`, dock drops). */
  openExternalUrl(url: string): void {
    if (!this.window) {
      this.pendingUrls.push(url)
      return
    }
    if (!/^(https?|file):/i.test(url)) return
    this.tabs.createTab({ url })
    this.showWindow()
  }

  async confirm(message: string, detail: string): Promise<boolean> {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      message,
      detail,
      buttons: [this.t('common.allow'), this.t('common.deny')],
      defaultId: 1,
      cancelId: 1
    }
    const res = this.window ? await dialog.showMessageBox(this.window.win, options) : await dialog.showMessageBox(options)
    return res.response === 0
  }

  /** `t()` for the current UI language. */
  get t(): Translate {
    return translator(this.settings.get().language)
  }

  private searchEngineName(): string {
    const { searchEngine } = this.settings.get()
    return searchEngine === 'custom' ? this.t('search.genericEngine') : SEARCH_ENGINES[searchEngine].name
  }

  /** (Re)build the native menu; called again whenever the language changes. */
  private installMenu(): void {
    Menu.setApplicationMenu(buildAppMenu((id) => this.runCommand(id), { isDev, t: this.t }))
  }

  startupMarks(): Record<string, number> {
    return startupMarks()
  }

  showWindow(): void {
    const window = this.window
    if (window && !window.destroyed) this.revealWindow(window)
  }

  /** ⌘Z: see `shortcuts/undo.ts`. */
  private async undo(windowWasHidden: boolean): Promise<void> {
    const focused = webContents.getFocusedWebContents()
    const tabs = this.tabs
    const action = decideUndo({
      windowWasHidden,
      windowIsKey: this.window?.win.isFocused() ?? false,
      hasFocusedContents: focused !== null && !focused.isDestroyed(),
      closedSinceTyping: tabs.lastClosedAt > this.lastTypedAt,
      canReopen: tabs.canReopen()
    })
    switch (action) {
      case 'native':
        return Menu.sendActionToFirstResponder('undo:')
      case 'reopen':
        return tabs.reopenClosedTab()
      case 'probe':
        if (focused && (await isEditingText(focused))) return focused.undo()
        return tabs.reopenClosedTab()
      case 'text':
        return focused?.undo()
      case 'none':
        return
    }
  }

  // ---------------------------------------------------------------------------
  // Agents (MCP)
  // ---------------------------------------------------------------------------

  /** Start, restart or stop the agent server to match the settings. */
  private syncAgent(): void {
    this.agentSync = this.agentSync.then(async () => {
      const { agentEnabled, agentPort } = this.settings.get()
      if (!agentEnabled || this.quitting) {
        await this.agent?.stop()
        return
      }
      if (!this.agentToken) this.setAgentToken(newAgentToken())
      if (!this.agent) {
        const { AgentService } = await import('../agent/agent-service')
        this.agent = new AgentService({
          tabs: this.tabs,
          history: this.history,
          dialogs: this.dialogs,
          window: () => this.window,
          token: () => this.agentToken,
          t: (key, params) => this.t(key, params)
        })
      }
      await this.agent.start(agentPort)
    }).catch((error: unknown) => console.error('[agent]', error))
  }

  async agentInfo(): Promise<AgentInfo> {
    await this.agentSync
    const { agentEnabled, agentPort } = this.settings.get()
    return (
      this.agent?.info(agentEnabled, agentPort) ?? {
        enabled: agentEnabled,
        running: false,
        port: agentPort,
        url: agentUrl(agentPort),
        token: this.agentToken,
        error: null,
        clients: []
      }
    )
  }

  copyAgentSnippet(what: AgentSnippet): void {
    if (!this.agentToken) this.setAgentToken(newAgentToken())
    clipboard.writeText(agentSnippet(what, agentUrl(this.settings.get().agentPort), this.agentToken))
  }

  regenerateAgentToken(): Promise<AgentInfo> {
    this.setAgentToken(newAgentToken())
    return this.agentInfo()
  }

  private setAgentToken(token: string): void {
    this.agentToken = token
    this.persister.setSetting(AGENT_TOKEN_KEY, token)
  }

  // ---------------------------------------------------------------------------
  // Security & lifecycle
  // ---------------------------------------------------------------------------

  private isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const window = this.window
    if (!window || event.sender !== window.shellContents) return false
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return false
    try {
      // Compare protocol + host: WHATWG URL reports origin "null" for
      // non-special schemes such as app://.
      const url = new URL(frame.url)
      const expected = new URL(rendererDevUrl ?? SHELL_ORIGIN)
      return url.protocol === expected.protocol && url.host === expected.host
    } catch {
      return false
    }
  }

  /** before-quit: capture navigation state while every WebContents is alive. */
  markQuitting(): void {
    if (this.quitting) return
    this.quitting = true
    this.discarder.stop()
    void this.agent?.close()
    this.extensions.shutdown()
    this.tabs.snapshotAll()
    // From here on, WebContents being torn down must not touch the model.
    this.tabs.freeze()
    this.persister.flush()
    this.tabs.closeAllForQuit()
  }

  /** will-quit: final flush and close the database. */
  shutdown(): void {
    if (this.shutDown) return
    this.shutDown = true
    this.markQuitting()
    try {
      this.history.flush()
      this.persister.flush()
    } finally {
      this.persister.close()
      this.db.close()
    }
  }

  get isQuitting(): boolean {
    return this.quitting
  }
}

function newAgentToken(): string {
  return randomBytes(24).toString('base64url')
}

/** The shell's own session never needs downloads or web permissions. */
function hardenDefaultSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
  ses.on('will-download', (_e, item) => item.cancel())
}
