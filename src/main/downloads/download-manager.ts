import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { app, dialog, nativeImage, shell, type DownloadItem, type Session, type WebContents } from 'electron'
import type { DownloadState, DownloadStatus } from '@shared/types'
import type { Database } from '../persistence/database'
import type { SettingsService } from '../settings/settings-service'
import type { ShellSync } from '../windows/shell-sync'

const PROGRESS_INTERVAL_MS = 250
const KEEP_FINISHED = 200
/** A requested download that has not started by then never will. */
const START_TIMEOUT_MS = 60_000
/** Longest URL kept in a download's state (data: URLs can be megabytes). */
const MAX_URL = 8192
/**
 * Thumbnail box in points (QuickLook renders at the screen's scale). The list
 * shows a 40pt square cropped to fill, so this covers aspect ratios up to 2:1
 * without upscaling.
 */
const THUMB_PT = 80
/** Recent thumbnails kept in memory (PNG, a few tens of KB each). */
const KEEP_THUMBS = 48

interface Row {
  id: string
  url: string
  filename: string
  save_path: string
  status: string
  received_bytes: number
  total_bytes: number
  started_at: number
  ended_at: number | null
  seq: number | null
  initiator: string | null
}

/** Why a download stopped, as a chrome.downloads InterruptReason. */
export type DownloadError = 'USER_CANCELED' | 'NETWORK_FAILED' | 'FILE_FAILED'

/** A download as chrome.downloads sees it (see extensions/downloads.ts). */
export interface DownloadEntry {
  state: DownloadState
  /** Stable integer id: what chrome.downloads calls the download. */
  seq: number
  /** The extension that started it. */
  initiator: string | null
  finalUrl: string
  mime: string
  canResume: boolean
  error: DownloadError | null
}

/** A download an extension asks for (chrome.downloads.download). */
export interface DownloadRequest {
  url: string
  /** Path under the download folder, already checked by the caller. */
  filename?: string
  conflictAction?: 'uniquify' | 'overwrite' | 'prompt'
  /** true: always ask where to save; false: never; unset: the user's setting. */
  saveAs?: boolean
  headers?: Record<string, string>
  initiator?: string
}

export interface DownloadObserver {
  created(entry: DownloadEntry): void
  changed(entry: DownloadEntry): void
  erased(entry: DownloadEntry): void
}

interface Meta {
  seq: number
  initiator: string | null
  finalUrl: string
  mime: string
  error: DownloadError | null
}

interface Pending {
  url: string
  request: DownloadRequest
  resolve(id: string): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export class DownloadManager {
  private readonly states = new Map<string, DownloadState>()
  private readonly items = new Map<string, DownloadItem>()
  private readonly meta = new Map<string, Meta>()
  private readonly pending: Pending[] = []
  private readonly reservedPaths = new Set<string>()
  private readonly lastProgress = new Map<string, number>()
  private readonly attached = new WeakSet<Session>()
  /** `id:endedAt` -> PNG, oldest first; a pending render is shared. */
  private readonly thumbs = new Map<string, Promise<Buffer | null>>()
  private nextSeq: number
  private onProgress: ((fraction: number) => void) | null = null
  private onStart: ((state: DownloadState, asked: boolean) => void) | null = null
  private observer: DownloadObserver | null = null

  constructor(
    private readonly db: Database,
    private readonly shellSync: ShellSync,
    private readonly settings: SettingsService
  ) {
    this.nextSeq = (db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM downloads')?.m ?? 0) + 1
    for (const r of db.all<Row>('SELECT * FROM downloads ORDER BY started_at DESC LIMIT ?', KEEP_FINISHED)) {
      // Anything still "progressing" was cut short by the last shutdown.
      const status = (r.status === 'progressing' ? 'interrupted' : r.status) as DownloadStatus
      this.states.set(r.id, {
        id: r.id,
        url: r.url,
        filename: r.filename,
        savePath: r.save_path,
        status,
        paused: false,
        receivedBytes: r.received_bytes,
        totalBytes: r.total_bytes,
        startedAt: r.started_at,
        endedAt: r.ended_at
      })
      this.meta.set(r.id, {
        seq: r.seq ?? this.nextSeq++,
        initiator: r.initiator,
        finalUrl: r.url,
        mime: '',
        error: errorFor(status)
      })
    }
  }

  setProgressListener(fn: (fraction: number) => void): void {
    this.onProgress = fn
  }

  /** A download began; `asked`: a save dialog came first. */
  setStartListener(fn: (state: DownloadState, asked: boolean) => void): void {
    this.onStart = fn
  }

  /** Every download created, changed or erased (chrome.downloads events). */
  setObserver(observer: DownloadObserver): void {
    this.observer = observer
  }

  attach(session: Session): void {
    if (this.attached.has(session)) return
    this.attached.add(session)
    session.on('will-download', (_event, item) => this.track(item))
  }

  list(): Record<string, DownloadState> {
    return Object.fromEntries(this.states)
  }

  entries(): DownloadEntry[] {
    const out: DownloadEntry[] = []
    for (const id of this.states.keys()) {
      const entry = this.entry(id)
      if (entry) out.push(entry)
    }
    return out
  }

  entry(id: string): DownloadEntry | undefined {
    const state = this.states.get(id)
    const meta = this.meta.get(id)
    if (!state || !meta) return undefined
    const item = this.items.get(id)
    const chain = item?.getURLChain()
    return {
      state,
      seq: meta.seq,
      initiator: meta.initiator,
      finalUrl: chain?.[chain.length - 1] ?? meta.finalUrl,
      mime: item?.getMimeType() || meta.mime || state.mimeType || '',
      canResume: item?.canResume() ?? false,
      error: meta.error
    }
  }

  /** Download `request.url` as `session` would; resolves with the id once it starts. */
  start(session: Session, request: DownloadRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        url: normalizeUrl(request.url),
        request,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.pending.indexOf(pending)
          if (i >= 0) this.pending.splice(i, 1)
          reject(new Error('NETWORK_FAILED'))
        }, START_TIMEOUT_MS).unref()
      }
      this.pending.push(pending)
      session.downloadURL(request.url, request.headers ? { headers: request.headers } : undefined)
    })
  }

  /**
   * Save bytes an extension already has (a data: or blob: URL, a POST
   * response) as a download. Resolves with the id as the write begins.
   */
  async saveData(data: Uint8Array, request: DownloadRequest, mime: string): Promise<string> {
    const dir = this.downloadDir()
    const wanted = request.filename || `download${extensionFor(mime)}`
    let { path, ask } = this.place(dir, wanted, request)
    if (ask) {
      const r = await dialog.showSaveDialog({ defaultPath: path })
      path = r.canceled || !r.filePath ? '' : r.filePath
    }
    const id = randomUUID()
    const state: DownloadState = {
      id,
      url: request.url.slice(0, MAX_URL),
      filename: basename(path || wanted),
      savePath: path,
      status: 'progressing',
      paused: false,
      receivedBytes: 0,
      totalBytes: data.byteLength,
      startedAt: Date.now(),
      endedAt: null,
      mimeType: mime || undefined
    }
    this.meta.set(id, { seq: this.nextSeq++, initiator: request.initiator ?? null, finalUrl: state.url, mime, error: null })
    this.begin(state, ask)
    if (!path) {
      this.finish(id, 'cancelled', 0)
      return id
    }
    if (!ask) this.reservedPaths.add(path)
    void mkdir(dirname(path), { recursive: true })
      .then(() => writeFile(path, data))
      .then(
        () => this.finish(id, 'completed', data.byteLength),
        () => this.finish(id, 'interrupted', 0, 'FILE_FAILED')
      )
      .finally(() => this.reservedPaths.delete(path))
    return id
  }

  open(id: string): void {
    const s = this.states.get(id)
    if (s?.status === 'completed') void shell.openPath(s.savePath)
  }

  reveal(id: string): void {
    const s = this.states.get(id)
    if (s && existsSync(s.savePath)) shell.showItemInFolder(s.savePath)
  }

  cancel(id: string): void {
    this.items.get(id)?.cancel()
  }

  pause(id: string): void {
    const item = this.items.get(id)
    if (item && !item.isPaused()) {
      item.pause()
      this.patch(id, { paused: true })
    }
  }

  resume(id: string): void {
    const item = this.items.get(id)
    if (item?.canResume()) {
      item.resume()
      this.patch(id, { paused: false })
    }
  }

  remove(id: string): void {
    if (this.items.has(id)) return
    const entry = this.entry(id)
    this.states.delete(id)
    this.meta.delete(id)
    this.db.run('DELETE FROM downloads WHERE id = ?', id)
    this.shellSync.download(id, null)
    if (entry) this.observer?.erased(entry)
  }

  /** Delete a finished download's file; the entry stays. */
  async removeFile(id: string): Promise<void> {
    const s = this.states.get(id)
    if (s?.status !== 'completed') return
    await rm(s.savePath, { force: true })
    const entry = this.entry(id)
    if (entry) this.observer?.changed(entry)
  }

  async fileIcon(id: string, size: 'small' | 'normal' | 'large'): Promise<string | null> {
    const s = this.states.get(id)
    if (!s?.savePath) return null
    const icon = await app.getFileIcon(s.savePath, { size }).catch(() => null)
    return icon && !icon.isEmpty() ? icon.toDataURL() : null
  }

  /** A finished file's QuickLook thumbnail as PNG, or null when there is none. */
  thumbnail(id: string): Promise<Buffer | null> {
    const s = this.states.get(id)
    if (s?.status !== 'completed') return Promise.resolve(null)
    const key = `${id}:${s.endedAt}`
    let thumb = this.thumbs.get(key)
    if (thumb) {
      this.thumbs.delete(key)
    } else {
      thumb = nativeImage
        .createThumbnailFromPath(s.savePath, { width: THUMB_PT, height: THUMB_PT })
        .then((image) => (image.isEmpty() ? null : image.toPNG()))
        .catch(() => null)
      // A failure (file moved or deleted) is not remembered: it may come back.
      void thumb.then((png) => png || this.thumbs.delete(key))
      const oldest = this.thumbs.keys().next()
      if (this.thumbs.size >= KEEP_THUMBS && !oldest.done) this.thumbs.delete(oldest.value)
    }
    this.thumbs.set(key, thumb)
    return thumb
  }

  clearFinished(): void {
    for (const [id, s] of this.states) if (s.status !== 'progressing') this.remove(id)
  }

  /** Start a failed or canceled download over; it replaces the old entry. */
  retry(id: string, session: Session): void {
    const s = this.states.get(id)
    if (!s || s.status === 'progressing' || s.status === 'completed' || !/^https?:/.test(s.url)) return
    this.remove(id)
    session.downloadURL(s.url)
  }

  /** The user drags a finished file out of the downloads list. */
  async drag(id: string, sender: WebContents): Promise<void> {
    const s = this.states.get(id)
    if (s?.status !== 'completed' || !existsSync(s.savePath)) return
    const icon = await app.getFileIcon(s.savePath, { size: 'normal' }).catch(() => null)
    if (!icon || icon.isEmpty() || sender.isDestroyed()) return
    sender.startDrag({ file: s.savePath, icon })
  }

  downloadDir(): string {
    return this.settings.get().downloadDir || app.getPath('downloads')
  }

  openFolder(): void {
    void shell.openPath(this.downloadDir())
  }

  private track(item: DownloadItem): void {
    const id = randomUUID()
    const pending = this.claim(item)
    const request = pending?.request
    const dir = this.downloadDir()
    const { path, ask } = this.place(dir, request?.filename || item.getFilename() || 'download', request)
    if (ask) {
      item.setSaveDialogOptions({ defaultPath: path })
    } else {
      this.reservedPaths.add(path)
      // A filename with folders: Chrome makes them.
      if (request?.filename) mkdirSync(dirname(path), { recursive: true })
      item.setSavePath(path)
    }
    this.items.set(id, item)
    const state: DownloadState = {
      id,
      url: item.getURL().slice(0, MAX_URL),
      filename: basename(path),
      savePath: item.getSavePath(),
      status: 'progressing',
      paused: false,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      endedAt: null,
      // Picks the icon for names without a known extension (not persisted).
      mimeType: item.getMimeType() || undefined
    }
    const meta: Meta = { seq: this.nextSeq++, initiator: request?.initiator ?? null, finalUrl: item.getURL(), mime: item.getMimeType(), error: null }
    this.meta.set(id, meta)
    this.begin(state, ask)
    pending?.resolve(id)

    item.on('updated', (_e, s) => {
      const now = Date.now()
      if (now - (this.lastProgress.get(id) ?? 0) < PROGRESS_INTERVAL_MS) return
      this.lastProgress.set(id, now)
      const savePath = item.getSavePath()
      meta.error = s === 'interrupted' ? 'NETWORK_FAILED' : null
      this.patch(id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        paused: item.isPaused(),
        savePath,
        filename: savePath ? basename(savePath) : state.filename,
        status: s === 'interrupted' ? 'interrupted' : 'progressing'
      })
      this.refreshDock()
    })

    item.once('done', (_e, s) => {
      const savePath = item.getSavePath()
      const chain = item.getURLChain()
      meta.finalUrl = chain[chain.length - 1] ?? meta.finalUrl
      meta.mime = item.getMimeType()
      this.items.delete(id)
      this.lastProgress.delete(id)
      this.reservedPaths.delete(savePath)
      if (savePath) this.patch(id, { savePath, filename: basename(savePath) })
      this.finish(id, s, item.getReceivedBytes(), errorFor(s), item.getTotalBytes())
      if (s === 'completed' && savePath) app.dock?.downloadFinished(savePath)
    })
  }

  /** The extension request `item` answers, if any. */
  private claim(item: DownloadItem): Pending | null {
    if (this.pending.length === 0) return null
    const first = normalizeUrl(item.getURLChain()[0] ?? item.getURL())
    const i = this.pending.findIndex((p) => p.url === first)
    if (i < 0) return null
    const [pending] = this.pending.splice(i, 1)
    clearTimeout(pending!.timer)
    return pending!
  }

  /** Where `wanted` (a name, or a path under `dir`) goes, and whether to ask first. */
  private place(dir: string, wanted: string, request?: DownloadRequest): { path: string; ask: boolean } {
    const exact = join(dir, wanted)
    // Callers check extension filenames; this is the last line of defence.
    const inside = !relative(resolve(dir), resolve(exact)).startsWith('..')
    const target = inside ? wanted : basename(wanted)
    let ask = request?.saveAs ?? this.settings.get().downloadAskWhere
    if (ask) return { path: join(dir, target), ask }
    if (request?.conflictAction === 'overwrite') return { path: join(dir, target), ask }
    if (request?.conflictAction === 'prompt' && existsSync(join(dir, target))) {
      ask = true
      return { path: join(dir, target), ask }
    }
    return { path: this.uniquePath(dir, target), ask }
  }

  private begin(state: DownloadState, asked: boolean): void {
    this.states.set(state.id, state)
    this.shellSync.download(state.id, state, true)
    this.persist(state)
    this.refreshDock()
    this.onStart?.(state, asked)
    const entry = this.entry(state.id)
    if (entry) this.observer?.created(entry)
  }

  private finish(id: string, status: DownloadStatus, received: number, error: DownloadError | null = errorFor(status), total?: number): void {
    const meta = this.meta.get(id)
    if (meta) meta.error = error
    this.patch(id, { status, receivedBytes: received, ...(total !== undefined ? { totalBytes: total } : {}), paused: false, endedAt: Date.now() })
    const final = this.states.get(id)
    if (final) this.persist(final)
    this.refreshDock()
  }

  private patch(id: string, patch: Partial<DownloadState>): void {
    const s = this.states.get(id)
    if (!s) return
    Object.assign(s, patch)
    this.shellSync.download(id, patch)
    const entry = this.entry(id)
    if (entry) this.observer?.changed(entry)
  }

  private persist(s: DownloadState): void {
    const meta = this.meta.get(s.id)
    this.db.run(
      `INSERT INTO downloads (id, url, filename, save_path, status, received_bytes, total_bytes, started_at, ended_at, seq, initiator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, save_path = excluded.save_path,
         status = excluded.status, received_bytes = excluded.received_bytes,
         total_bytes = excluded.total_bytes, ended_at = excluded.ended_at`,
      s.id,
      s.url.slice(0, MAX_URL),
      s.filename,
      s.savePath,
      s.status,
      s.receivedBytes,
      s.totalBytes,
      s.startedAt,
      s.endedAt,
      meta?.seq ?? null,
      meta?.initiator ?? null
    )
  }

  private refreshDock(): void {
    let received = 0
    let total = 0
    for (const item of this.items.values()) {
      received += item.getReceivedBytes()
      total += item.getTotalBytes()
    }
    const active = this.items.size
    app.dock?.setBadge(active > 0 ? String(active) : '')
    this.onProgress?.(active === 0 ? -1 : total > 0 ? received / total : 2)
  }

  /** `wanted` (a name, or a path with folders) under `dir`, numbered if taken. */
  private uniquePath(dir: string, wanted: string): string {
    const folder = join(dir, dirname(wanted))
    const safe = basename(wanted).replace(/[/:]/g, '_') || 'download'
    const ext = extname(safe)
    const stem = ext ? safe.slice(0, -ext.length) : safe
    let candidate = join(folder, safe)
    for (let i = 1; existsSync(candidate) || this.reservedPaths.has(candidate); i++) {
      candidate = join(folder, `${stem} (${i})${ext}`)
    }
    return candidate
  }
}

function errorFor(status: DownloadStatus): DownloadError | null {
  return status === 'cancelled' ? 'USER_CANCELED' : status === 'interrupted' ? 'NETWORK_FAILED' : null
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/csv': '.csv'
}

function extensionFor(mime: string): string {
  return EXTENSIONS[mime.split(';')[0]!.trim().toLowerCase()] ?? ''
}
