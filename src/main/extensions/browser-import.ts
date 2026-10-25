import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ImportBrowser, ImportSourceSummary } from '@shared/ext-import'
import type { MessageKey, Translate } from '@shared/i18n'
import {
  asObject,
  browserName,
  browserRoots,
  lastUsedProfile,
  readJsonObject,
  resolveRoot,
  type BrowserProfile,
  type BrowserRoot
} from '../import/browsers'
import { localizeMessage, parseManifestText, resolveExtensionSource, SUPPORTED_MANIFEST_VERSIONS } from './installer'

// Reads another Chromium browser's profile and lists the extensions that can
// be copied over. Strictly read-only: nothing is ever written under the other
// browser's folder. Which browsers exist, and where, is `import/browsers.ts`.

/** Chromium's ManifestLocation values that are user installs: INTERNAL (Web Store) and UNPACKED. */
const LOCATION_WEB_STORE = 1
const LOCATION_UNPACKED = 4

const EXTENSION_ID = /^[a-p]{32}$/

/**
 * Extensions that are never imported, with the reason shown to the user.
 * See docs/PHASE0-REPORT.md for the compatibility survey.
 */
export const KNOWN_INCOMPATIBLE: Readonly<Record<string, MessageKey>> = {
  // Awesome Screen Recorder: opening its popup trips a Chromium assertion
  // and takes the whole browser down (tabCapture / desktopCapture).
  nlipoenfbbikpbjkfpfillcgkoblgpmj: 'extImport.skip.crashes',
  // Infinity New Tab: replaces the new tab page, which is not supported.
  nnnkddnnlpamobajfibfdgfnbcnkgngh: 'extImport.skip.newTab'
}

/** `newTab`: the manifest overrides the new tab page, which this browser does not support (⌘T is the palette). */
export type SkipReason = 'disabled' | 'installed' | 'incompatible' | 'newTab' | 'unreadable' | 'manifestVersion'

export interface ImportCandidate {
  /** Extension id in the source browser (equals ours when the manifest has a `key`). */
  id: string
  name: string
  version: string
  manifestVersion: number | null
  enabledInSource: boolean
  /** Pinned to the toolbar in the source browser; the import mirrors it. */
  pinnedInSource: boolean
  /**
   * What to install from, and later "Update from source": the profile's
   * `Extensions/<id>` folder for Web Store installs (the installer picks the
   * newest version folder), the original folder for unpacked ones.
   */
  sourcePath: string
  skip: SkipReason | null
}

export interface ImportSource {
  id: ImportBrowser
  browserName: string
  /** The browser's "User Data" folder. */
  root: string
  /** Profile folder name ("Default", "Profile 2"). */
  profileDir: string
  /** The profile's display name. */
  profileName: string
  /** Sorted by name. */
  extensions: ImportCandidate[]
}


/** Every browser in `roots` whose last-used profile has user-installed extensions. */
export async function scanImportSources(
  installed: ReadonlySet<string>,
  roots: BrowserRoot[] = browserRoots()
): Promise<ImportSource[]> {
  const sources = await Promise.all(roots.map((r) => scanSource(r, installed).catch(() => null)))
  return sources.filter((s): s is ImportSource => s !== null)
}

/**
 * One profile of one browser — the last-used one unless `profile` names
 * another — or null when there is nothing to import.
 */
export async function scanSource(
  { browser, root }: BrowserRoot,
  installed: ReadonlySet<string>,
  profile?: BrowserProfile
): Promise<ImportSource | null> {
  const resolved = await resolveRoot(root)
  if (!resolved) return null
  const chosen = profile ?? (await lastUsedProfile(resolved))
  if (!chosen) return null
  const profileDir = join(resolved, chosen.dir)

  // Chromium splits extension settings between the two files (Secure
  // Preferences holds the MAC-protected part); merge them per id.
  const settings = new Map<string, Record<string, unknown>>()
  const pinned = new Set<string>()
  for (const file of ['Preferences', 'Secure Preferences']) {
    const prefs = await readJsonObject(join(profileDir, file))
    const pinnedIds = asObject(prefs?.extensions)?.pinned_extensions
    if (Array.isArray(pinnedIds)) for (const id of pinnedIds) if (typeof id === 'string') pinned.add(id)
    const entries = asObject(asObject(prefs?.extensions)?.settings)
    if (!entries) continue
    for (const [id, entry] of Object.entries(entries)) {
      const value = asObject(entry)
      if (EXTENSION_ID.test(id) && value) settings.set(id, { ...settings.get(id), ...value })
    }
  }

  const extensions: ImportCandidate[] = []
  for (const [id, entry] of settings) {
    const candidate = await readCandidate(id, entry, profileDir, installed, pinned.has(id))
    if (candidate) extensions.push(candidate)
  }
  if (extensions.length === 0) return null
  extensions.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
  return { id: browser, browserName: browserName(browser), root: resolved, profileDir: chosen.dir, profileName: chosen.name, extensions }
}

export function summarize(source: ImportSource): ImportSourceSummary {
  return {
    id: source.id,
    browserName: source.browserName,
    profileName: source.profileName,
    importable: source.extensions.filter((e) => !e.skip).length,
    total: source.extensions.length
  }
}

/** Human-readable reason an extension is skipped. */
export function skipReasonText(c: ImportCandidate, browser: string, t: Translate): string {
  switch (c.skip) {
    case 'disabled':
      return t('extImport.skip.disabled', { browser })
    case 'installed':
      return t('extImport.skip.installed')
    case 'incompatible':
      return t(KNOWN_INCOMPATIBLE[c.id] ?? 'extImport.skip.crashes')
    case 'newTab':
      return t('extImport.skip.newTab')
    case 'manifestVersion':
      return t('extImport.skip.manifestVersion', { version: String(c.manifestVersion ?? '?') })
    default:
      return t('extImport.skip.unreadable')
  }
}

// -- internals ---------------------------------------------------------------

async function readCandidate(
  id: string,
  entry: Record<string, unknown>,
  profileDir: string,
  installed: ReadonlySet<string>,
  pinnedInSource: boolean
): Promise<ImportCandidate | null> {
  let sourcePath: string
  if (entry.location === LOCATION_WEB_STORE) sourcePath = join(profileDir, 'Extensions', id)
  else if (entry.location === LOCATION_UNPACKED && typeof entry.path === 'string' && isAbsolute(entry.path)) sourcePath = entry.path
  else return null // component, external, policy…

  // Chromium keeps a copy of the manifest in the settings; it is the
  // fallback when the files cannot be read.
  const stored = asObject(entry.manifest)
  let name = typeof stored?.name === 'string' && !stored.name.startsWith('__MSG_') ? stored.name : ''
  let version = typeof stored?.version === 'string' ? stored.version : ''
  let manifestVersion: number | null = null
  let readable = false
  let newTab = false
  try {
    const dir = await resolveExtensionSource(sourcePath)
    const manifest = parseManifestText(await readFile(join(dir, 'manifest.json'), 'utf8'))
    const mv = Number(manifest.manifest_version)
    manifestVersion = Number.isFinite(mv) ? mv : null
    if (typeof manifest.version === 'string') version = manifest.version
    newTab = typeof asObject(manifest.chrome_url_overrides)?.newtab === 'string'
    if (typeof manifest.name === 'string') {
      const localized = await localizeMessage(dir, manifest, manifest.name)
      if (localized && !localized.startsWith('__MSG_')) name = localized
      readable = version !== ''
    }
  } catch {
    // Missing or broken files: reported as 'unreadable'.
  }

  const enabledInSource = isEnabled(entry)
  const skip: SkipReason | null = !enabledInSource
    ? 'disabled'
    : installed.has(id)
      ? 'installed'
      : id in KNOWN_INCOMPATIBLE
        ? 'incompatible'
        : !readable
          ? 'unreadable'
          : manifestVersion === null || !SUPPORTED_MANIFEST_VERSIONS.includes(manifestVersion)
            ? 'manifestVersion'
            : newTab
              ? 'newTab'
              : null
  return { id, name: name || id, version, manifestVersion, enabledInSource, pinnedInSource, sourcePath, skip }
}

/** Current Chromium: `disable_reasons` is a list (empty = enabled); older ones used a bitmask or `state`. */
function isEnabled(entry: Record<string, unknown>): boolean {
  const reasons = entry.disable_reasons
  if (Array.isArray(reasons)) return reasons.length === 0
  if (typeof reasons === 'number') return reasons === 0
  return entry.state !== 0
}
