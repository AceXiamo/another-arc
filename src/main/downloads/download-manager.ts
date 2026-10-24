import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { app, shell, type DownloadItem, type Session } from 'electron'
import type { DownloadState, DownloadStatus } from '@shared/types'
import type { Database } from '../persistence/database'
import type { SettingsService } from '../settings/settings-service'
import type { ShellSync } from '../windows/shell-sync'

const PROGRESS_INTERVAL_MS = 250
const KEEP_FINISHED = 200

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
}

export class DownloadManager {
  private readonly states = new Map<string, DownloadState>()
  private readonly items = new Map<string, DownloadItem>()
  private readonly reservedPaths = new Set<string>()
  private readonly lastProgress = new Map<string, number>()
  private readonly attached = new WeakSet<Session>()
  private onProgress: ((fraction: number) => void) | null = null

  constructor(
    private readonly db: Database,
    private readonly shellSync: ShellSync,
    private readonly settings: SettingsService
  ) {
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
    }
  }

  setProgressListener(fn: (fraction: number) => void): void {
    this.onProgress = fn
  }

  attach(session: Session): void {
    if (this.attached.has(session)) return
    this.attached.add(session)
    session.on('will-download', (_event, item) => this.track(item))
  }

  list(): Record<string, DownloadState> {
    return Object.fromEntries(this.states)
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
    this.states.delete(id)
    this.db.run('DELETE FROM downloads WHERE id = ?', id)
    this.shellSync.download(id, null)
  }

  clearFinished(): void {
    for (const [id, s] of this.states) if (s.status !== 'progressing') this.remove(id)
  }

  private track(item: DownloadItem): void {
    const id = randomUUID()
    const dir = this.settings.get().downloadDir || app.getPath('downloads')
    const filename = item.getFilename() || 'download'
    if (this.settings.get().downloadAskWhere) {
      item.setSaveDialogOptions({ defaultPath: join(dir, filename) })
    } else {
      const target = this.uniquePath(dir, filename)
      this.reservedPaths.add(target)
      item.setSavePath(target)
    }
    this.items.set(id, item)
    const state: DownloadState = {
      id,
      url: item.getURL(),
      filename,
      savePath: item.getSavePath(),
      status: 'progressing',
      paused: false,
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      endedAt: null
    }
    this.states.set(id, state)
    this.shellSync.download(id, state, true)
    this.persist(state)
    this.refreshDock()

    item.on('updated', (_e, s) => {
      const now = Date.now()
      if (now - (this.lastProgress.get(id) ?? 0) < PROGRESS_INTERVAL_MS) return
      this.lastProgress.set(id, now)
      const savePath = item.getSavePath()
      this.patch(id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        paused: item.isPaused(),
        savePath,
        filename: savePath ? basename(savePath) : filename,
        status: s === 'interrupted' ? 'interrupted' : 'progressing'
      })
      this.refreshDock()
    })

    item.once('done', (_e, s) => {
      this.items.delete(id)
      this.lastProgress.delete(id)
      const savePath = item.getSavePath()
      this.reservedPaths.delete(savePath)
      this.patch(id, {
        status: s,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        savePath,
        filename: savePath ? basename(savePath) : filename,
        paused: false,
        endedAt: Date.now()
      })
      const final = this.states.get(id)
      if (final) this.persist(final)
      if (s === 'completed' && savePath) app.dock?.downloadFinished(savePath)
      this.refreshDock()
    })
  }

  private patch(id: string, patch: Partial<DownloadState>): void {
    const s = this.states.get(id)
    if (!s) return
    Object.assign(s, patch)
    this.shellSync.download(id, patch)
  }

  private persist(s: DownloadState): void {
    this.db.run(
      `INSERT INTO downloads (id, url, filename, save_path, status, received_bytes, total_bytes, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, save_path = excluded.save_path,
         status = excluded.status, received_bytes = excluded.received_bytes,
         total_bytes = excluded.total_bytes, ended_at = excluded.ended_at`,
      s.id,
      s.url.slice(0, 8192),
      s.filename,
      s.savePath,
      s.status,
      s.receivedBytes,
      s.totalBytes,
      s.startedAt,
      s.endedAt
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

  private uniquePath(dir: string, filename: string): string {
    const safe = basename(filename).replace(/[/:]/g, '_') || 'download'
    const ext = extname(safe)
    const stem = ext ? safe.slice(0, -ext.length) : safe
    let candidate = join(dir, safe)
    for (let i = 1; existsSync(candidate) || this.reservedPaths.has(candidate); i++) {
      candidate = join(dir, `${stem} (${i})${ext}`)
    }
    return candidate
  }
}
