import {
  WebContentsView,
  type BaseWindow,
  type ContextMenuParams,
  type Event as ElectronEvent,
  type HandlerDetails,
  type Input,
  type Result as FoundInPageResult,
  type Session,
  type WebContents,
  type WindowOpenHandlerResponse
} from 'electron'
import { LIMITS } from '@shared/defaults'
import type { TabError, TabId } from '@shared/types'
import { viewportUserAgent, type ViewportSpec } from '@shared/viewport'
import { outPath } from '../app/environment'
import type { NavState } from '../persistence/records'
import { holdDebugger, releaseDebugger } from './debugger'
import type { TabData } from './model'

/** Callbacks a runtime uses to report back to the TabManager. */
export interface TabRuntimeHost {
  update(tabId: TabId, patch: Partial<TabData>): void
  navigated(tabId: TabId, url: string, typed: boolean, sameDocument: boolean): void
  titleChanged(tabId: TabId, url: string, title: string): void
  faviconsChanged(tabId: TabId, urls: string[]): void
  windowOpen(tabId: TabId, details: HandlerDetails): WindowOpenHandlerResponse
  contextMenu(tabId: TabId, params: ContextMenuParams): void
  beforeInput(tabId: TabId, event: ElectronEvent, input: Input): void
  foundInPage(tabId: TabId, result: FoundInPageResult): void
  htmlFullscreen(tabId: TabId, on: boolean): void
  preventedUnload(tabId: TabId): void
  destroyed(tabId: TabId): void
  zoomWheel(tabId: TabId, direction: 'in' | 'out'): void
  popupCreated(window: Electron.BrowserWindow): void
  /** A key pressed in the page's DevTools. */
  devtoolsInput(tabId: TabId, event: ElectronEvent, input: Input): void
  /** DevTools asked to open a link (e.g. "Open in new tab" on a resource). */
  devtoolsOpenUrl(tabId: TabId, url: string): void
}

/** The device emulation's name on the shared DevTools protocol session. */
const VIEWPORT_HOLDER = 'viewport'
const CHROME_MAJOR = process.versions.chrome?.split('.')[0] ?? '0'

const PAGE_WEB_PREFERENCES = {
  sandbox: true,
  // Sign-in autofill. Sandboxed and context-isolated: the page cannot see
  // it, and it does nothing until a password field is focused.
  preload: outPath('preload', 'page.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: true,
  // Rate-limits alert()/confirm() spam.
  safeDialogs: true,
  // Hidden tabs get Chromium's timer throttling; that is our first line of
  // defence against background CPU use.
  backgroundThrottling: true,
  scrollBounce: true,
  enableWebSQL: false
} as const

const ERR_ABORTED = -3

function errorKind(code: number): TabError['kind'] {
  // net::ERR_CERT_* codes live in [-299, -200].
  return code <= -200 && code >= -299 ? 'certificate' : 'network'
}

function stripHash(url: string): string {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

/**
 * A live tab: one WebContentsView plus its event wiring. Tabs without a
 * runtime are "unloaded" — they cost nothing but a row in memory.
 */
export class TabRuntime {
  readonly view: WebContentsView
  readonly wc: WebContents
  private pendingTypedNavigation = false
  private lastRecordedUrl = ''
  private closing = false
  /**
   * True while navigationHistory.restore() is loading. Chromium 152 can crash
   * the renderer (SIGSEGV) when a browser-initiated navigation interrupts a
   * load restored with PageState, so such navigations wait until it settles.
   */
  private restoring = false
  private afterRestore: Array<() => void> = []
  private recoveredRestoreCrash = false
  /** Media players playing in the page, heard or not (every start has a pause, end or teardown). */
  private playingMedia = 0
  /** When the page last stopped playing media or making sound. */
  private stoppedPlayingAt = 0
  /** Set after the user confirmed leaving a page with a beforeunload handler. */
  allowUnloadOnce = false
  /**
   * DevTools for this page: their frontend in a view of ours (Electron's
   * `setDevToolsWebContents`), so they can dock beside the page like
   * Chrome's. TabManager places the view: in the window next to the page,
   * or in `devtoolsWindow` when undocked.
   */
  devtools: WebContentsView | null = null
  devtoolsWindow: BaseWindow | null = null
  /** Device emulation (see setViewport). */
  private viewport: ViewportSpec | null = null
  private viewportScale = 1
  /** What the DevTools protocol was last told, to skip repeats ('' = nothing). */
  private appliedViewport = ''

  constructor(
    readonly tabId: TabId,
    session: Session,
    private readonly host: TabRuntimeHost,
    adopt?: { webContents: WebContents; webPreferences?: Electron.WebPreferences }
  ) {
    this.view = adopt
      ? new WebContentsView({ webContents: adopt.webContents, webPreferences: adopt.webPreferences })
      : new WebContentsView({ webPreferences: { ...PAGE_WEB_PREFERENCES, session } })
    this.view.setBackgroundColor('#ffffff')
    this.wc = this.view.webContents
    this.wire()
  }

  get isClosing(): boolean {
    return this.closing
  }

  /**
   * When the page last played media or made sound; `now` while it still does.
   * Chromium calls a page silent within a second of its sound stopping, so
   * audibility alone misses music between tracks, quiet stretches of a
   * stream and muted video.
   */
  lastPlayedAt(now = Date.now()): number {
    return this.playingMedia > 0 || this.wc.isCurrentlyAudible() ? now : this.stoppedPlayingAt
  }

  /** Restore the saved back/forward stack, or load `url` fresh. */
  load(tab: Pick<TabData, 'url' | 'navState'>): void {
    const nav = tab.navState
    if (nav && nav.entries.length > 0) {
      this.restoring = true
      this.wc.navigationHistory
        .restore({ entries: nav.entries, index: Math.min(nav.index, nav.entries.length - 1) })
        .catch(() => {
          if (!this.wc.isDestroyed()) this.wc.loadURL(tab.url).catch(() => undefined)
        })
        .finally(() => this.settleRestore())
      return
    }
    if (tab.url && tab.url !== 'about:blank') this.loadUrl(tab.url)
  }

  /** Run a browser-initiated navigation now, or once a restore has settled. */
  whenSettled(fn: () => void): void {
    if (this.restoring) this.afterRestore.push(fn)
    else fn()
  }

  private settleRestore(): void {
    this.restoring = false
    const queued = this.afterRestore.splice(0)
    for (const fn of queued) if (!this.wc.isDestroyed()) fn()
  }

  loadUrl(url: string, typed = false): void {
    this.whenSettled(() => {
      this.pendingTypedNavigation = typed
      this.wc.loadURL(url).catch(() => {
        // Failures surface through did-fail-load; ERR_ABORTED (redirects to
        // downloads, superseded navigations) is expected.
      })
    })
  }

  /** Capture the back/forward stack so the tab can be rebuilt later. */
  snapshot(): NavState | null {
    if (this.wc.isDestroyed()) return null
    const history = this.wc.navigationHistory
    const entries = history.getAllEntries()
    if (entries.length === 0) return null
    let index = history.getActiveIndex()
    let start = 0
    if (entries.length > LIMITS.navEntriesPerTab) {
      start = Math.max(0, Math.min(index - LIMITS.navEntriesPerTab / 2, entries.length - LIMITS.navEntriesPerTab))
      index -= start
    }
    const kept = entries.slice(start, start + LIMITS.navEntriesPerTab)
    return {
      entries: kept.map((e) => ({ url: e.url, title: e.title, ...(e.pageState ? { pageState: e.pageState } : {}) })),
      index: Math.max(0, Math.min(index, kept.length - 1))
    }
  }

  /** Close, honouring beforeunload; the host is told once it is gone. */
  close(force = false): void {
    if (this.wc.isDestroyed()) return
    this.closing = true
    this.wc.close({ waitForBeforeUnload: !force })
  }

  /** Abort a pending close (the user chose to stay on the page). */
  cancelClose(): void {
    this.closing = false
  }

  // -- DevTools -----------------------------------------------------------------

  /** Load DevTools into a view of ours (created here, placed by the caller). */
  attachDevTools(background: string): WebContentsView {
    if (this.devtools) return this.devtools
    const view = new WebContentsView()
    view.setBackgroundColor(background)
    view.webContents.on('before-input-event', (event, input) => this.host.devtoolsInput(this.tabId, event, input))
    this.wc.setDevToolsWebContents(view.webContents)
    // 'detach': we place the frontend ourselves, and it shows no dock-side menu of its own.
    this.wc.openDevTools({ mode: 'detach', activate: false })
    this.devtools = view
    return view
  }

  /** Close DevTools and destroy their view and window (Electron leaves both to the owner). */
  detachDevTools(): void {
    const view = this.devtools
    const window = this.devtoolsWindow
    this.devtools = null
    this.devtoolsWindow = null
    if (!view) return
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(view)
      window.destroy()
    }
    if (!this.wc.isDestroyed()) this.wc.closeDevTools()
    // Destroying the frontend also detaches it from the page.
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  // -- device emulation ---------------------------------------------------------

  /**
   * Lay the page out at another device's viewport, pixel ratio and input
   * (Chrome's device mode), or back at its own (null). `scale` draws it
   * smaller when it does not fit the window; layout is unaffected. Over the
   * DevTools protocol, which keeps it across navigations.
   */
  setViewport(spec: ViewportSpec | null, scale = this.viewportScale): void {
    this.viewport = spec
    this.viewportScale = spec ? scale : 1
    this.applyViewport()
  }

  /** The window fit the emulated viewport at a new scale. */
  setViewportScale(scale: number): void {
    if (!this.viewport || Math.abs(scale - this.viewportScale) < 1e-4) return
    this.viewportScale = scale
    this.applyViewport()
  }

  /** CSS pixels → view pixels of the emulated viewport (1 without emulation). */
  get emulationScale(): number {
    return this.viewport ? this.viewportScale : 1
  }

  get emulatedViewport(): ViewportSpec | null {
    return this.viewport
  }

  private applyViewport(): void {
    if (this.wc.isDestroyed()) return
    const spec = this.viewport
    const key = spec ? JSON.stringify(spec) : ''
    const applied = this.appliedViewport
    const deviceKey = applied.slice(0, applied.lastIndexOf('|'))
    const next = spec ? `${key}|${this.viewportScale}` : ''
    if (next === applied) return
    const dbg = this.wc.debugger
    // Commands go out in order; none needs the previous one's answer.
    const send = (method: string, params: Record<string, unknown> = {}) => void dbg.sendCommand(method, params).catch(() => undefined)
    if (!spec) {
      this.appliedViewport = ''
      if (!applied || !dbg.isAttached()) return
      send('Emulation.clearDeviceMetricsOverride')
      send('Emulation.setTouchEmulationEnabled', { enabled: false })
      send('Emulation.setEmitTouchEventsForMouse', { enabled: false })
      send('Emulation.setUserAgentOverride', { userAgent: '' })
      releaseDebugger(this.wc, VIEWPORT_HOLDER)
      return
    }
    try {
      holdDebugger(this.wc, VIEWPORT_HOLDER)
    } catch (error) {
      console.error('[viewport] cannot attach the DevTools protocol', error)
      return
    }
    this.appliedViewport = next
    send('Emulation.setDeviceMetricsOverride', {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: spec.deviceScaleFactor,
      mobile: spec.mobile,
      scale: this.viewportScale,
      screenWidth: spec.width,
      screenHeight: spec.height
    })
    // Only the fit changed (window resized): the rest stands.
    if (deviceKey === key) return
    send('Emulation.setTouchEmulationEnabled', spec.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
    send('Emulation.setEmitTouchEventsForMouse', { enabled: spec.mobile, configuration: spec.mobile ? 'mobile' : 'desktop' })
    send('Emulation.setUserAgentOverride', { userAgent: viewportUserAgent(spec, CHROME_MAJOR) ?? '' })
  }

  private navState() {
    const h = this.wc.navigationHistory
    return { canGoBack: h.canGoBack(), canGoForward: h.canGoForward() }
  }

  private wire(): void {
    const { wc, host, tabId } = this
    // Runtimes that are closing or being discarded stay silent so a stale
    // WebContents never overwrites the state of the tab's next runtime.
    const on = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
      if (!this.closing) fn(...args)
    }
    const update = (patch: Partial<TabData>) => {
      if (!this.closing) host.update(tabId, patch)
    }

    wc.on('did-start-loading', () => update({ loading: true }))
    wc.on('did-stop-loading', () => update({ loading: false, ...this.navState() }))

    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) update({ error: null, crashed: false })
    })

    wc.on(
      'did-navigate',
      on((_e: unknown, url: string) => {
        const typed = this.pendingTypedNavigation
        this.pendingTypedNavigation = false
        update({ url, error: null, crashed: false, ...this.navState() })
        this.lastRecordedUrl = stripHash(url)
        host.navigated(tabId, url, typed, false)
      })
    )

    wc.on(
      'did-navigate-in-page',
      on((_e: unknown, url: string, isMainFrame: boolean) => {
        if (!isMainFrame) return
        update({ url, ...this.navState() })
        const bare = stripHash(url)
        if (bare !== this.lastRecordedUrl) {
          this.lastRecordedUrl = bare
          host.navigated(tabId, url, false, true)
        }
      })
    )

    wc.on('did-fail-load', (_e, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return
      update({
        loading: false,
        url: validatedUrl || wc.getURL(),
        error: { kind: errorKind(code), code, description, url: validatedUrl },
        ...this.navState()
      })
    })

    wc.on(
      'page-title-updated',
      on((_e: unknown, title: string) => {
        host.update(tabId, { title })
        host.titleChanged(tabId, wc.getURL(), title)
      })
    )

    wc.on('page-favicon-updated', on((_e: unknown, favicons: string[]) => host.faviconsChanged(tabId, favicons)))

    wc.on('render-process-gone', (_e, details) => {
      // Its players went with it, whether or not they said so.
      if (this.playingMedia > 0) this.stoppedPlayingAt = Date.now()
      this.playingMedia = 0
      if (details.reason === 'clean-exit') return
      if (this.restoring && !this.recoveredRestoreCrash) {
        // Known Chromium crash while restoring PageState: recover silently.
        this.recoveredRestoreCrash = true
        this.settleRestore()
        setImmediate(() => !wc.isDestroyed() && wc.reload())
        return
      }
      update({ crashed: true, loading: false, audible: false })
    })

    wc.on('audio-state-changed', (event) => {
      if (!event.audible) this.stoppedPlayingAt = Date.now()
      update({ audible: event.audible })
    })
    wc.on('media-started-playing', () => {
      this.playingMedia += 1
    })
    wc.on('media-paused', () => {
      if (this.playingMedia === 0) return
      this.playingMedia -= 1
      if (this.playingMedia === 0) this.stoppedPlayingAt = Date.now()
    })

    wc.on('found-in-page', on((_e: unknown, result: FoundInPageResult) => host.foundInPage(tabId, result)))
    wc.on('context-menu', on((_e: unknown, params: ContextMenuParams) => host.contextMenu(tabId, params)))
    wc.on('before-input-event', (event, input) => host.beforeInput(tabId, event, input))
    wc.on('enter-html-full-screen', on(() => host.htmlFullscreen(tabId, true)))
    wc.on('leave-html-full-screen', () => host.htmlFullscreen(tabId, false))
    wc.on('zoom-changed', on((_e: unknown, direction: 'in' | 'out') => host.zoomWheel(tabId, direction)))
    wc.on('did-create-window', (window) => host.popupCreated(window))

    wc.on('will-prevent-unload', (event) => {
      if (this.allowUnloadOnce) {
        this.allowUnloadOnce = false
        event.preventDefault()
        return
      }
      host.preventedUnload(tabId)
    })

    wc.on('devtools-open-url', (_e, url) => host.devtoolsOpenUrl(tabId, url))
    // The protocol session went away by itself: emulation goes with it, so apply it again.
    wc.debugger.on('detach', (_e, reason) => {
      if (!this.appliedViewport) return
      this.appliedViewport = ''
      if (this.viewport && reason !== 'target closed') setImmediate(() => this.applyViewport())
    })

    wc.once('destroyed', () => {
      this.detachDevTools()
      host.destroyed(tabId)
    })

    wc.setWindowOpenHandler((details) => host.windowOpen(tabId, details))
  }
}
