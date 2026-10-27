// Chrome match patterns, as chrome.permissions compares host permissions:
// does a granted pattern (`<all_urls>`, `*://*.example.com/*`) cover a
// requested one (`http://127.0.0.1:8080/`)? Paths do not matter for host
// permissions (Chrome normalizes them to `/*`), nor do ports unless the
// granted pattern names one.

interface Pattern {
  schemes: Set<string> | 'all'
  /** '*' for any host; else the host, with `sub` for `*.host`. */
  host: string
  sub: boolean
  port: string | null
}

const WEB_SCHEMES = ['http', 'https']
const ALL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'file', 'ftp', 'urn', 'data'])

export function parsePattern(text: string): Pattern | null {
  if (text === '<all_urls>') return { schemes: 'all', host: '*', sub: false, port: null }
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(text.trim())
  if (!m) return null
  const scheme = m[1]!.toLowerCase()
  if (scheme !== '*' && !ALL_SCHEMES.has(scheme) && scheme !== 'chrome-extension') return null
  let hostPart = m[2]!.toLowerCase()
  let port: string | null = null
  const portMatch = /^(.*?):(\d+|\*)$/.exec(hostPart)
  if (portMatch && !hostPart.endsWith(']')) {
    hostPart = portMatch[1]!
    port = portMatch[2] === '*' ? null : portMatch[2]!
  }
  if (scheme === 'file') return { schemes: new Set(['file']), host: '*', sub: false, port: null }
  if (hostPart === '*') return { schemes: scheme === '*' ? new Set(WEB_SCHEMES) : new Set([scheme]), host: '*', sub: false, port }
  const sub = hostPart.startsWith('*.')
  const host = sub ? hostPart.slice(2) : hostPart
  if (!host || host.includes('*')) return null
  return { schemes: scheme === '*' ? new Set(WEB_SCHEMES) : new Set([scheme]), host, sub, port }
}

/** True when everything `requested` matches, `granted` matches too. */
export function patternCovers(granted: string, requested: string): boolean {
  const g = parsePattern(granted)
  const r = parsePattern(requested)
  if (!g || !r) return false
  if (g.schemes !== 'all') {
    if (r.schemes === 'all') return false
    for (const s of r.schemes) if (!g.schemes.has(s)) return false
  }
  if (g.port !== null && g.port !== r.port) return false
  if (g.host === '*') return true
  if (r.host === '*') return false
  if (r.host === g.host) return g.sub || !r.sub
  return g.sub && r.host.endsWith(`.${g.host}`)
}

/** chrome.permissions.contains for origins: each requested pattern covered by a granted one. */
export function originsCovered(granted: readonly string[], requested: readonly string[]): boolean {
  return requested.every((r) => granted.some((g) => patternCovers(g, r)))
}
