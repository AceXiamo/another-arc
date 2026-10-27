import type { HistoryEntry, Suggestion } from '@shared/types'
import type { Database } from '../persistence/database'
import { HistoryStore, isRecordableUrl } from './history-store'

interface PendingVisit {
  url: string
  title: string
  typed: boolean
  at: number
}

const FLUSH_DELAY_MS = 1000

/** Buffers visits, titles and icons and writes them in one transaction per second. */
export class HistoryService {
  readonly store: HistoryStore
  private visits: PendingVisit[] = []
  private readonly titles = new Map<string, string>()
  private readonly favicons = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly db: Database) {
    this.store = new HistoryStore(db)
  }

  recordVisit(url: string, title: string, typed: boolean): void {
    if (!isRecordableUrl(url)) return
    this.visits.push({ url, title, typed, at: Date.now() })
    this.schedule()
  }

  updateTitle(url: string, title: string): void {
    if (!title || !isRecordableUrl(url)) return
    this.titles.set(url, title)
    this.schedule()
  }

  /** `favicon` is a key into the favicon cache, already stored there. */
  updateFavicon(url: string, favicon: string): void {
    // Data URLs are cached too, but are too big to copy into every page row.
    if (favicon.startsWith('data:') || !isRecordableUrl(url)) return
    this.favicons.set(url, favicon)
    this.schedule()
  }

  suggest(query: string, limit: number): Suggestion[] {
    this.flush()
    return this.store.suggest(query, limit)
  }

  list(query: string, before: number, limit: number): HistoryEntry[] {
    this.flush()
    return this.store.list(query, before, limit)
  }

  deleteVisits(ids: number[]): void {
    this.flush()
    this.store.deleteVisits(ids)
  }

  clear(): void {
    this.visits = []
    this.titles.clear()
    this.favicons.clear()
    this.store.clear()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.visits.length === 0 && this.titles.size === 0 && this.favicons.size === 0) return
    const visits = this.visits
    this.visits = []
    this.db.transaction(() => {
      for (const v of visits) this.store.recordVisit(v.url, v.title, v.typed, v.at)
      for (const [url, title] of this.titles) this.store.updateTitle(url, title)
      for (const [url, favicon] of this.favicons) this.store.updateFavicon(url, favicon)
    })
    this.titles.clear()
    this.favicons.clear()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_DELAY_MS)
    this.timer.unref?.()
  }
}
