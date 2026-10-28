// chrome.downloads, kept by the main process.
//
// electron-chrome-extensions declares the whole namespace but implements
// none of it: every method resolves with undefined and no event ever fires.
// User script managers pick it up anyway (Tampermonkey's GM_download uses it
// whenever chrome.downloads exists), so downloads silently went nowhere. The
// compat preload replaces the methods (see src/preload/extension-compat.ts)
// and forwards them here; downloads themselves go through DownloadManager,
// so they show in the downloads list like any other.
//
// What differs from Chrome:
//   - data:, blob: and the extension's own URLs are read by the calling
//     context and handed over as bytes (main cannot resolve them), as are
//     POST requests (Electron downloads only GET).
//   - onDeterminingFilename never fires: Electron fixes the save path when
//     the download starts, before an extension could answer.
//   - Every download is "safe": there is no dangerous-file check to accept.
import type { Session } from 'electron'
import type { DownloadEntry, DownloadManager, DownloadRequest } from '../downloads/download-manager'

/** chrome.downloads.DownloadItem */
export interface ChromeDownloadItem {
  id: number
  url: string
  finalUrl: string
  referrer: string
  filename: string
  incognito: boolean
  danger: 'safe'
  mime: string
  startTime: string
  endTime?: string
  state: 'in_progress' | 'interrupted' | 'complete'
  paused: boolean
  canResume: boolean
  error?: string
  bytesReceived: number
  totalBytes: number
  fileSize: number
  exists: boolean
  byExtensionId?: string
  byExtensionName?: string
}

/** chrome.downloads.DownloadDelta */
export type DownloadDelta = { id: number } & Record<string, { previous?: unknown; current?: unknown }>

export class DownloadsError extends Error {}

/** Fields onChanged reports (bytesReceived is not one, as in Chrome). */
const DELTA_FIELDS = [
  'url',
  'finalUrl',
  'filename',
  'danger',
  'mime',
  'startTime',
  'endTime',
  'state',
  'canResume',
  'paused',
  'error',
  'totalBytes',
  'fileSize',
  'exists'
] as const

const DEFAULT_LIMIT = 1000

// -- validation ------------------------------------------------------------------

/** Characters Chrome refuses in a download filename on any platform. */
const ILLEGAL = /[\u0000-\u001f\u007f"*:<>?\\|‎‏‪-‮⁦-⁩]/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** A relative path under the download folder, or DownloadsError("Invalid filename"). */
export function checkFilename(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.startsWith('/') || raw.startsWith('~')) throw new DownloadsError('Invalid filename')
  const parts = raw.split('/')
  for (const p of parts) {
    if (
      p === '' ||
      p === '.' ||
      p === '..' ||
      ILLEGAL.test(p) ||
      p !== p.trim() ||
      p.endsWith('.') ||
      RESERVED.test(p) ||
      Buffer.byteLength(p) > 255
    ) {
      throw new DownloadsError('Invalid filename')
    }
  }
  return parts.join('/')
}

/** Request headers XMLHttpRequest may not set: chrome.downloads refuses them too. */
const FORBIDDEN_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via'
])

export function checkHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new DownloadsError('Invalid header')
  const out: Record<string, string> = {}
  for (const h of raw) {
    const name = (h as { name?: unknown })?.name
    const value = (h as { value?: unknown })?.value
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new DownloadsError('Invalid header')
    }
    const lower = name.toLowerCase()
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-')) {
      throw new DownloadsError('Unsafe request header name')
    }
    out[name] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export interface DownloadOptions {
  url: string
  filename?: string
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt'
  saveAs?: boolean
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

/** chrome.downloads.DownloadOptions, checked as Chrome does. */
export function checkOptions(raw: unknown): DownloadOptions {
  if (!raw || typeof raw !== 'object') throw new DownloadsError('Invalid URL')
  const o = raw as Record<string, unknown>
  if (typeof o.url !== 'string') throw new DownloadsError('Invalid URL')
  let url: URL
  try {
    url = new URL(o.url)
  } catch {
    throw new DownloadsError('Invalid URL')
  }
  if (!['http:', 'https:', 'data:', 'blob:', 'chrome-extension:'].includes(url.protocol)) throw new DownloadsError('Invalid URL')
  const conflictAction = o.conflictAction ?? 'uniquify'
  if (conflictAction !== 'uniquify' && conflictAction !== 'overwrite' && conflictAction !== 'prompt') {
    throw new DownloadsError('Invalid conflictAction')
  }
  const method = o.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') throw new DownloadsError('Invalid method')
  if (o.body !== undefined && typeof o.body !== 'string') throw new DownloadsError('Invalid body')
  return {
    url: o.url,
    filename: o.filename === undefined || o.filename === '' ? undefined : checkFilename(o.filename),
    conflictAction,
    saveAs: typeof o.saveAs === 'boolean' ? o.saveAs : undefined,
    method,
    headers: checkHeaders(o.headers),
    body: o.body
  }
}

// -- items -------------------------------------------------------------------------

export function toChromeItem(entry: DownloadEntry, exists: boolean, extensionName?: string): ChromeDownloadItem {
  const s = entry.state
  const state = s.status === 'completed' ? 'complete' : s.status === 'progressing' ? 'in_progress' : 'interrupted'
  const known = s.totalBytes > 0 ? s.totalBytes : state === 'complete' ? s.receivedBytes : -1
  const item: ChromeDownloadItem = {
    id: entry.seq,
    url: s.url,
    finalUrl: entry.finalUrl,
    referrer: '',
    filename: s.savePath,
    incognito: false,
    danger: 'safe',
    mime: entry.mime,
    startTime: new Date(s.startedAt).toISOString(),
    state,
    paused: s.paused,
    canResume: entry.canResume,
    bytesReceived: s.receivedBytes,
    totalBytes: known,
    fileSize: state === 'complete' ? s.receivedBytes : known,
    exists
  }
  if (s.endedAt !== null) item.endTime = new Date(s.endedAt).toISOString()
  if (state === 'interrupted') item.error = entry.error ?? 'NETWORK_FAILED'
  if (entry.initiator) {
    item.byExtensionId = entry.initiator
    if (extensionName) item.byExtensionName = extensionName
  }
  return item
}

/** onChanged's delta from `prev` to `next`, or null when nothing it reports changed. */
export function diffItems(prev: ChromeDownloadItem, next: ChromeDownloadItem): DownloadDelta | null {
  const delta: DownloadDelta = { id: next.id } as DownloadDelta
  let changed = false
  for (const field of DELTA_FIELDS) {
    const a = prev[field]
    const b = next[field]
    if (a === b) continue
    const d: { previous?: unknown; current?: unknown } = {}
    if (a !== undefined) d.previous = a
    if (b !== undefined) d.current = b
    delta[field] = d
    changed = true
  }
  return changed ? delta : null
}

// -- queries -----------------------------------------------------------------------

const EQUAL_FIELDS = [
  'id',
  'url',
  'finalUrl',
  'filename',
  'danger',
  'mime',
  'startTime',
  'endTime',
  'state',
  'paused',
  'error',
  'bytesReceived',
  'totalBytes',
  'fileSize',
  'exists'
] as const
const ORDER_FIELDS = new Set<string>([...EQUAL_FIELDS, 'canResume', 'incognito', 'referrer', 'byExtensionId', 'byExtensionName'])

type Query = Record<string, unknown>

function regex(raw: unknown): RegExp | null {
  if (raw === undefined) return null
  try {
    return new RegExp(String(raw))
  } catch {
    throw new DownloadsError('Invalid query regex')
  }
}

function time(raw: unknown): number | null {
  if (raw === undefined) return null
  const t = typeof raw === 'number' ? raw : Date.parse(String(raw))
  if (Number.isNaN(t)) throw new DownloadsError('Invalid date')
  return t
}

/** A matcher for chrome.downloads.DownloadQuery; throws on a malformed query. */
export function queryMatcher(raw: unknown): (item: ChromeDownloadItem) => boolean {
  const q: Query = raw && typeof raw === 'object' ? (raw as Query) : {}
  const filenameRe = regex(q.filenameRegex)
  const urlRe = regex(q.urlRegex)
  const finalUrlRe = regex(q.finalUrlRegex)
  const startedBefore = time(q.startedBefore)
  const startedAfter = time(q.startedAfter)
  const endedBefore = time(q.endedBefore)
  const endedAfter = time(q.endedAfter)
  const terms = Array.isArray(q.query) ? q.query.filter((t): t is string => typeof t === 'string' && t !== '') : []
  const equal = EQUAL_FIELDS.filter((f) => q[f] !== undefined)
  return (item) => {
    for (const f of equal) if (item[f] !== q[f]) return false
    if (filenameRe && !filenameRe.test(item.filename)) return false
    if (urlRe && !urlRe.test(item.url)) return false
    if (finalUrlRe && !finalUrlRe.test(item.finalUrl)) return false
    const started = Date.parse(item.startTime)
    if (startedBefore !== null && !(started < startedBefore)) return false
    if (startedAfter !== null && !(started > startedAfter)) return false
    if (endedBefore !== null || endedAfter !== null) {
      if (!item.endTime) return false
      const ended = Date.parse(item.endTime)
      if (endedBefore !== null && !(ended < endedBefore)) return false
      if (endedAfter !== null && !(ended > endedAfter)) return false
    }
    if (typeof q.totalBytesGreater === 'number' && !(item.totalBytes > q.totalBytesGreater)) return false
    if (typeof q.totalBytesLess === 'number' && !(item.totalBytes < q.totalBytesLess)) return false
    if (terms.length > 0) {
      const hay = `${item.filename}\n${item.url}\n${item.finalUrl}`.toLowerCase()
      for (const term of terms) {
        const negated = term.startsWith('-') && term.length > 1
        const found = hay.includes((negated ? term.slice(1) : term).toLowerCase())
        if (found === negated) return false
      }
    }
    return true
  }
}

/** Order by chrome.downloads.DownloadQuery.orderBy (default: newest first), then cap at `limit`. */
export function orderAndLimit(items: ChromeDownloadItem[], raw: unknown): ChromeDownloadItem[] {
  const q: Query = raw && typeof raw === 'object' ? (raw as Query) : {}
  const orderBy = Array.isArray(q.orderBy) ? q.orderBy : ['-startTime']
  const keys = orderBy.map((o) => {
    const s = String(o)
    const desc = s.startsWith('-')
    const field = desc ? s.slice(1) : s
    if (!ORDER_FIELDS.has(field)) throw new DownloadsError('Invalid orderBy field')
    return { field: field as keyof ChromeDownloadItem, desc }
  })
  const sorted = [...items].sort((a, b) => {
    for (const { field, desc } of keys) {
      const x = a[field]
      const y = b[field]
      if (x === y) continue
      if (x === undefined) return 1
      if (y === undefined) return -1
      const c = x < y ? -1 : 1
      return desc ? -c : c
    }
    return 0
  })
  const limit = typeof q.limit === 'number' && q.limit >= 0 ? q.limit : DEFAULT_LIMIT
  return limit === 0 ? sorted : sorted.slice(0, limit)
}

// -- the API -----------------------------------------------------------------------

export interface DownloadsHost {
  /** The extension's name and permissions, while it is loaded. */
  extension(id: string): { name: string; permissions: string[] } | null
  /** Loaded extensions that may use chrome.downloads. */
  listeners(): string[]
  /** Deliver a chrome.downloads event; `wake` is started first if it is not running. */
  emit(ids: string[], name: 'onCreated' | 'onChanged' | 'onErased', payload: unknown, wake: string | null): void
  /** File existence, injectable for tests. */
  exists(path: string): boolean
}

/** Whether an extension's granted permissions let it use chrome.downloads. */
export function mayDownload(permissions: string[]): boolean {
  return permissions.includes('downloads')
}

export class ExtensionDownloads {
  /** The last item each event carried, to compute onChanged deltas. */
  private readonly sent = new Map<number, ChromeDownloadItem>()

  constructor(
    private readonly ses: Session,
    private readonly manager: DownloadManager,
    private readonly host: DownloadsHost
  ) {
    manager.setObserver({
      created: (entry) => this.created(entry),
      changed: (entry) => this.changed(entry),
      erased: (entry) => this.erased(entry)
    })
  }

  async call(id: string, method: string, args: unknown[]): Promise<unknown> {
    const ext = this.host.extension(id)
    if (!ext || !mayDownload(ext.permissions)) throw new DownloadsError('The "downloads" permission is required.')
    switch (method) {
      case 'download':
        return this.download(id, args[0])
      case 'downloadData':
        return this.downloadData(id, args[0], args[1], args[2])
      case 'search':
        return this.search(args[0])
      case 'pause':
        this.manager.pause(this.inProgress(args[0]).state.id)
        return undefined
      case 'resume': {
        const entry = this.find(args[0])
        if (entry.state.status === 'completed' || !entry.canResume) throw new DownloadsError('Download must be resumable')
        this.manager.resume(entry.state.id)
        return undefined
      }
      case 'cancel': {
        // Canceling a finished download is not an error in Chrome.
        const entry = this.find(args[0])
        if (entry.state.status === 'progressing') this.manager.cancel(entry.state.id)
        return undefined
      }
      case 'erase':
        return this.erase(args[0])
      case 'removeFile': {
        const entry = this.find(args[0])
        if (entry.state.status !== 'completed') throw new DownloadsError('Download must be complete')
        await this.manager.removeFile(entry.state.id)
        return undefined
      }
      case 'open': {
        if (!ext.permissions.includes('downloads.open')) throw new DownloadsError('The "downloads.open" permission is required.')
        const entry = this.find(args[0])
        if (entry.state.status !== 'completed') throw new DownloadsError('Download must be complete')
        this.manager.open(entry.state.id)
        return undefined
      }
      case 'show':
        this.manager.reveal(this.find(args[0]).state.id)
        return undefined
      case 'showDefaultFolder':
        this.manager.openFolder()
        return undefined
      case 'getFileIcon': {
        const entry = this.find(args[0])
        const size = (args[1] as { size?: unknown } | undefined)?.size
        if (size !== undefined && size !== 16 && size !== 32) throw new DownloadsError('Invalid icon size')
        const icon = await this.manager.fileIcon(entry.state.id, size === 16 ? 'small' : 'normal')
        if (!icon) throw new DownloadsError('Icon not found')
        return icon
      }
      case 'acceptDanger':
        // Nothing is ever held back as dangerous.
        this.find(args[0])
        return undefined
      case 'setUiOptions':
      case 'setShelfEnabled':
        return undefined
      default:
        throw new DownloadsError(`Unknown downloads call: ${method}`)
    }
  }

  private async download(id: string, raw: unknown): Promise<number> {
    const options = checkOptions(raw)
    const scheme = new URL(options.url).protocol
    // The preload reads these itself and sends downloadData instead.
    if (scheme !== 'http:' && scheme !== 'https:') throw new DownloadsError('Invalid URL')
    const request = this.request(id, options)
    if (options.method === 'POST') {
      const response = await this.ses.fetch(options.url, { method: 'POST', headers: options.headers, body: options.body ?? null }).catch(() => null)
      if (!response) throw new DownloadsError('NETWORK_FAILED')
      const bytes = new Uint8Array(await response.arrayBuffer())
      return this.seqOf(await this.manager.saveData(bytes, request, response.headers.get('content-type') ?? ''))
    }
    return this.seqOf(await this.manager.start(this.ses, request))
  }

  /** A data:, blob: or chrome-extension: download the calling context read for us. */
  private async downloadData(id: string, raw: unknown, data: unknown, mime: unknown): Promise<number> {
    const options = checkOptions(raw)
    if (!(data instanceof Uint8Array)) throw new DownloadsError('Invalid URL')
    const request = this.request(id, options)
    return this.seqOf(await this.manager.saveData(data, request, typeof mime === 'string' ? mime : ''))
  }

  private request(id: string, options: DownloadOptions): DownloadRequest {
    return {
      url: options.url,
      filename: options.filename,
      conflictAction: options.conflictAction,
      saveAs: options.saveAs,
      headers: options.headers,
      initiator: id
    }
  }

  private seqOf(downloadId: string): number {
    const entry = this.manager.entry(downloadId)
    if (!entry) throw new DownloadsError('NETWORK_FAILED')
    return entry.seq
  }

  private search(query: unknown): ChromeDownloadItem[] {
    const matches = queryMatcher(query)
    return orderAndLimit(
      this.manager
        .entries()
        .map((e) => this.item(e))
        .filter(matches),
      query
    )
  }

  private erase(query: unknown): number[] {
    const matches = queryMatcher(query)
    const entries = new Map(this.manager.entries().map((e) => [e.seq, e]))
    const erased: number[] = []
    for (const item of orderAndLimit([...entries.values()].map((e) => this.item(e)).filter(matches), query)) {
      const entry = entries.get(item.id)!
      // In-progress downloads stay: Electron cannot forget a running one.
      if (entry.state.status === 'progressing') continue
      this.manager.remove(entry.state.id)
      erased.push(item.id)
    }
    return erased
  }

  private find(raw: unknown): DownloadEntry {
    const entry = typeof raw === 'number' ? this.manager.entries().find((e) => e.seq === raw) : undefined
    if (!entry) throw new DownloadsError('Invalid download id')
    return entry
  }

  private inProgress(raw: unknown): DownloadEntry {
    const entry = this.find(raw)
    if (entry.state.status !== 'progressing') throw new DownloadsError('Download must be in progress')
    return entry
  }

  private item(entry: DownloadEntry): ChromeDownloadItem {
    const s = entry.state
    // Only a finished file needs checking; an unfinished one has no final file yet.
    const exists = s.status === 'completed' ? Boolean(s.savePath) && this.host.exists(s.savePath) : s.status === 'progressing'
    return toChromeItem(entry, exists, entry.initiator ? this.host.extension(entry.initiator)?.name : undefined)
  }

  private created(entry: DownloadEntry): void {
    const item = this.item(entry)
    this.sent.set(item.id, item)
    const listeners = this.host.listeners()
    if (listeners.length > 0) this.host.emit(listeners, 'onCreated', item, null)
  }

  private changed(entry: DownloadEntry): void {
    const prev = this.sent.get(entry.seq)
    const next = this.item(entry)
    this.sent.set(next.id, next)
    const delta = prev && diffItems(prev, next)
    if (!delta) return
    const listeners = this.host.listeners()
    if (listeners.length === 0) return
    // The extension that started it hears how it ended, even if its worker stopped.
    const wake = next.state !== 'in_progress' && entry.initiator ? entry.initiator : null
    this.host.emit(listeners, 'onChanged', delta, wake)
  }

  private erased(entry: DownloadEntry): void {
    this.sent.delete(entry.seq)
    const listeners = this.host.listeners()
    if (listeners.length > 0) this.host.emit(listeners, 'onErased', entry.seq, null)
  }
}
