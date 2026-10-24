import { DEFAULT_SETTINGS } from '@shared/defaults'
import { isLocale } from '@shared/i18n'
import type { Settings } from '@shared/types'
import { isValidSearchTemplate, SEARCH_ENGINES } from '@shared/url'
import type { Persister } from '../persistence/persister'

const SETTINGS_KEY = 'settings'

type Listener = (patch: Partial<Settings>, all: Settings) => void

/** User preferences, validated on every write. */
export class SettingsService {
  private values: Settings
  private readonly listeners = new Set<Listener>()

  constructor(
    stored: Map<string, unknown>,
    private readonly persister: Persister
  ) {
    this.values = { ...DEFAULT_SETTINGS, ...sanitizeSettings(stored.get(SETTINGS_KEY)) }
  }

  get(): Settings {
    return this.values
  }

  /** Applies the valid subset of `patch`; returns what actually changed. */
  update(patch: unknown): Partial<Settings> {
    const clean = sanitizeSettings(patch)
    const changed: Partial<Settings> = {}
    for (const key of Object.keys(clean) as Array<keyof Settings>) {
      if (this.values[key] !== clean[key]) (changed as Record<string, unknown>)[key] = clean[key]
    }
    if (Object.keys(changed).length === 0) return changed
    this.values = { ...this.values, ...changed }
    this.persister.setSetting(SETTINGS_KEY, this.values)
    for (const l of this.listeners) l(changed, this.values)
    return changed
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function sanitizeSettings(input: unknown): Partial<Settings> {
  if (!input || typeof input !== 'object') return {}
  const raw = input as Record<string, unknown>
  const out: Partial<Settings> = {}
  if (typeof raw.searchEngine === 'string' && (raw.searchEngine === 'custom' || raw.searchEngine in SEARCH_ENGINES)) {
    out.searchEngine = raw.searchEngine as Settings['searchEngine']
  }
  if (typeof raw.customSearchUrl === 'string') {
    const v = raw.customSearchUrl.trim()
    if (v === '' || isValidSearchTemplate(v)) out.customSearchUrl = v
  }
  if (typeof raw.downloadAskWhere === 'boolean') out.downloadAskWhere = raw.downloadAskWhere
  if (typeof raw.downloadDir === 'string' && raw.downloadDir.length < 4096) out.downloadDir = raw.downloadDir
  if (isIntIn(raw.discardAfterMinutes, 0, 24 * 60)) out.discardAfterMinutes = raw.discardAfterMinutes
  if (isIntIn(raw.memoryBudgetMB, 0, 1 << 17)) out.memoryBudgetMB = raw.memoryBudgetMB
  if (raw.theme === 'system' || raw.theme === 'light' || raw.theme === 'dark') out.theme = raw.theme
  if (isLocale(raw.language)) out.language = raw.language
  return out
}

function isIntIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}
