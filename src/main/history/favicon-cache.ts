import type { Session } from 'electron'
import type { Database } from '../persistence/database'

const MAX_BYTES = 256 * 1024
const MEMORY_ENTRIES = 300
const FETCH_TIMEOUT_MS = 8000

export interface Icon {
  mime: string
  data: Uint8Array
}

/**
 * Favicons are fetched once through the tab's own session (so they share its
 * HTTP cache and cookies), stored in SQLite and served to the shell through
 * the `favicon:` protocol. The shell never touches the network, and icons
 * appear instantly on the next launch.
 */
export class FaviconCache {
  private readonly memory = new Map<string, Icon>()
  private readonly known = new Set<string>()
  private readonly inflight = new Map<string, Promise<boolean>>()

  constructor(private readonly db: Database) {
    for (const row of db.all<{ url: string }>('SELECT url FROM favicons')) this.known.add(row.url)
  }

  has(url: string): boolean {
    return this.known.has(url)
  }

  /** Ensure `url` is cached. Resolves true if the icon is available. */
  ensure(url: string, session: Session): Promise<boolean> {
    if (this.known.has(url)) return Promise.resolve(true)
    let pending = this.inflight.get(url)
    if (!pending) {
      pending = this.download(url, session).finally(() => this.inflight.delete(url))
      this.inflight.set(url, pending)
    }
    return pending
  }

  /** Store an icon obtained elsewhere (imported from another browser). */
  put(url: string, icon: Icon): void {
    if (icon.data.byteLength === 0 || icon.data.byteLength > MAX_BYTES) return
    this.store(url, icon)
  }

  get(url: string): Icon | null {
    const hit = this.memory.get(url)
    if (hit) {
      // Refresh LRU position.
      this.memory.delete(url)
      this.memory.set(url, hit)
      return hit
    }
    const row = this.db.get<{ mime: string; data: Uint8Array }>(
      'SELECT mime, data FROM favicons WHERE url = ?',
      url
    )
    if (!row) return null
    const icon = { mime: row.mime, data: row.data }
    this.remember(url, icon)
    return icon
  }

  private remember(url: string, icon: Icon): void {
    this.memory.set(url, icon)
    if (this.memory.size > MEMORY_ENTRIES) {
      this.memory.delete(this.memory.keys().next().value!)
    }
  }

  private async download(url: string, session: Session): Promise<boolean> {
    let icon: Icon | null = null
    try {
      icon = url.startsWith('data:') ? decodeDataUrl(url) : await fetchIcon(url, session)
    } catch {
      icon = null
    }
    if (!icon) return false
    this.store(url, icon)
    return true
  }

  private store(url: string, icon: Icon): void {
    this.db.run(
      `INSERT INTO favicons (url, mime, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
      url,
      icon.mime,
      icon.data,
      Date.now()
    )
    this.known.add(url)
    this.remember(url, icon)
  }

  /** Drop icons no tab or history entry references and that are older than a month. */
  prune(): void {
    this.db.run(
      `DELETE FROM favicons WHERE updated_at < ? AND url NOT IN (SELECT favicon FROM tabs WHERE favicon IS NOT NULL)`,
      Date.now() - 30 * 86_400_000
    )
  }
}

async function fetchIcon(url: string, session: Session): Promise<Icon | null> {
  if (!/^https?:/.test(url)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await session.fetch(url, { signal: controller.signal, credentials: 'include' })
    if (!res.ok) return null
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || sniffMime(url)
    if (!isImageMime(mime)) return null
    const buffer = new Uint8Array(await res.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_BYTES) return null
    return { mime, data: buffer }
  } finally {
    clearTimeout(timer)
  }
}

function decodeDataUrl(url: string): Icon | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  const mime = match[1] ?? 'text/plain'
  if (!isImageMime(mime)) return null
  const payload = match[3]!
  const data = match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
  if (data.byteLength > MAX_BYTES) return null
  return { mime, data: new Uint8Array(data) }
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

function sniffMime(url: string): string {
  const path = url.split(/[?#]/)[0]!.toLowerCase()
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.ico')) return 'image/x-icon'
  if (path.endsWith('.gif')) return 'image/gif'
  if (path.endsWith('.webp')) return 'image/webp'
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg'
  return ''
}
