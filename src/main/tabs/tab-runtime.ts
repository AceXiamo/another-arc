import {
  WebContentsView,
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
import type { NavState } from '../persistence/records'
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
}

const PAGE_WEB_PREFERENCES = {
  sandbox: true,
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
  /** Set after the user confirmed leaving a page with a beforeunload handler. */
  allowUnloadOnce = false

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

    wc.on('audio-state-changed', (event) => update({ audible: event.audible }))

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

    wc.once('destroyed', () => host.destroyed(tabId))

    wc.setWindowOpenHandler((details) => host.windowOpen(tabId, details))
  }
}
