import { DEFAULT_LOCALE, translate, type Locale, type MessageKey } from './i18n'
import { isKnownTld } from './tlds'
import type { SearchEngineId, Settings, TabState } from './types'

// ---------------------------------------------------------------------------
// Internal pages (rendered by the shell, never loaded into a WebContents)
// ---------------------------------------------------------------------------

/** Internal page → message key of its title. */
export const INTERNAL_PAGES = {
  settings: 'page.settings',
  extensions: 'page.extensions',
  history: 'page.history',
  downloads: 'page.downloads',
  passwords: 'page.passwords'
} as const satisfies Record<string, MessageKey>

export type InternalPage = keyof typeof INTERNAL_PAGES

const INTERNAL_PREFIX = 'browser://'

export function internalUrl(page: InternalPage): string {
  return INTERNAL_PREFIX + page
}

export function parseInternalUrl(url: string): InternalPage | null {
  if (!url.startsWith(INTERNAL_PREFIX)) return null
  const page = url.slice(INTERNAL_PREFIX.length).replace(/[/?#].*$/, '')
  return Object.hasOwn(INTERNAL_PAGES, page) ? (page as InternalPage) : null
}

export function isInternalUrl(url: string): boolean {
  return url.startsWith(INTERNAL_PREFIX)
}

/** Whether the active tab is drawn by a WebContentsView (vs. a shell placeholder). */
export function tabPresentsView(tab: Pick<TabState, 'live' | 'crashed' | 'error' | 'url'>): boolean {
  return tab.live && !tab.crashed && tab.error === null && !isInternalUrl(tab.url)
}

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------

export const SEARCH_ENGINES: Record<Exclude<SearchEngineId, 'custom'>, { name: string; template: string }> = {
  google: { name: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  baidu: { name: 'Baidu', template: 'https://www.baidu.com/s?wd=%s' },
  kagi: { name: 'Kagi', template: 'https://kagi.com/search?q=%s' }
}

export function searchTemplate(settings: Pick<Settings, 'searchEngine' | 'customSearchUrl'>): string {
  if (settings.searchEngine === 'custom') {
    const custom = settings.customSearchUrl.trim()
    if (isValidSearchTemplate(custom)) return custom
    return SEARCH_ENGINES.google.template
  }
  return SEARCH_ENGINES[settings.searchEngine].template
}

export function isValidSearchTemplate(template: string): boolean {
  if (!template.includes('%s')) return false
  try {
    const url = new URL(template.replace('%s', 'test'))
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function buildSearchUrl(query: string, template: string): string {
  return template.replace('%s', encodeURIComponent(query.trim()))
}

// ---------------------------------------------------------------------------
// Omnibox input resolution
// ---------------------------------------------------------------------------

export interface ResolvedInput {
  kind: 'url' | 'search'
  url: string
}

/** Schemes the user may type directly; everything else is decided heuristically. */
const NAVIGABLE_SCHEMES = new Set([
  'http',
  'https',
  'file',
  'about',
  'data',
  'view-source',
  'chrome-extension'
])

/** Common external app schemes, opened through the OS after confirmation. */
const EXTERNAL_SCHEMES = new Set([
  'mailto',
  'tel',
  'sms',
  'facetime',
  'facetime-audio',
  'maps',
  'magnet',
  'vscode',
  'cursor',
  'zoommtg',
  'slack',
  'spotify',
  'obsidian',
  'notion',
  'figma',
  'x-apple.systempreferences',
  'itms-apps',
  'macappstore'
])

/** Pseudo-TLDs used on local networks; resolved over plain http. */
const LOCAL_TLDS = new Set(['local', 'localhost', 'test', 'internal', 'lan', 'home', 'corp'])

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):(.*)$/is
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i
const NON_ASCII_RE = /[^\x00-\x7f]/

/**
 * Turn whatever was typed into the address bar into a URL to load. Returns
 * null for blank input.
 */
export function resolveInput(raw: string, template: string): ResolvedInput | null {
  const input = raw.trim()
  if (!input) return null
  const search = (): ResolvedInput => ({ kind: 'search', url: buildSearchUrl(input, template) })

  if (/\s/.test(input)) return search()

  const schemeMatch = SCHEME_RE.exec(input)
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase()
    const rest = schemeMatch[2]!
    if (scheme === 'browser') {
      return parseInternalUrl(input.toLowerCase()) ? { kind: 'url', url: input.toLowerCase() } : search()
    }
    if (NAVIGABLE_SCHEMES.has(scheme)) {
      const parsed = tryParseUrl(input)
      if (!parsed) return search()
      if ((scheme === 'http' || scheme === 'https') && !parsed.hostname) return search()
      return { kind: 'url', url: parsed.href }
    }
    // `localhost:3000/foo`, `example.com:8080` — a host with a port, not a scheme.
    if (/^\d+([/?#]|$)/.test(rest) && looksLikeHost(scheme)) {
      return hostToUrl(input) ?? search()
    }
    if (EXTERNAL_SCHEMES.has(scheme) || rest.startsWith('//')) {
      const parsed = tryParseUrl(input)
      return parsed ? { kind: 'url', url: parsed.href } : search()
    }
    return search()
  }

  return hostToUrl(input) ?? search()
}

function hostToUrl(input: string): ResolvedInput | null {
  const hostPort = input.split(/[/?#]/, 1)[0]!
  // `name@example.com` is far more likely an email address than userinfo.
  if (hostPort.includes('@')) return null
  const host = hostPort.replace(/:\d+$/, '')
  if (!looksLikeHost(host)) return null
  const local = isLocalHost(host)
  const parsed = tryParseUrl((local ? 'http://' : 'https://') + input)
  if (!parsed || !parsed.hostname) return null
  return { kind: 'url', url: parsed.href }
}

function looksLikeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (!h) return false
  if (h === 'localhost') return true
  if (IPV4_RE.test(h)) return true
  if (h.startsWith('[') && h.endsWith(']')) return tryParseUrl(`http://${h}/`) !== null
  const labels = h.split('.')
  if (labels.length < 2) return false
  for (const label of labels) {
    if (NON_ASCII_RE.test(label)) {
      if (label.length < 1) return false
      continue
    }
    if (!LABEL_RE.test(label)) return false
  }
  const tld = labels[labels.length - 1]!
  if (NON_ASCII_RE.test(tld)) return tld.length >= 2
  if (/^\d+$/.test(tld)) return false
  return isKnownTld(tld) || LOCAL_TLDS.has(tld)
}

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || IPV4_RE.test(h) || h.startsWith('[')) return true
  const tld = h.slice(h.lastIndexOf('.') + 1)
  return LOCAL_TLDS.has(tld)
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export type SecurityLevel = 'secure' | 'insecure' | 'internal'

export function securityLevel(url: string): SecurityLevel {
  if (url.startsWith('https:') || url.startsWith('chrome-extension:')) return 'secure'
  if (url.startsWith('http:')) {
    const parsed = tryParseUrl(url)
    return parsed && isLocalHost(parsed.hostname) ? 'internal' : 'insecure'
  }
  return 'internal'
}

/** Short form for the sidebar address pill: host without `www.`. */
export function displayHost(url: string, locale: Locale = DEFAULT_LOCALE): string {
  const page = parseInternalUrl(url)
  if (page) return translate(locale, INTERNAL_PAGES[page])
  const parsed = tryParseUrl(url)
  if (!parsed) return url
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return parsed.hostname.replace(/^www\./, '')
  }
  if (parsed.protocol === 'about:') return url
  if (parsed.protocol === 'file:') return decodeSafe(parsed.pathname.split('/').pop() || parsed.pathname)
  return parsed.protocol.replace(/:$/, '')
}

/** Human readable full URL (decoded, no trailing slash on bare origins). */
export function displayUrl(url: string): string {
  if (url.startsWith('data:')) return url.slice(0, 64) + (url.length > 64 ? '…' : '')
  const parsed = tryParseUrl(url)
  if (!parsed) return url
  let out = decodeSafe(parsed.href)
  if (parsed.pathname === '/' && !parsed.search && !parsed.hash) out = out.replace(/\/$/, '')
  return out
}

export function originOf(url: string): string | null {
  const parsed = tryParseUrl(url)
  if (!parsed || parsed.origin === 'null') return null
  return parsed.origin
}

function decodeSafe(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

/** Title fallback while a page has not reported one yet. */
export function fallbackTitle(url: string, locale: Locale = DEFAULT_LOCALE): string {
  if (!url || url === 'about:blank') return translate(locale, 'tab.newTabTitle')
  return displayHost(url, locale) || url
}
