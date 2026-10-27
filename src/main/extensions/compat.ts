import { BrowserWindow, ipcMain, webContents, type IpcMainEvent, type ServiceWorkerMain, type Session, type WebContents } from 'electron'

const CHANNEL_EVENT = 'arc-compat:event'
const CHANNEL_STORAGE = 'arc-compat:storage'
const CHANNEL_LISTENER = 'arc-compat:listener'
const CHANNEL_CONTEXTS = 'arc-compat:getContexts'
const CHANNEL_SIDE_PANEL = 'arc-compat:sidePanel'
const CHANNEL_SIDE_PANEL_EVENT = 'arc-compat:sidePanelEvent'
const CHANNEL_USER_SCRIPTS = 'arc-compat:userScripts'
const CHANNEL_USER_SCRIPTS_STATE = 'arc-compat:userScriptsState'
/** Listener registrations reach main as IPC sent during the worker's first run; let them land. */
const LISTENER_SETTLE_MS = 150
const WAKE_TIMEOUT_MS = 4000
/**
 * Synthetic events do not extend a worker's lifetime the way native extension
 * events do; keep it alive briefly so listeners can finish async work.
 */
const EVENT_KEEPALIVE_MS = 10_000

/** chrome.runtime.ExtensionContext */
interface ExtensionContext {
  contextType: 'TAB' | 'POPUP' | 'BACKGROUND' | 'OFFSCREEN_DOCUMENT' | 'SIDE_PANEL'
  contextId: string
  tabId: number
  windowId: number
  documentId?: string
  frameId: number
  documentUrl?: string
  documentOrigin?: string
  incognito: boolean
}

export interface ContextHost {
  /** Tab id (WebContents id) when `wc` is one of our tabs. */
  isTab(wc: WebContents): boolean
  mainWindowId(): number
  /** The context type of `wc` when it is shown in one of our extension windows. */
  surfaceOf(wc: WebContents): 'POPUP' | 'SIDE_PANEL' | null
}

/** Main-process implementation of chrome.sidePanel (see side-panel.ts). */
export interface SidePanelBackend {
  call(id: string, method: string, arg: unknown): unknown
}

/** Main-process implementation of chrome.userScripts (see user-scripts.ts). */
export interface UserScriptsBackend {
  /** The user allowed the extension's user scripts ("Allow User Scripts"). */
  allowed(id: string): boolean
  call(id: string, method: string, args: unknown[]): Promise<unknown>
}

export interface InstalledDetails {
  reason: 'install' | 'update'
  previousVersion?: string
}

/**
 * Main-process half of src/preload/extension-compat.ts: delivers
 * runtime.onInstalled / onStartup, forwards extension-page storage changes
 * to the extension's service worker, answers runtime.getContexts and
 * carries chrome.sidePanel and chrome.userScripts calls to their backends.
 */
export class ExtensionCompat {
  private readonly pendingInstalled = new Map<string, InstalledDetails>()
  private readonly startedThisSession = new Set<string>()
  private readonly hooked = new WeakSet<ServiceWorkerMain>()
  private readonly startupListeners: Set<string>
  private installed = false
  private earlyInstalled = false
  private readonly keepAlive = new Set<{ end(): void }>()

  constructor(
    private readonly ses: Session,
    private readonly preloadPath: string,
    startupListeners: string[],
    private readonly persistStartupListeners: (ids: string[]) => void,
    private readonly contextHost: ContextHost,
    private readonly sidePanel: SidePanelBackend,
    private readonly userScripts: UserScriptsBackend
  ) {
    this.startupListeners = new Set(startupListeners)
  }

  /**
   * Register the early pass of the compat preload. Must run before
   * electron-chrome-extensions registers its own preload: that one freezes
   * `chrome`, so chrome.sidePanel can only be added before it. Session
   * preloads run in registration order; the same file runs again after the
   * library (see `install`) and tells the two passes apart itself.
   */
  installEarly(): void {
    if (this.earlyInstalled) return
    this.earlyInstalled = true
    this.ses.registerPreloadScript({ id: 'arc-ext-compat-early-frame', type: 'frame', filePath: this.preloadPath })
    this.ses.registerPreloadScript({ id: 'arc-ext-compat-early-sw', type: 'service-worker', filePath: this.preloadPath })
  }

  /** Register the late preload pass and listeners. Must run before extensions load. */
  install(): void {
    if (this.installed) return
    this.installed = true
    this.ses.registerPreloadScript({ id: 'arc-ext-compat-frame', type: 'frame', filePath: this.preloadPath })
    this.ses.registerPreloadScript({ id: 'arc-ext-compat-sw', type: 'service-worker', filePath: this.preloadPath })

    this.ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus !== 'starting' && runningStatus !== 'running') return
      const worker = this.ses.serviceWorkers.getWorkerFromVersionID(versionId)
      const id = worker && extensionIdOf(worker.scope)
      if (!worker || !id) return
      // Hook IPC as early as possible: top-level worker code may call us.
      this.hook(id, worker)
      if (runningStatus === 'running') this.onRunning(id, worker)
    })

    ipcMain.handle(CHANNEL_CONTEXTS, (event, filter: unknown) => {
      const id = event.sender.session === this.ses ? extensionIdOf(event.senderFrame?.url ?? '') : null
      return id ? this.contexts(id, filter) : []
    })

    ipcMain.handle(CHANNEL_SIDE_PANEL, (event, method: unknown, arg: unknown) => {
      const id = event.sender.session === this.ses ? extensionIdOf(event.senderFrame?.url ?? '') : null
      return id && typeof method === 'string' ? this.sidePanel.call(id, method, arg) : undefined
    })

    ipcMain.handle(CHANNEL_USER_SCRIPTS, (event, method: unknown, ...args: unknown[]) => {
      const id = event.sender.session === this.ses ? extensionIdOf(event.senderFrame?.url ?? '') : null
      return id && typeof method === 'string' ? this.userScripts.call(id, method, args) : undefined
    })

    // Extension pages ask synchronously, before their own scripts run, so
    // chrome.userScripts is there (or not) from the first line, as in Chrome.
    ipcMain.on(CHANNEL_USER_SCRIPTS_STATE, (event: IpcMainEvent) => {
      const id = event.sender.session === this.ses ? extensionIdOf(event.senderFrame?.url ?? '') : null
      event.returnValue = id ? this.userScripts.allowed(id) : false
    })

    ipcMain.on(CHANNEL_STORAGE, (event: IpcMainEvent, area: unknown, changes: unknown) => {
      if (event.sender.session !== this.ses || typeof area !== 'string' || !changes || typeof changes !== 'object') return
      const id = extensionIdOf(event.senderFrame?.url ?? '')
      if (id) void this.sendToWorker(id, 'storage.onChanged', changes, area)
    })
  }

  /** An extension was just installed or updated: Chrome fires onInstalled right away. */
  markInstalled(id: string, details: InstalledDetails): void {
    this.pendingInstalled.set(id, details)
    void this.wake(id)
  }

  /**
   * Start the extension's worker if it has not run yet this session, so its
   * event listeners (and the action popup or panel behavior it sets at
   * start-up) are in place before an event is routed to it.
   */
  async ensureStarted(id: string): Promise<void> {
    if (!this.hasWorker(id) || this.startedThisSession.has(id)) return
    await Promise.race([this.wake(id), new Promise((r) => setTimeout(r, WAKE_TIMEOUT_MS).unref())])
    await new Promise((r) => setTimeout(r, LISTENER_SETTLE_MS))
  }

  /** chrome.sidePanel.onOpened / onClosed: to the running worker and the extension's open pages. */
  sidePanelEvent(id: string, name: 'onOpened' | 'onClosed', payload: unknown): void {
    const prefix = `chrome-extension://${id}/`
    for (const [versionId, info] of Object.entries(this.ses.serviceWorkers.getAllRunning())) {
      if (!info.scope.startsWith(prefix)) continue
      const worker = this.ses.serviceWorkers.getWorkerFromVersionID(Number(versionId))
      if (worker && !worker.isDestroyed()) worker.send(CHANNEL_SIDE_PANEL_EVENT, name, payload)
    }
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed() && wc.session === this.ses && wc.getURL().startsWith(prefix)) {
        wc.send(CHANNEL_SIDE_PANEL_EVENT, name, payload)
      }
    }
  }

  /** Start the extension's worker now (it registers its user scripts as it starts). */
  start(id: string): void {
    void this.wake(id)
  }

  /** Wake extensions known to listen for runtime.onStartup. */
  wakeStartupListeners(enabled: Iterable<string>): void {
    for (const id of enabled) if (this.startupListeners.has(id)) void this.wake(id)
  }

  /** End every keep-alive task: Chromium waits for them before quitting. */
  shutdown(): void {
    for (const task of this.keepAlive) task.end()
    this.keepAlive.clear()
  }

  forget(id: string): void {
    this.pendingInstalled.delete(id)
    if (this.startupListeners.delete(id)) this.persistStartupListeners([...this.startupListeners])
  }

  private hasWorker(id: string): boolean {
    const manifest = this.ses.extensions.getExtension(id)?.manifest as { background?: { service_worker?: string } } | undefined
    return Boolean(manifest?.background?.service_worker)
  }

  private async wake(id: string): Promise<ServiceWorkerMain | null> {
    if (!this.hasWorker(id)) return null
    try {
      const worker = await this.ses.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`)
      this.onRunning(id, worker)
      return worker
    } catch {
      return null
    }
  }

  private hook(id: string, worker: ServiceWorkerMain): void {
    if (this.hooked.has(worker)) return
    this.hooked.add(worker)
    worker.ipc.on(CHANNEL_LISTENER, (_event, name: unknown) => {
      if (name === 'runtime.onStartup' && !this.startupListeners.has(id)) {
        this.startupListeners.add(id)
        this.persistStartupListeners([...this.startupListeners])
      }
    })
    worker.ipc.handle(CHANNEL_CONTEXTS, (_event, filter: unknown) => this.contexts(id, filter))
    worker.ipc.handle(CHANNEL_SIDE_PANEL, (_event, method: unknown, arg: unknown) =>
      typeof method === 'string' ? this.sidePanel.call(id, method, arg) : undefined
    )
    worker.ipc.handle(CHANNEL_USER_SCRIPTS, (_event, method: unknown, ...args: unknown[]) =>
      method === 'state' ? this.userScripts.allowed(id) : typeof method === 'string' ? this.userScripts.call(id, method, args) : undefined
    )
  }

  /** chrome.runtime.getContexts() for one extension, built from what we track. */
  private contexts(id: string, rawFilter: unknown): ExtensionContext[] {
    const prefix = `chrome-extension://${id}/`
    const out: ExtensionContext[] = []
    for (const [versionId, info] of Object.entries(this.ses.serviceWorkers.getAllRunning())) {
      if (!info.scope.startsWith(prefix)) continue
      out.push({ contextType: 'BACKGROUND', contextId: `sw-${versionId}`, tabId: -1, windowId: -1, frameId: -1, incognito: false })
    }
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.session !== this.ses) continue
      const url = wc.getURL()
      if (!url.startsWith(prefix)) continue
      const isTab = this.contextHost.isTab(wc)
      // Our extension windows belong to the browser window, as in Chrome.
      const surface = isTab ? null : this.contextHost.surfaceOf(wc)
      const popup = !isTab && !surface && BrowserWindow.fromWebContents(wc)
      const contextType: ExtensionContext['contextType'] = isTab
        ? 'TAB'
        : surface
          ? surface
          : wc.getType() === 'backgroundPage'
            ? 'BACKGROUND'
            : popup
              ? 'POPUP'
              : 'OFFSCREEN_DOCUMENT'
      out.push({
        contextType,
        contextId: `wc-${wc.id}`,
        tabId: isTab ? wc.id : -1,
        windowId: isTab || surface ? this.contextHost.mainWindowId() : popup ? popup.id : -1,
        documentId: `doc-${wc.id}-${wc.mainFrame.processId}-${wc.mainFrame.routingId}`,
        frameId: 0,
        documentUrl: url,
        documentOrigin: `chrome-extension://${id}`,
        incognito: false
      })
    }
    return out.filter((c) => matchesFilter(c, rawFilter))
  }

  private onRunning(id: string, worker: ServiceWorkerMain): void {
    this.hook(id, worker)
    const first = !this.startedThisSession.has(id)
    this.startedThisSession.add(id)
    const installed = this.pendingInstalled.get(id)
    if (installed) {
      this.pendingInstalled.delete(id)
      this.dispatch(worker, 'runtime.onInstalled', installed)
    } else if (first) {
      this.dispatch(worker, 'runtime.onStartup')
    }
  }

  private async sendToWorker(id: string, name: string, ...args: unknown[]): Promise<void> {
    const prefix = `chrome-extension://${id}/`
    let delivered = false
    for (const [versionId, info] of Object.entries(this.ses.serviceWorkers.getAllRunning())) {
      if (!info.scope.startsWith(prefix)) continue
      const worker = this.ses.serviceWorkers.getWorkerFromVersionID(Number(versionId))
      if (worker) this.dispatch(worker, name, ...args)
      delivered = true
    }
    if (!delivered) {
      const worker = await this.wake(id)
      if (worker) this.dispatch(worker, name, ...args)
    }
  }

  private dispatch(worker: ServiceWorkerMain, name: string, ...args: unknown[]): void {
    if (worker.isDestroyed()) return
    try {
      const task = worker.startTask()
      this.keepAlive.add(task)
      setTimeout(() => {
        if (this.keepAlive.delete(task)) task.end()
      }, EVENT_KEEPALIVE_MS).unref()
    } catch {
      // Worker already stopping; deliver anyway.
    }
    worker.send(CHANNEL_EVENT, name, ...args)
  }
}

function matchesFilter(c: ExtensionContext, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true
  const f = raw as Record<string, unknown>
  const has = (key: string, value: unknown) => {
    const list = f[key]
    return !Array.isArray(list) || list.includes(value)
  }
  if (typeof f.incognito === 'boolean' && f.incognito !== c.incognito) return false
  return (
    has('contextTypes', c.contextType) &&
    has('contextIds', c.contextId) &&
    has('tabIds', c.tabId) &&
    has('windowIds', c.windowId) &&
    has('documentIds', c.documentId) &&
    has('frameIds', c.frameId) &&
    has('documentUrls', c.documentUrl) &&
    has('documentOrigins', c.documentOrigin)
  )
}

function extensionIdOf(url: string): string | null {
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)
  return m ? m[1]! : null
}
