import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItem,
  type Session,
  shell,
  type WebContents
} from 'electron'
import type { ImportBrowser, ImportSourceSummary } from '@shared/ext-import'
import type { Translate } from '@shared/i18n'
import type { ExtensionDetails, ExtensionError, ExtensionInfo } from '@shared/types'
import { describeError, LocalizedError } from '../app/i18n'
import type { ExtensionRecord } from '../persistence/records'
import { chromeUserAgent } from '../profiles/profile-manager'
import type { SessionStore } from '../persistence/session-store'
import type { TabManager } from '../tabs/tab-manager'
import type { BrowserWindowController } from '../windows/browser-window'
import type { ShellSync } from '../windows/shell-sync'
import { browserName, browserRoot, type BrowserProfile } from '../import/browsers'
import {
  scanImportSources,
  scanSource,
  skipReasonText,
  summarize,
  type ImportCandidate,
  type ImportSource
} from './browser-import'
import type { DownloadManager } from '../downloads/download-manager'
import { ExtensionCompat } from './compat'
import { ExtensionDownloads } from './downloads'
import { ExtensionWindows, type ExtensionSurface, type StoredPlacement } from './extension-window'
import { ensureUserScriptsSupport, installCopy, readManifest, removeCopy, replaceCopy, type ManifestSummary } from './installer'
import { fitPopup } from './popup-fit'
import { originsCovered } from './match-pattern'
import { reservedCommandFor } from '../shortcuts/keymap'
import { ExtensionShortcuts, formatShortcut, parseShortcut } from './shortcuts'
import { SidePanelState } from './side-panel'
import { UserScriptError, UserScriptStore } from './user-scripts'
import { downloadFromWebStore, webStoreIdOf } from './web-store'
import type { KeyLike } from '../shortcuts/keymap'
import type { Rect } from './window-placement'

type ExtensionsLib = typeof import('electron-chrome-extensions')
type ShortcutResult = 'ok' | 'invalid' | 'reserved'

const STARTUP_LISTENERS_KEY = 'extensions.startupListeners'
const SIDE_PANEL_KEY = 'extensions.sidePanel'
const WINDOW_PLACEMENT_KEY = 'extensions.windowPlacement'
/** Extensions the user let run user scripts ("Allow User Scripts"). */
const USER_SCRIPTS_KEY = 'extensions.userScriptsAllowed'
/** Extensions allowed to run on file:// URLs ("Allow access to file URLs"). */
const FILE_ACCESS_KEY = 'extensions.fileAccess'
/** The user's keyboard shortcuts for extension commands. */
const SHORTCUTS_KEY = 'extensions.shortcuts'
/** Errors kept per extension, newest last (like chrome://extensions "Errors"). */
const MAX_ERRORS = 50
/** The page learns of new errors at most this often. */
const ERROR_EMIT_MS = 1500
/** At launch, how long the first page may wait for user scripts to be registered again. */
const USER_SCRIPTS_WAIT_MS = 1500
/** A reload waits this long at most for the old worker to stop. */
const WORKER_STOP_WAIT_MS = 3000
/** Extensions that listen for runtime.onStartup are woken this long after launch. */
const STARTUP_WAKE_DELAY_MS = 3000
type ExtensionsApi = InstanceType<ExtensionsLib['ElectronChromeExtensions']>

/** What the shell sends with `browserAction.activate` (plus our `toggle`). */
interface ActivateDetails {
  extensionId: string
  tabId?: number
  anchorRect?: Rect
  /** A click on our toolbar button: a second click closes the window. */
  toggle?: boolean
}

/**
 * The parts of the library's (private) BrowserActionAPI that action clicks
 * need. Checked at runtime in `routeActionClicks`.
 */
interface BrowserActionInternals {
  activateClick(details: ActivateDetails): void
  getPopupUrl(extensionId: string, tabId: number): string | undefined
  ctx: {
    store: {
      getTabById(id: number): WebContents | undefined
      getActiveTabOfCurrentWindow(): WebContents | undefined
      tabDetailsCache: Map<number, unknown>
      createWindow(event: { extension?: { url?: string } }, details: chrome.windows.CreateData): Promise<BaseWindow>
    }
    router: { sendEvent(extensionId: string, eventName: string, ...args: unknown[]): void }
  }
}

type ActionTarget = { kind: ExtensionSurface; url: string } | { kind: 'event' }

/** The library's PopupView, only used if routing action clicks ever fails. */
interface LibraryPopup {
  browserWindow?: BrowserWindow
  isDestroyed(): boolean
  setSize(rect: { width?: number; height?: number }): void
  updatePosition?(): void
  show?(): void
}

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
  downloads: DownloadManager
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
  private readonly downloads: ExtensionDownloads
  private readonly sidePanel: SidePanelState
  private readonly windows: ExtensionWindows
  private readonly placements = new Map<string, StoredPlacement>()
  private readonly userScripts: UserScriptStore
  private readonly userScriptsAllowed: Set<string>
  private readonly fileAccess: Set<string>
  private readonly shortcuts: ExtensionShortcuts
  private readonly runtimeErrors = new Map<string, Array<ExtensionError & { versionId: number }>>()
  /** Workers of unloaded extensions: what they log while they wind down is not the new one's. */
  private readonly retiredWorkers = new Set<number>()
  private errorEmit: NodeJS.Timeout | null = null
  /** Extensions whose worker is putting user scripts back, resolved when it is done. */
  private readonly hydrating = new Map<string, () => void>()
  private actions: BrowserActionInternals | null = null
  /** The library's record of granted permissions (optional ones once granted). */
  private granted: Map<string, { permissions: string[]; origins: string[] }> | null = null
  private recording = false
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
    const settings = store.loadSettings()
    this.userScripts = new UserScriptStore(join(userData, 'User Scripts'), (id) => this.records.get(id)?.path ?? null)
    this.userScriptsAllowed = new Set(stringList(settings.get(USER_SCRIPTS_KEY)))
    this.fileAccess = new Set(stringList(settings.get(FILE_ACCESS_KEY)))
    this.shortcuts = new ExtensionShortcuts(settings.get(SHORTCUTS_KEY), (all) => store.saveSetting(SHORTCUTS_KEY, all))
    // Errors from extension workers, for the Extensions page. Level 3 is "error".
    ses.serviceWorkers.on('console-message', (_event, details) => {
      if (details.level < 3 || this.retiredWorkers.has(details.versionId)) return
      const scope = ses.serviceWorkers.getInfoFromVersionID(details.versionId)?.scope ?? details.sourceUrl
      const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(scope)?.[1]
      if (!id || !this.records.has(id)) return
      // Chromium's answer to a worker that is not the extension's own any
      // more (a reload overtook it): everything it logs now is noise.
      if (details.message.includes('No SW')) {
        this.retiredWorkers.add(details.versionId)
        const list = this.runtimeErrors.get(id)
        if (list) this.runtimeErrors.set(id, list.filter((e) => e.versionId !== details.versionId))
        return
      }
      this.addError(id, details.message, details.sourceUrl, details.lineNumber, details.versionId)
    })
    const startupListeners = settings.get(STARTUP_LISTENERS_KEY)
    this.sidePanel = new SidePanelState(settings.get(SIDE_PANEL_KEY), {
      defaultPath: (id) => {
        const manifest = ses.extensions.getExtension(id)?.manifest as { side_panel?: { default_path?: unknown } } | undefined
        const path = manifest?.side_panel?.default_path
        return typeof path === 'string' && path ? path : null
      },
      persist: (all) => store.saveSetting(SIDE_PANEL_KEY, all)
    })
    const placements = settings.get(WINDOW_PLACEMENT_KEY)
    if (placements && typeof placements === 'object') {
      for (const [id, p] of Object.entries(placements as Record<string, StoredPlacement>)) {
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) this.placements.set(id, p)
      }
    }
    this.windows = new ExtensionWindows({
      session: ses,
      parent: () => host.window()?.win ?? null,
      title: (id) => this.manifests.get(id)?.name || this.records.get(id)?.name || host.t('extWindow.fallbackTitle'),
      get t() {
        return host.t
      },
      inactive: process.env.ARC_TEST === '1',
      placement: (id) => this.placements.get(id),
      savePlacement: (id, placement) => {
        this.placements.set(id, placement)
        store.saveSetting(WINDOW_PLACEMENT_KEY, Object.fromEntries(this.placements))
      },
      openTab: (url, background) => void host.tabs.createTab({ url, background }),
      opened: (id, surface, url) => this.windowChanged(id, surface, url, true),
      closed: (id, surface, url) => this.windowChanged(id, surface, url, false)
    })
    this.downloads = new ExtensionDownloads(ses, host.downloads, {
      extension: (id) => {
        const ext = ses.extensions.getExtension(id)
        return ext ? { name: ext.name, permissions: this.grantedPermissions(ext) } : null
      },
      listeners: () =>
        ses.extensions
          .getAllExtensions()
          .filter((ext) => this.grantedPermissions(ext).includes('downloads'))
          .map((ext) => ext.id),
      emit: (ids, name, payload, wake) => this.compat.downloadsEvent(ids, name, payload, wake),
      exists: existsSync
    })
    this.compat = new ExtensionCompat(
      ses,
      compatPreload,
      Array.isArray(startupListeners) ? startupListeners.filter((x): x is string => typeof x === 'string') : [],
      (ids) => store.saveSetting(STARTUP_LISTENERS_KEY, ids),
      {
        isTab: (wc) => host.tabs.tabIdFor(wc) !== undefined,
        mainWindowId: () => host.window()?.win.id ?? -1,
        surfaceOf: (wc) => {
          const surface = this.windows.surfaceOf(wc)
          return surface === 'panel' ? 'SIDE_PANEL' : surface === 'popup' ? 'POPUP' : null
        }
      },
      { call: (id, method, arg) => this.sidePanelCall(id, method, arg) },
      { allowed: (id) => this.userScriptsOn(id), call: (id, method, args) => this.userScriptsCall(id, method, args) },
      { call: (id, method, args) => this.downloads.call(id, method, args) }
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
      for (const r of enabled) this.syncCommands(r.id)
      // Not deferred: workers put the user scripts back (Electron forgets
      // them), and the first page waits for that like for content scripts.
      await Promise.race([
        Promise.all(enabled.map((r) => this.startUserScripts(r.id))),
        new Promise((r) => setTimeout(r, USER_SCRIPTS_WAIT_MS).unref())
      ])
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
        optionsUrl: m?.optionsPage ? `chrome-extension://${r.id}/${m.optionsPage.replace(/^\//, '')}` : null,
        windowOpen: this.windows.has(r.id),
        userScripts: this.requestsUserScripts(r.id) ? this.userScriptsOn(r.id) : null,
        fileAccess: this.fileAccess.has(r.id),
        commands: this.shortcuts.list(r.id),
        errorCount: (this.errors.has(r.id) ? 1 : 0) + (this.runtimeErrors.get(r.id)?.length ?? 0),
        fromStore: webStoreIdOf(r.sourcePath) !== null
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

  /**
   * Install (or update, for an id already present) from a folder. New installs
   * are pinned unless `opts.pinned` says otherwise. `opts.sourcePath` records
   * where updates come from when `source` is temporary (a store download).
   */
  async install(source: string, opts: { pinned?: boolean; sourcePath?: string } = {}): Promise<ExtensionInfo> {
    const installDir = await installCopy(source, this.dir)
    await ensureUserScriptsSupport(installDir).catch(() => false)
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
      sourcePath: opts.sourcePath ?? source,
      enabled: true,
      pinned: previous?.pinned ?? opts.pinned ?? true,
      installedAt: previous?.installedAt ?? Date.now()
    }
    this.records.set(record.id, record)
    this.store.saveExtension(record)
    this.errors.delete(record.id)
    this.compat.markInstalled(record.id, previous ? { reason: 'update', previousVersion: previous.version } : { reason: 'install' })
    await this.refreshManifest(record)
    this.syncCommands(record.id)
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
      void this.startUserScripts(id)
    } else {
      this.windows.close(id)
      this.retireWorkers(id)
      if (this.ses.extensions.getExtension(id)) this.ses.extensions.removeExtension(id)
    }
    this.syncCommands(id)
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
    this.windows.close(id)
    if (this.ses.extensions.getExtension(id)) this.ses.extensions.removeExtension(id)
    this.records.delete(id)
    this.compat.forget(id)
    this.sidePanel.forget(id)
    if (this.userScriptsAllowed.delete(id)) this.store.saveSetting(USER_SCRIPTS_KEY, [...this.userScriptsAllowed])
    if (this.fileAccess.delete(id)) this.store.saveSetting(FILE_ACCESS_KEY, [...this.fileAccess])
    this.shortcuts.forget(id)
    this.runtimeErrors.delete(id)
    await this.userScripts.forget(id)
    if (this.placements.delete(id)) this.store.saveSetting(WINDOW_PLACEMENT_KEY, Object.fromEntries(this.placements))
    this.manifests.delete(id)
    this.icons.delete(id)
    this.errors.delete(id)
    this.store.deleteExtension(id)
    await removeCopy(record.path, this.dir)
    await this.clearData(id)
    this.emit()
  }

  /**
   * Re-import from the original folder, or download the current version from
   * the Chrome Web Store for store installs, keeping the extension id and data.
   */
  async update(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record) return
    const storeId = webStoreIdOf(record.sourcePath)
    if (!storeId && !existsSync(record.sourcePath)) throw new LocalizedError('install.sourceMissing', { path: record.sourcePath })
    const source = storeId ? await downloadFromWebStore(this.ses, storeId) : record.sourcePath
    try {
      await this.replaceFrom(record, source)
    } finally {
      if (storeId) await rm(source, { recursive: true, force: true })
    }
  }

  private async replaceFrom(record: ExtensionRecord, source: string): Promise<void> {
    const id = record.id
    const wasLoaded = Boolean(this.ses.extensions.getExtension(id))
    const previousVersion = record.version
    this.windows.close(id)
    this.retireWorkers(id)
    if (wasLoaded) this.ses.extensions.removeExtension(id)
    const swap = await replaceCopy(source, record.path)
    await ensureUserScriptsSupport(record.path).catch(() => false)
    try {
      if (record.enabled) {
        await this.ensureApi()
        const ext = await this.ses.extensions.loadExtension(record.path, { allowFileAccess: this.fileAccess.has(id) })
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
    this.syncCommands(id)
    this.emit()
  }

  // -- importing from another browser ---------------------------------------------

  /** Read-only scan of the other browsers' last-used profiles. */
  importSources(): Promise<ImportSource[]> {
    return scanImportSources(new Set(this.records.keys()))
  }

  /** One browser's importable extensions, for a profile of the caller's choosing. */
  sourceFor(sourceId: ImportBrowser, profile?: BrowserProfile): Promise<ImportSource | null> {
    const root = browserRoot(sourceId)
    if (!root) return Promise.resolve(null)
    return scanSource({ browser: sourceId, root }, new Set(this.records.keys()), profile)
  }

  async importSummaries(): Promise<ImportSourceSummary[]> {
    return (await this.importSources()).map(summarize)
  }

  /**
   * Install every importable extension of one browser, one after another,
   * exactly as "Load unpacked" would. No dialogs (tests call this directly).
   * Null when that browser has nothing to offer.
   */
  async importFrom(sourceId: ImportBrowser, profile?: BrowserProfile): Promise<{ source: ImportSource; results: ImportResult[] } | null> {
    const source = await this.sourceFor(sourceId, profile)
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
      const root = browserRoot(sourceId) ?? ''
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

  /**
   * Unload and load again, as Chrome's reload button does: the worker and
   * the extension's pages start over (and pick up a changed setting).
   */
  async reload(id: string): Promise<void> {
    const record = this.records.get(id)
    if (!record?.enabled) return
    this.windows.close(id)
    this.retireWorkers(id)
    if (this.ses.extensions.getExtension(id)) this.ses.extensions.removeExtension(id)
    // Loaded again while its old worker still runs, the extension's new
    // worker is never the active one: its API calls fail ("No SW") until
    // the next launch.
    await this.workersStopped(id)
    await this.ensureApi()
    await this.load(record)
    const prefix = `chrome-extension://${id}/`
    for (const rt of this.host.tabs.liveRuntimes()) {
      if (!rt.wc.isDestroyed() && rt.wc.getURL().startsWith(prefix)) rt.wc.reload()
    }
    void this.startUserScripts(id)
    this.syncCommands(id)
    this.emit()
  }

  /** "Allow User Scripts": the extension is reloaded so chrome.userScripts appears or goes. */
  async setUserScriptsAllowed(id: string, allowed: boolean): Promise<void> {
    if (!this.records.has(id) || this.userScriptsAllowed.has(id) === allowed) return
    if (allowed) this.userScriptsAllowed.add(id)
    else this.userScriptsAllowed.delete(id)
    this.store.saveSetting(USER_SCRIPTS_KEY, [...this.userScriptsAllowed])
    if (this.ses.extensions.getExtension(id)) await this.reload(id)
    else this.emit()
  }

  /** "Allow access to file URLs": Chromium reads it when the extension loads, so it reloads. */
  async setFileAccess(id: string, allowed: boolean): Promise<void> {
    if (!this.records.has(id) || this.fileAccess.has(id) === allowed) return
    if (allowed) this.fileAccess.add(id)
    else this.fileAccess.delete(id)
    this.store.saveSetting(FILE_ACCESS_KEY, [...this.fileAccess])
    if (this.ses.extensions.getExtension(id)) await this.reload(id)
    else this.emit()
  }

  /**
   * Set or clear ('') a command's shortcut. 'reserved': the browser's own
   * shortcut (⌘T, ⌘W…), which always wins, so the command would never run.
   */
  setShortcut(id: string, name: string, shortcut: string): ShortcutResult {
    const parsed = shortcut === '' ? null : parseShortcut(shortcut)
    if (shortcut !== '' && !parsed) return 'invalid'
    if (parsed && reservedCommandFor({ type: 'keyDown', ...parsed })) return 'reserved'
    const changed = this.shortcuts.set(id, name, shortcut)
    if (!changed) return 'invalid'
    for (const changedId of changed) this.syncLibraryCommands(changedId)
    this.emit()
    return 'ok'
  }

  /** The Extensions page is recording a shortcut: keys go to it, not to commands. */
  setRecording(recording: boolean): void {
    this.recording = recording
  }

  /** A command's shortcut was pressed in a page or the shell: true when it was one. */
  handleKey(input: KeyLike): boolean {
    if (this.recording) return false
    const hit = this.shortcuts.match(input)
    if (!hit) return false
    void this.runCommand(hit.id, hit.name).catch((error) => console.error('[extensions] command', error))
    return true
  }

  errorsOf(id: string): ExtensionError[] {
    const load = this.errors.get(id)
    const runtime = (this.runtimeErrors.get(id) ?? []).map(({ versionId: _, ...e }) => e)
    return load ? [{ message: load, source: '', line: 0, at: 0, count: 1 }, ...runtime] : runtime
  }

  clearErrors(id: string): void {
    if (this.runtimeErrors.delete(id)) this.emit()
  }

  /** What the details view shows beyond ExtensionInfo. */
  async details(id: string): Promise<ExtensionDetails | null> {
    const record = this.records.get(id)
    if (!record) return null
    const storeId = webStoreIdOf(record.sourcePath)
    return {
      size: await folderSize(record.path),
      storeUrl: storeId ? `https://chromewebstore.google.com/detail/${storeId}` : null,
      sourceExists: !storeId && existsSync(record.sourcePath),
      errors: this.errorsOf(id)
    }
  }

  /** Show the folder the extension came from (or its installed copy) in Finder. */
  reveal(id: string): void {
    const record = this.records.get(id)
    if (!record) return
    const target = !webStoreIdOf(record.sourcePath) && existsSync(record.sourcePath) ? record.sourcePath : record.path
    shell.showItemInFolder(target)
  }

  /** Called on quit: release anything that would hold up Chromium's shutdown. */
  shutdown(): void {
    this.userScripts.flushSync()
    this.windows.destroyAll()
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
    // The library's tab ids are WebContents ids; drop the tab's side panel options with it.
    const tabId = wc.id
    wc.once('destroyed', () => this.sidePanel.tabRemoved(tabId))
  }

  tabSelected(wc: WebContents | null): void {
    if (this.api && wc && !wc.isDestroyed() && wc.session === this.ses) this.api.selectTab(wc)
  }

  // -- internals -------------------------------------------------------------------

  private async load(record: ExtensionRecord): Promise<void> {
    if (this.ses.extensions.getExtension(record.id)) return
    try {
      await ensureUserScriptsSupport(record.path).catch(() => false)
      const ext = await this.ses.extensions.loadExtension(record.path, { allowFileAccess: this.fileAccess.has(record.id) })
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
    // Extension service workers ignore the session's user agent and report
    // the app's fallback, which says "Electron/x". Some extensions take that
    // for an embedded host: OKX Wallet then trusts none of its own pages and
    // its UI never gets past "Loading". Workers get the same Chrome UA as pages.
    app.userAgentFallback = chromeUserAgent()
    // Before the library's preload, which freezes `chrome` (chrome.sidePanel).
    this.compat.installEarly()
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
    this.routeActionClicks(api)
    this.fixPermissions(api)
    this.api = api
    const win = this.host.window()
    if (win) {
      for (const rt of tabs.liveRuntimes()) api.addTab(rt.wc, win.win)
      const active = tabs.activeRuntime()
      if (active) api.selectTab(active.wc)
    }
    return api
  }

  /**
   * The library's permissions.contains compares requested origins with the
   * host permissions as plain strings: `<all_urls>` did not contain
   * `http://127.0.0.1:8080/`, so Tampermonkey asked for access it has and
   * gave up installing a script. Compare match patterns, as Chrome does, and
   * fire permissions.onAdded when a request is granted.
   */
  private fixPermissions(api: ExtensionsApi): void {
    type Granted = { permissions: string[]; origins: string[] }
    type Handler = (event: { extension?: Electron.Extension }, ...args: any[]) => unknown
    const lib = api as unknown as {
      ctx?: { router?: { handle?(name: string, cb: Handler): void; handlers?: Map<string, { callback: Handler }>; sendEvent?(id: string, name: string, ...args: unknown[]): void } }
      api?: { permissions?: { permissionMap?: Map<string, Granted> } }
    }
    const router = lib.ctx?.router
    const granted = lib.api?.permissions?.permissionMap
    const request = router?.handlers?.get('permissions.request')?.callback
    if (!router?.handle || !router.sendEvent || !(granted instanceof Map) || !request) {
      console.error('[extensions] electron-chrome-extensions internals changed; permissions.contains compares strings')
      return
    }
    const has = (extension: Electron.Extension | undefined, query: { permissions?: unknown; origins?: unknown } | undefined) => {
      const current = extension ? granted.get(extension.id) : undefined
      if (!current) return false
      const permissions = Array.isArray(query?.permissions) ? query.permissions.filter((p): p is string => typeof p === 'string') : []
      const origins = Array.isArray(query?.origins) ? query.origins.filter((o): o is string => typeof o === 'string') : []
      // MV2 lists host patterns among the permissions.
      const hosts = [...current.origins, ...current.permissions.filter((p) => p === '<all_urls>' || p.includes('://'))]
      return permissions.every((p) => current.permissions.includes(p)) && originsCovered(hosts, origins)
    }
    this.granted = granted
    router.handle('permissions.contains', ({ extension }, query) => has(extension, query))
    router.handle('permissions.request', async (event, query: { permissions?: string[]; origins?: string[] } = {}) => {
      // Already granted: Chrome answers without asking.
      if (has(event.extension, query)) return true
      const ok = await request(event, query)
      if (ok === true && event.extension) {
        router.sendEvent!(event.extension.id, 'permissions.onAdded', { permissions: query?.permissions ?? [], origins: query?.origins ?? [] })
      }
      return ok
    })
  }

  /** API permissions `ext` holds now: its manifest's, plus optional ones it was granted. */
  private grantedPermissions(ext: Electron.Extension): string[] {
    return this.granted?.get(ext.id)?.permissions ?? stringList((ext.manifest as { permissions?: unknown }).permissions)
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
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    // `focused: false` still shows the window, just without focus (as in
    // Chrome); integration tests never take focus.
    if (details.focused === false || process.env.ARC_TEST === '1') win.showInactive()
    else win.show()
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.meta && !input.control && !input.alt && input.code === 'KeyW') {
        event.preventDefault()
        win.close()
      }
    })
    this.api?.addTab(win.webContents, win)
    void win.loadURL(urls[0] ?? 'about:blank').catch(() => undefined)
    return win
  }

  // -- action clicks, popups and side panels ------------------------------------

  /**
   * Take over the library's action clicks before it creates its anchored,
   * frameless, non-movable PopupView: popups and side panels open in our
   * extension windows instead. Both the shell's `browserAction.activate` and
   * `chrome.action.openPopup()` go through `activateClick`.
   */
  private routeActionClicks(api: ExtensionsApi): void {
    const ba = (api as unknown as { api?: { browserAction?: Partial<BrowserActionInternals> } }).api?.browserAction
    const store = ba?.ctx?.store
    if (
      !ba ||
      typeof ba.activateClick !== 'function' ||
      typeof ba.getPopupUrl !== 'function' ||
      typeof store?.getTabById !== 'function' ||
      typeof store.getActiveTabOfCurrentWindow !== 'function' ||
      !(store.tabDetailsCache instanceof Map) ||
      typeof ba.ctx?.router?.sendEvent !== 'function'
    ) {
      // Fall back to the library's own popup (sized by us) rather than
      // break action clicks entirely.
      console.error('[extensions] electron-chrome-extensions internals changed; action clicks use its popup')
      api.on('browser-action-popup-created', (popup: LibraryPopup) => {
        const win = popup.browserWindow
        if (!win) return
        fitPopup({
          webContents: win.webContents,
          alive: () => !popup.isDestroyed() && !win.isDestroyed(),
          setContentSize: (width, height) => popup.setSize({ width, height }),
          fitted: () => {
            popup.updatePosition?.()
            popup.show?.()
          },
          userSized: () => false
        })
      })
      return
    }
    const internals = ba as BrowserActionInternals
    this.actions = internals
    internals.activateClick = (details) => {
      void this.activate(internals, details).catch((error) => console.error('[extensions] action click', error))
    }
    this.resolveWindowUrls(internals.ctx.store)
  }

  /**
   * chrome.windows.create resolves relative URLs against the calling
   * extension (wallets open `notification.html`); the library passes them
   * through unresolved, and only our createWindow sees them, without the
   * caller. Resolve them where the caller is still known.
   */
  private resolveWindowUrls(store: BrowserActionInternals['ctx']['store']): void {
    if (typeof store.createWindow !== 'function') return
    const original = store.createWindow.bind(store)
    store.createWindow = (event, details) => {
      const base = event?.extension?.url
      if (!base || !details || details.url === undefined) return original(event, details)
      const resolve = (u: string) => {
        try {
          const href = new URL(u, base).href
          return /^(javascript|chrome):/i.test(href) ? 'about:blank' : href
        } catch {
          return 'about:blank'
        }
      }
      const url = Array.isArray(details.url) ? details.url.map(resolve) : resolve(details.url)
      return original(event, { ...details, url })
    }
  }

  private async activate(ba: BrowserActionInternals, details: ActivateDetails): Promise<void> {
    const id = details?.extensionId
    if (typeof id !== 'string' || !this.ses.extensions.getExtension(id)) return
    if (details.toggle === true && this.windows.has(id)) {
      this.windows.close(id)
      return
    }
    const { store } = ba.ctx
    const tab =
      (typeof details.tabId === 'number' && details.tabId >= 0 ? store.getTabById(details.tabId) : undefined) ??
      store.getActiveTabOfCurrentWindow()
    const tabId = tab && !tab.isDestroyed() ? tab.id : -1
    const anchor = details.anchorRect && isRect(details.anchorRect) ? details.anchorRect : null

    // chrome.action.openPopup(): the popup or nothing, as in Chrome.
    if (details.toggle !== true) {
      const popup = ba.getPopupUrl(id, tabId)
      if (popup) this.windows.show(id, 'popup', popup, anchor)
      return
    }

    let target = this.actionTarget(ba, id, tabId)
    if (target.kind === 'event') {
      // A worker that has not run this session has no listeners yet, and may
      // set a popup or panel behavior as it starts: wake it, then decide.
      await this.compat.ensureStarted(id)
      target = this.actionTarget(ba, id, tabId)
    }
    if (target.kind === 'event') {
      ba.ctx.router.sendEvent(id, 'browserAction.onClicked', tabId >= 0 ? store.tabDetailsCache.get(tabId) : undefined)
    } else {
      this.windows.show(id, target.kind, target.url, anchor)
    }
  }

  /**
   * Chrome's order: the side panel when the extension asked for it on
   * action click, then the popup, then `action.onClicked`. We have no side
   * panel picker, so an extension with a panel but no popup that never said
   * otherwise (setPanelBehavior) gets its panel too.
   */
  private actionTarget(ba: BrowserActionInternals, id: string, tabId: number): ActionTarget {
    const panel = this.sidePanel.panelUrl(id, tabId >= 0 ? tabId : undefined)
    const behavior = this.sidePanel.behavior(id)
    if (panel && behavior === true) return { kind: 'panel', url: panel }
    const popup = ba.getPopupUrl(id, tabId)
    if (popup) return { kind: 'popup', url: popup }
    if (panel && behavior === undefined) return { kind: 'panel', url: panel }
    return { kind: 'event' }
  }

  // -- commands --------------------------------------------------------------------

  /** Bind the commands of a loaded extension; unbind an unloaded one's. */
  private syncCommands(id: string): void {
    const loaded = Boolean(this.ses.extensions.getExtension(id))
    this.shortcuts.setCommands(id, loaded ? (this.manifests.get(id)?.commands ?? []) : [])
    this.syncLibraryCommands(id)
  }

  /** commands.getAll() comes from the library's list; give it the shortcuts. */
  private syncLibraryCommands(id: string): void {
    const commands = (this.api as unknown as { api?: { commands?: { commandMap?: Map<string, Array<{ name: string; shortcut: string }>> } } } | null)
      ?.api?.commands?.commandMap?.get(id)
    if (!commands) return
    const current = new Map(this.shortcuts.list(id).map((c) => [c.name, c.shortcut]))
    for (const c of commands) c.shortcut = formatShortcut(current.get(c.name) ?? '')
  }

  /** chrome.commands: the action and side panel commands, else commands.onCommand. */
  private async runCommand(id: string, name: string): Promise<void> {
    if (!this.ses.extensions.getExtension(id)) return
    const ba = this.actions
    if (name === '_execute_action' || name === '_execute_browser_action' || name === '_execute_page_action') {
      ba?.activateClick({ extensionId: id, toggle: true })
      return
    }
    if (name === '_execute_side_panel') {
      this.sidePanelCall(id, 'open', null)
      return
    }
    if (!ba) return
    // Listeners exist only once the worker has run this session.
    await this.compat.ensureStarted(id)
    const tabId = this.activeTabId()
    ba.ctx.router.sendEvent(id, 'commands.onCommand', name, tabId !== undefined ? ba.ctx.store.tabDetailsCache.get(tabId) : undefined)
  }

  // -- errors ----------------------------------------------------------------------

  /** Resolves once the extension has no running worker (or after WORKER_STOP_WAIT_MS). */
  private async workersStopped(id: string): Promise<void> {
    const prefix = `chrome-extension://${id}/`
    const running = () => Object.values(this.ses.serviceWorkers.getAllRunning()).some((w) => w.scope.startsWith(prefix))
    const deadline = Date.now() + WORKER_STOP_WAIT_MS
    while (running() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  }

  /**
   * About to unload: calls still running in its worker fail ("No SW") and
   * it logs them. Those are not errors of the extension the user sees.
   */
  private retireWorkers(id: string): void {
    const prefix = `chrome-extension://${id}/`
    for (const [versionId, info] of Object.entries(this.ses.serviceWorkers.getAllRunning())) {
      if (info.scope.startsWith(prefix)) this.retiredWorkers.add(Number(versionId))
    }
  }

  private addError(id: string, message: string, source: string, line: number, versionId: number): void {
    let list = this.runtimeErrors.get(id)
    if (!list) this.runtimeErrors.set(id, (list = []))
    const last = list.at(-1)
    // The same error again (a loop): count it instead of filling the list.
    if (last && last.message === message && last.source === source && last.line === line) {
      last.count += 1
      last.at = Date.now()
    } else {
      list.push({ message, source, line, at: Date.now(), count: 1, versionId })
      if (list.length > MAX_ERRORS) list.splice(0, list.length - MAX_ERRORS)
    }
    this.errorEmit ??= setTimeout(() => {
      this.errorEmit = null
      this.emit()
    }, ERROR_EMIT_MS)
  }

  // -- user scripts ----------------------------------------------------------------

  private requestsUserScripts(id: string): boolean {
    return this.manifests.get(id)?.permissions.includes('userScripts') ?? false
  }

  private userScriptsOn(id: string): boolean {
    return this.userScriptsAllowed.has(id) && this.requestsUserScripts(id)
  }

  /**
   * Electron does not keep dynamic content scripts: start the worker, which
   * registers them again. Resolves once it has (or when there is nothing to do).
   */
  private async startUserScripts(id: string): Promise<void> {
    if (!this.userScriptsOn(id) || !this.ses.extensions.getExtension(id)) return
    if ((await this.userScripts.count(id)) === 0) return
    const done = new Promise<void>((resolve) => this.hydrating.set(id, resolve))
    this.compat.start(id)
    await done
  }

  /** chrome.userScripts.* from the extension `id` (see compat.ts / user-scripts.ts). */
  private async userScriptsCall(id: string, method: string, args: unknown[]): Promise<unknown> {
    if (method === 'state') return this.userScriptsOn(id)
    if (method === 'hydrated') {
      this.hydrating.get(id)?.()
      this.hydrating.delete(id)
      return undefined
    }
    if (!this.userScriptsOn(id)) throw new UserScriptError('User scripts are not allowed for this extension (Allow User Scripts is off).')
    const s = this.userScripts
    switch (method) {
      case 'get':
        return s.get(id, args[0])
      case 'prepare':
        return s.prepare(id, args[0] === 'update' ? 'update' : 'register', args[1])
      case 'commit':
        return s.commit(id, String(args[0]))
      case 'discard':
        return s.discard(id, String(args[0]))
      case 'unregister':
        return s.unregister(id, args[0])
      case 'native':
        return s.native(id)
      case 'configureWorld':
        return s.configureWorld(id, args[0])
      case 'getWorlds':
        return s.worlds(id)
      case 'resetWorld':
        return s.resetWorld(id, args[0])
      case 'prepareExecute':
        return s.prepareExecute(id, args[0])
      default:
        throw new UserScriptError(`Unknown userScripts call: ${method}`)
    }
  }

  /** chrome.sidePanel.* from the extension `id` (see compat.ts / side-panel.ts). */
  private sidePanelCall(id: string, method: string, arg: unknown): unknown {
    const panel = this.sidePanel
    switch (method) {
      case 'setPanelBehavior':
        panel.setPanelBehavior(id, arg)
        return undefined
      case 'getPanelBehavior':
        return panel.getPanelBehavior(id)
      case 'setOptions':
        panel.setOptions(id, arg)
        this.syncOpenPanel(id)
        return undefined
      case 'getOptions':
        return panel.getOptions(id, arg)
      case 'open': {
        const tabId = optionalTabId(arg) ?? this.activeTabId()
        const url = panel.panelUrl(id, tabId)
        if (url) this.windows.show(id, 'panel', url, null)
        return undefined
      }
      case 'close':
        this.windows.close(id, 'panel')
        return undefined
      case 'getLayout':
        return { side: 'right' }
      default:
        return undefined
    }
  }

  /** setOptions changed what the open panel should show: follow it, as Chrome does. */
  private syncOpenPanel(id: string): void {
    const open = this.windows.get(id)
    if (!open || open.surface !== 'panel') return
    const url = this.sidePanel.panelUrl(id, this.activeTabId())
    if (url) open.navigate(url)
    else open.close()
  }

  private activeTabId(): number | undefined {
    const wc = this.host.tabs.activeRuntime()?.wc
    return wc && !wc.isDestroyed() ? wc.id : undefined
  }

  private windowChanged(id: string, surface: ExtensionSurface, url: string, open: boolean): void {
    if (surface === 'panel') {
      const windowId = this.host.window()?.win.id ?? -1
      const path = url.replace(`chrome-extension://${id}/`, '')
      this.compat.sidePanelEvent(id, open ? 'onOpened' : 'onClosed', { path, windowId })
    }
    // The toolbar shows which extensions have their window open.
    this.emit()
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Bytes on disk under `dir` (the installed copy). */
async function folderSize(dir: string): Promise<number> {
  let total = 0
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) total += (await stat(path).catch(() => null))?.size ?? 0
    }
  }
  await walk(dir)
  return total
}

function isRect(r: unknown): r is Rect {
  const v = r as Rect
  return [v?.x, v?.y, v?.width, v?.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

function optionalTabId(arg: unknown): number | undefined {
  const tabId = (arg as { tabId?: unknown } | null)?.tabId
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? tabId : undefined
}
