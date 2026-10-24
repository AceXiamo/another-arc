import { BrowserWindow, ipcMain, webContents, type IpcMainEvent, type ServiceWorkerMain, type Session, type WebContents } from 'electron'

const CHANNEL_EVENT = 'arc-compat:event'
const CHANNEL_STORAGE = 'arc-compat:storage'
const CHANNEL_LISTENER = 'arc-compat:listener'
const CHANNEL_CONTEXTS = 'arc-compat:getContexts'
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
}

export interface InstalledDetails {
  reason: 'install' | 'update'
  previousVersion?: string
}

/**
 * Main-process half of src/preload/extension-compat.ts: delivers
 * runtime.onInstalled / onStartup and forwards extension-page storage
 * changes to the extension's service worker.
 */
export class ExtensionCompat {
  private readonly pendingInstalled = new Map<string, InstalledDetails>()
  private readonly startedThisSession = new Set<string>()
  private readonly hooked = new WeakSet<ServiceWorkerMain>()
  private readonly startupListeners: Set<string>
  private installed = false
  private readonly keepAlive = new Set<{ end(): void }>()

  constructor(
    private readonly ses: Session,
    private readonly preloadPath: string,
    startupListeners: string[],
    private readonly persistStartupListeners: (ids: string[]) => void,
    private readonly contextHost: ContextHost
  ) {
    this.startupListeners = new Set(startupListeners)
  }

  /** Register preloads and listeners. Must run before extensions load. */
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
      const popup = !isTab && BrowserWindow.fromWebContents(wc)
      const contextType: ExtensionContext['contextType'] = isTab
        ? 'TAB'
        : wc.getType() === 'backgroundPage'
          ? 'BACKGROUND'
          : popup
            ? 'POPUP'
            : 'OFFSCREEN_DOCUMENT'
      out.push({
        contextType,
        contextId: `wc-${wc.id}`,
        tabId: isTab ? wc.id : -1,
        windowId: isTab ? this.contextHost.mainWindowId() : popup ? popup.id : -1,
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
