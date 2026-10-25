// chrome.sidePanel state, kept by the main process. Electron implements no
// side panel; the compat preload exposes the API and forwards every call
// here (see compat.ts), and the extension window shows the panel.
//
// What persists across restarts mirrors Chrome, which keeps both in
// extension prefs: the panel behavior and the global options. Tab-specific
// options live only as long as the tab.

export interface PanelBehavior {
  openPanelOnActionClick?: boolean
}

export interface PanelOptions {
  tabId?: number
  path?: string
  enabled?: boolean
}

/** What chrome.sidePanel.getOptions() resolves to. */
export interface PanelOptionsResult {
  path?: string
  enabled: boolean
  tabId?: number
}

/** Per-extension values written to the settings table. */
export interface StoredPanelState {
  /** Undefined until the extension calls setPanelBehavior. */
  openOnAction?: boolean
  path?: string
  enabled?: boolean
}

export interface SidePanelEnv {
  /** `side_panel.default_path` from the extension's manifest, if any. */
  defaultPath(id: string): string | null
  persist(all: Record<string, StoredPanelState>): void
}

export class SidePanelState {
  private readonly stored = new Map<string, StoredPanelState>()
  private readonly tabs = new Map<string, Map<number, { path?: string; enabled?: boolean }>>()

  constructor(
    initial: unknown,
    private readonly env: SidePanelEnv
  ) {
    if (!initial || typeof initial !== 'object') return
    for (const [id, raw] of Object.entries(initial as Record<string, unknown>)) {
      const value = sanitizeStored(raw)
      if (value) this.stored.set(id, value)
    }
  }

  /** True when the extension has a panel to show at all (manifest path or one set at runtime). */
  hasPanel(id: string): boolean {
    return Boolean(this.env.defaultPath(id) || this.stored.get(id)?.path)
  }

  /** The extension's own choice, or undefined when it never called setPanelBehavior. */
  behavior(id: string): boolean | undefined {
    return this.stored.get(id)?.openOnAction
  }

  getPanelBehavior(id: string): Required<PanelBehavior> {
    return { openPanelOnActionClick: this.behavior(id) ?? false }
  }

  setPanelBehavior(id: string, raw: unknown): void {
    const behavior = (raw && typeof raw === 'object' ? raw : {}) as PanelBehavior
    if (typeof behavior.openPanelOnActionClick !== 'boolean') return
    this.update(id, { openOnAction: behavior.openPanelOnActionClick })
  }

  getOptions(id: string, raw: unknown): PanelOptionsResult {
    const tabId = tabIdOf(raw)
    const global = this.globalOptions(id)
    if (tabId === undefined) return global
    const tab = this.tabs.get(id)?.get(tabId)
    if (!tab) return { ...global, tabId }
    return { path: tab.path ?? global.path, enabled: tab.enabled ?? global.enabled, tabId }
  }

  setOptions(id: string, raw: unknown): void {
    const options = (raw && typeof raw === 'object' ? raw : {}) as PanelOptions
    const patch: { path?: string; enabled?: boolean } = {}
    if (typeof options.path === 'string') patch.path = options.path
    if (typeof options.enabled === 'boolean') patch.enabled = options.enabled
    const tabId = tabIdOf(options)
    if (tabId === undefined) {
      this.update(id, patch)
      return
    }
    let perTab = this.tabs.get(id)
    if (!perTab) this.tabs.set(id, (perTab = new Map()))
    perTab.set(tabId, { ...perTab.get(tabId), ...patch })
  }

  /** chrome-extension:// URL the panel shows for `tabId`, or null when it is disabled or has no path. */
  panelUrl(id: string, tabId?: number): string | null {
    const { path, enabled } = this.getOptions(id, tabId === undefined ? {} : { tabId })
    if (!enabled || !path) return null
    return resolveExtensionUrl(id, path)
  }

  tabRemoved(tabId: number): void {
    for (const perTab of this.tabs.values()) perTab.delete(tabId)
  }

  /** Uninstalled: drop everything, including what was persisted. */
  forget(id: string): void {
    this.tabs.delete(id)
    if (this.stored.delete(id)) this.save()
  }

  private globalOptions(id: string): PanelOptionsResult {
    const stored = this.stored.get(id)
    const path = stored?.path ?? this.env.defaultPath(id) ?? undefined
    return { ...(path ? { path } : {}), enabled: stored?.enabled ?? true }
  }

  private update(id: string, patch: StoredPanelState): void {
    const before = this.stored.get(id) ?? {}
    const next = { ...before, ...patch }
    if (JSON.stringify(next) === JSON.stringify(before)) return
    this.stored.set(id, next)
    this.save()
  }

  private save(): void {
    this.env.persist(Object.fromEntries(this.stored))
  }
}

/** Resolve a panel path the way Chrome resolves action popups: relative to the extension root. */
export function resolveExtensionUrl(id: string, path: string): string | null {
  const base = `chrome-extension://${id}/`
  try {
    const url = new URL(path, base)
    // A panel can only show the extension's own pages.
    return url.href.startsWith(base) ? url.href : null
  } catch {
    return null
  }
}

function tabIdOf(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const tabId = (raw as { tabId?: unknown }).tabId
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? tabId : undefined
}

function sanitizeStored(raw: unknown): StoredPanelState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const out: StoredPanelState = {}
  if (typeof r.openOnAction === 'boolean') out.openOnAction = r.openOnAction
  if (typeof r.path === 'string') out.path = r.path
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  return out
}
