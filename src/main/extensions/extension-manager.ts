import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserWindow,
  dialog,
  nativeImage,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItem,
  type Session,
  type WebContents
} from 'electron'
import type { ImportBrowser, ImportSourceSummary } from '@shared/ext-import'
import type { Translate } from '@shared/i18n'
import type { ExtensionInfo } from '@shared/types'
import { describeError, LocalizedError } from '../app/i18n'
import type { ExtensionRecord } from '../persistence/records'
import type { SessionStore } from '../persistence/session-store'
import type { TabManager } from '../tabs/tab-manager'
import type { BrowserWindowController } from '../windows/browser-window'
import type { ShellSync } from '../windows/shell-sync'
import {
  browserName,
  importRoots,
  scanImportSources,
  skipReasonText,
  summarize,
  type ImportCandidate,
  type ImportSource
} from './browser-import'
import { ExtensionCompat } from './compat'
import { installCopy, readManifest, removeCopy, replaceCopy, type ManifestSummary } from './installer'
import { fitPopup } from './popup-fit'

type ExtensionsLib = typeof import('electron-chrome-extensions')

const STARTUP_LISTENERS_KEY = 'extensions.startupListeners'
/** Extensions that listen for runtime.onStartup are woken this long after launch. */
const STARTUP_WAKE_DELAY_MS = 3000
type ExtensionsApi = InstanceType<ExtensionsLib['ElectronChromeExtensions']>

/** One extension of a browser import. `id` is ours (the source's id when the manifest has a key). */
export interface ImportResult {
  id: string
  sourceId: string
  name: string
  version: string
  error: string | null
}

export interface ExtensionHost {
  tabs: TabManager
  window(): BrowserWindowController | null
  shell: ShellSync
  confirm(message: string, detail: string): Promise<boolean>
  /** Current-language translator (read on each use; the language can change). */
  readonly t: Translate
}

/**
 * Unpacked Chrome extensions. Electron provides the core extension runtime
 * (content scripts, service workers, storage, runtime messaging);
 * electron-chrome-extensions adds tabs/windows/action/contextMenus/…
 *
 * The library injects a preload into every frame of the session, so it is
 * imported and instantiated only once an extension is actually enabled:
 * without extensions, pages pay nothing.
 */
export class ExtensionManager {
  private readonly records = new Map<string, ExtensionRecord>()
  private readonly manifests = new Map<string, ManifestSummary>()
  private readonly icons = new Map<string, string | null>()
  private readonly errors = new Map<string, string>()
  private importing = false
  private api: ExtensionsApi | null = null
  private apiLoading: Promise<ExtensionsApi> | null = null
  private readonly compat: ExtensionCompat
  readonly dir: string

  constructor(
    private readonly store: SessionStore,
    private readonly ses: Session,
    readonly partition: string,
    userData: string,
    compatPreload: string,
    private readonly host: ExtensionHost
  ) {
    this.dir = join(userData, 'Extensions')
    for (const r of store.loadExtensions()) this.records.set(r.id, r)
    const startupListeners = store.loadSettings().get(STARTUP_LISTENERS_KEY)
    this.compat = new ExtensionCompat(
      ses,
      compatPreload,
      Array.isArray(startupListeners) ? startupListeners.filter((x): x is string => typeof x === 'string') : [],
      (ids) => store.saveSetting(STARTUP_LISTENERS_KEY, ids),
      {
        isTab: (wc) => host.tabs.tabIdFor(wc) !== undefined,
        mainWindowId: () => host.window()?.win.id ?? -1
      }
    )
  }

  get loaded(): boolean {
    return this.api !== null
  }

  /** Load every enabled extension. Resolves once all are registered. */
  async init(): Promise<void> {
    const enabled = [...this.records.values()].filter((r) => r.enabled)
    await Promise.all([...this.records.values()].map((r) => this.refreshManifest(r)))
    if (enabled.length > 0) {
      await this.ensureApi()
      await Promise.all(enabled.map((r) => this.load(r)))
      // Deferred so waking background workers never competes with first paint.
      setTimeout(() => this.compat.wakeStartupListeners(enabled.map((r) => r.id)), STARTUP_WAKE_DELAY_MS).unref()
    }
    this.emit()
  }

  info(): ExtensionInfo[] {
    return [...this.records.values()].map((r) => {
      const m = this.manifests.get(r.id)
      return {
        id: r.id,
        name: m?.name || r.name,
        version: m?.version || r.version,
        description: m?.description ?? '',
        manifestVersion: m?.manifestVersion ?? 3,
        enabled: r.enabled,
        pinned: r.pinned,
        hasAction: m?.hasAction ?? false,
        permissions: m?.permissions ?? [],
        hostPermissions: m?.hostPermissions ?? [],
        sourcePath: r.sourcePath,
        installedAt: r.installedAt,
        error: this.errors.get(r.id) ?? null,
        icon: this.icons.get(r.id) ?? null,
        optionsUrl: m?.optionsPage ? `chrome-extension://${r.id}/${m.optionsPage.replace(/^\//, '')}` : null
      }
    })
  }

  // -- user actions ------------------------------------------------------------

  async installFromDialog(parent: BaseWindow | null): Promise<ExtensionInfo | null> {
    const options: Electron.OpenDialogOptions = {
      title: this.host.t('dialog.pickExtension.title'),
      message: this.host.t('dialog.pickExtension.message'),
      properties: ['openDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const source = result.filePaths[0]
    if (result.canceled || !source) return null
    return this.install(source)
  }

  /** Install (or update, for an id already present) from a folder. New installs are pinned unless `opts.pinned` says otherwise. */
  async install(source: string, opts: { pinned?: boolean } = {}): Promise<ExtensionInfo> {
    const installDir = await installCopy(source, this.dir)
    await this.ensureApi()
    let extension: Electron.Extension
    try {
      extension = await this.ses.extensions.loadExtension(installDir, { allowFileAccess: false })
    } catch (error) {
      await removeCopy(installDir, this.dir)
      throw error
    }
    const previous = this.records.get(extension.id)
    if (previous && previous.path !== installDir) {
      // Same id (manifest "key") installed again: treat as an update.
      await removeCopy(previous.path, this.dir)
    }
    const record: ExtensionRecord = {
      id: extension.id,
      name: extension.name,
      version: extension.version,
      path: installDir,
      sourcePath: source,
      enabled: true,
      pinned: previous?.pinned ?? opts.pinned ?? true,
      installedAt: previous?.installedAt ?? Date.now()
    }
    this.records.set(record.id, record)
    this.store.saveExtension(record)
    this.errors.delete(record.id)
    this.compat.markInstalled(record.id, previous ? { reason: 'update', previousVersion: previous.version } : { reason: 'install' })
    await this.refreshManifest(record)
    this.emit()
    return this.info().find((i) => i.id === record.id)!
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = this.records.get(id)
    if (!record || record.enabled === enabled) return
    record.enabled = enabled
    this.store.saveExtension(record)
    if (enabled) {
      await this.ensureApi()
      await this.load(record)
    } else if (this.ses.extensions.getExtension(id)) {
      this.ses.extensions.removeExtension(id)
    }
    this.emit()
  }

  setPinned(id: string, pinned: boolean): void {
    const record = this.records.get(id)
    if (!record || record.pinned === pinned) return
    record.pinned = pinned
    this.store.saveExtension(record)
    this.emit()
  }

  async uninstall(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    if (this.ses.extensions.getExtension(id)) this.ses.extensions.removeExtension(id)
    this.records.delete(id)
    this.compat.forget(id)
    this.manifests.delete(id)
    this.icons.delete(id)
    this.errors.delete(id)
    this.store.deleteExtension(id)
    await removeCopy(record.path, this.dir)
    await this.clearData(id)
    this.emit()
  }

  /** Re-import from the original folder, keeping the extension id and data. */
  async update(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    if (!existsSync(record.sourcePath)) throw new LocalizedError('install.sourceMissing', { path: record.sourcePath })
    const wasLoaded = Boolean(this.ses.extensions.getExtension(id))
    const previousVersion = record.version
    if (wasLoaded) this.ses.extensions.removeExtension(id)
    const swap = await replaceCopy(record.sourcePath, record.path)
    try {
      if (record.enabled) {
        await this.ensureApi()
        const ext = await this.ses.extensions.loadExtension(record.path, { allowFileAccess: false })
        record.version = ext.version
        record.name = ext.name
        this.compat.markInstalled(id, { reason: 'update', previousVersion })
      }
      await swap.commit()
    } catch (error) {
      await swap.rollback()
      if (wasLoaded) await this.load(record)
      throw error
    }
    this.store.saveExtension(record)
    this.errors.delete(id)
    await this.refreshManifest(record)
    this.emit()
  }

  // -- importing from Arc / Chrome ------------------------------------------------

  /** Read-only scan of the other browsers' last-used profiles. */
  importSources(): Promise<ImportSource[]> {
    return scanImportSources(new Set(this.records.keys()))
  }

  async importSummaries(): Promise<ImportSourceSummary[]> {
    return (await this.importSources()).map(summarize)
  }

  /**
   * Install every importable extension of one browser, one after another,
   * exactly as "Load unpacked" would. No dialogs (tests call this directly).
   * Null when that browser has nothing to offer.
   */
  async importFrom(sourceId: ImportBrowser): Promise<{ source: ImportSource; results: ImportResult[] } | null> {
    const source = (await this.importSources()).find((s) => s.id === sourceId)
    if (!source) return null
    return { source, results: await this.importCandidates(source.extensions.filter((c) => !c.skip)) }
  }

  /** The Extensions page / palette flow: confirm, import, report — native dialogs only. */
  async importFromDialog(sourceId: ImportBrowser, parent: BaseWindow | null): Promise<void> {
    if (this.importing) return
    this.importing = true
    try {
      await this.runImportDialogs(sourceId, parent)
    } finally {
      this.importing = false
    }
  }

  private async runImportDialogs(sourceId: ImportBrowser, parent: BaseWindow | null): Promise<void> {
    const t = this.host.t
    const show = (options: Electron.MessageBoxOptions) =>
      parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
    const browser = browserName(sourceId)
    const source = (await this.importSources()).find((s) => s.id === sourceId)
    if (!source) {
      const root = importRoots().find((r) => r.browser === sourceId)?.root ?? ''
      await show({
        type: 'info',
        message: t('extImport.notFound.message', { browser }),
        detail: t('extImport.notFound.detail', { browser, path: root })
      })
      return
    }

    const toImport = source.extensions.filter((c) => !c.skip)
    const skipped = source.extensions.filter((c) => c.skip)
    const skippedLines = (list: ImportCandidate[]) =>
      list.map((c) => `• ${t('extImport.itemWithReason', { name: c.name, reason: skipReasonText(c, browser, t) })}`)
    const profile = source.profileName
    if (toImport.length === 0) {
      await show({
        type: 'info',
        message: t('extImport.nothing.message', { browser, profile }),
        detail: [t('extImport.confirm.skipped', { count: skipped.length }), ...skippedLines(skipped)].join('\n')
      })
      return
    }

    const confirmDetail = [
      t('extImport.confirm.toImport', { count: toImport.length }),
      ...toImport.map((c) => `• ${t('extImport.item', { name: c.name, version: c.version })}`),
      ...(skipped.length > 0 ? ['', t('extImport.confirm.skipped', { count: skipped.length }), ...skippedLines(skipped)] : []),
      '',
      t('extImport.confirm.note', { browser })
    ]
    const answer = await show({
      type: 'question',
      message: t('extImport.confirm.message', { browser, profile }),
      detail: confirmDetail.join('\n'),
      buttons: [t('extImport.confirm.import'), t('common.cancel')],
      defaultId: 0,
      cancelId: 1
    })
    if (answer.response !== 0) return

    const results = await this.importCandidates(toImport)
    const failed = results.filter((r) => r.error !== null)
    const message =
      failed.length === 0
        ? t('extImport.result.done', { browser })
        : failed.length === results.length
          ? t('extImport.result.failed', { browser })
          : t('extImport.result.partial', { browser })
    const resultDetail = [
      t('extImport.result.count', { count: results.length - failed.length, total: results.length }),
      ...(failed.length > 0
        ? [
            '',
            t('extImport.result.failedHeading', { count: failed.length }),
            ...failed.map((r) => `• ${t('extImport.itemWithReason', { name: r.name, reason: r.error ?? '' })}`)
          ]
        : []),
      '',
      t('extImport.result.dataNote', { browser })
    ]
    await show({ type: failed.length > 0 ? 'warning' : 'info', message, detail: resultDetail.join('\n') })
  }

  private async importCandidates(candidates: ImportCandidate[]): Promise<ImportResult[]> {
    const results: ImportResult[] = []
    // Sequential on purpose: each install wakes the extension's worker.
    for (const c of candidates) {
      try {
        const info = await this.install(c.sourcePath, { pinned: c.pinnedInSource })
        results.push({ id: info.id, sourceId: c.id, name: info.name, version: info.version, error: null })
      } catch (error) {
        results.push({ id: c.id, sourceId: c.id, name: c.name, version: c.version, error: describeError(error, this.host.t) })
      }
    }
    return results
  }

  openOptions(id: string): void {
    const url = this.info().find((i) => i.id === id)?.optionsUrl
    if (url && this.records.get(id)?.enabled) this.host.tabs.createTab({ url })
  }

  /** Called on quit: release anything that would hold up Chromium's shutdown. */
  shutdown(): void {
    this.compat.shutdown()
    // Unloading extensions stops their workers and hosts now; left running,
    // they can hold up Chromium's shutdown for seconds.
    for (const ext of this.ses.extensions.getAllExtensions()) this.ses.extensions.removeExtension(ext.id)
  }

  /** crx://extension-icon/… requests from the shell (action buttons). */
  handleIconRequest(request: Request): Response | Promise<Response> {
    // The library keeps its API objects private; this is its documented
    // CRX handler minus the partition lookup (we have one extension session).
    const api = (this.api as unknown as { api?: { browserAction: { handleCRXRequest(r: Request): Response } } } | null)?.api
    return api ? api.browserAction.handleCRXRequest(request) : new Response(null, { status: 404 })
  }

  contextMenuItems(wc: WebContents, params: ContextMenuParams): MenuItem[] {
    return this.api?.getContextMenuItems(wc, params) ?? []
  }

  // -- tab integration -----------------------------------------------------------

  tabCreated(wc: WebContents): void {
    const win = this.host.window()
    if (this.api && win && wc.session === this.ses) this.api.addTab(wc, win.win)
  }

  tabSelected(wc: WebContents | null): void {
    if (this.api && wc && !wc.isDestroyed() && wc.session === this.ses) this.api.selectTab(wc)
  }

  // -- internals -------------------------------------------------------------------

  private async load(record: ExtensionRecord): Promise<void> {
    if (this.ses.extensions.getExtension(record.id)) return
    try {
      const ext = await this.ses.extensions.loadExtension(record.path, { allowFileAccess: false })
      this.errors.delete(record.id)
      if (ext.version !== record.version) {
        record.version = ext.version
        this.store.saveExtension(record)
      }
    } catch (error) {
      this.errors.set(record.id, describeError(error, this.host.t))
    }
  }

  private async refreshManifest(record: ExtensionRecord): Promise<void> {
    try {
      const summary = await readManifest(record.path)
      this.manifests.set(record.id, summary)
      let icon: string | null = null
      if (summary.iconPath) {
        const image = nativeImage.createFromPath(summary.iconPath)
        if (!image.isEmpty()) icon = image.resize({ width: 32, height: 32, quality: 'best' }).toDataURL()
      }
      this.icons.set(record.id, icon)
    } catch (error) {
      this.errors.set(record.id, describeError(error, this.host.t))
    }
  }

  private async clearData(id: string): Promise<void> {
    const origin = `chrome-extension://${id}`
    await this.ses.clearStorageData({ origin }).catch(() => undefined)
    const storagePath = this.ses.storagePath
    if (storagePath) {
      for (const sub of ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings']) {
        await rm(join(storagePath, sub, id), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  private emit(): void {
    this.host.shell.extensions(this.info())
  }

  private ensureApi(): Promise<ExtensionsApi> {
    if (this.api) return Promise.resolve(this.api)
    this.apiLoading ??= this.createApi()
    return this.apiLoading
  }

  private async createApi(): Promise<ExtensionsApi> {
    const { ElectronChromeExtensions } = await import('electron-chrome-extensions')
    const { tabs } = this.host
    const mainWindow = () => {
      const win = this.host.window()
      if (!win) throw new Error('No browser window')
      return win.win
    }
    const api = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: this.ses,
      createTab: async (details) => {
        const tab = tabs.createTab({
          url: details.url,
          background: details.active === false,
          pinned: details.pinned ?? false
        })
        const rt = tabs.runtime(tab.id)
        if (!rt) throw new Error('Tab has no WebContents')
        return [rt.wc, mainWindow()]
      },
      selectTab: (wc) => {
        const id = tabs.tabIdFor(wc)
        if (id) tabs.activateTab(id)
      },
      removeTab: (wc) => {
        const id = tabs.tabIdFor(wc)
        if (id) tabs.closeTab(id)
      },
      createWindow: async (details) => this.createWindow(details, mainWindow),
      removeWindow: (win) => {
        if (win !== this.host.window()?.win && !win.isDestroyed()) win.close()
      },
      requestPermissions: async (extension, permissions) => {
        const list = [...(permissions.permissions ?? []), ...(permissions.origins ?? [])]
        const t = this.host.t
        return this.host.confirm(
          t('dialog.extPermissions.title', { name: extension.name }),
          list.join('\n') || t('dialog.extPermissions.none')
        )
      },
      assignTabDetails: (details, wc) => {
        const id = tabs.tabIdFor(wc)
        const tab = id ? tabs.model.getTab(id) : undefined
        if (tab) details.pinned = tab.pinned
      }
    })
    // After the library's preload so our shims see its chrome.* objects.
    this.compat.install()
    api.on('browser-action-popup-created', (popup) => fitPopup(popup))
    this.api = api
    const win = this.host.window()
    if (win) {
      for (const rt of tabs.liveRuntimes()) api.addTab(rt.wc, win.win)
      const active = tabs.activeRuntime()
      if (active) api.selectTab(active.wc)
    }
    return api
  }

  /** chrome.windows.create: popups get their own window, normal windows become tabs. */
  private async createWindow(details: chrome.windows.CreateData, mainWindow: () => BaseWindow): Promise<BaseWindow> {
    const urls = Array.isArray(details.url) ? details.url : details.url ? [details.url] : []
    if (details.type !== 'popup' && details.type !== 'panel') {
      for (const url of urls) this.host.tabs.createTab({ url })
      return mainWindow()
    }
    const win = new BrowserWindow({
      width: details.width ?? 420,
      height: details.height ?? 640,
      ...(details.left !== undefined && details.top !== undefined ? { x: details.left, y: details.top } : {}),
      show: details.focused !== false,
      backgroundColor: '#ffffff',
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    this.api?.addTab(win.webContents, win)
    void win.loadURL(urls[0] ?? 'about:blank').catch(() => undefined)
    return win
  }
}
