import type { FolderId, SpaceId, TabId } from '@shared/types'
import type { Database } from './database'
import type { FolderRecord, SpaceRecord, TabRecord } from './records'
import type { SessionStore } from './session-store'

export interface PersistSource {
  tabRecord(id: TabId): TabRecord | null
  spaceRecord(id: SpaceId): SpaceRecord | null
  folderRecord(id: FolderId): FolderRecord | null
}

export interface PersisterOptions {
  /** Quiet period before writing. */
  debounceMs: number
  /** Upper bound between the first change and the write, even under constant churn. */
  maxWaitMs: number
}

/**
 * Coalesces state changes into one transaction. Tabs change constantly while
 * pages load (title, favicon, URL); only the latest value of each dirty row is
 * written, at most once per debounce window.
 */
export class Persister {
  private readonly dirtyTabs = new Set<TabId>()
  private readonly removedTabs = new Set<TabId>()
  private readonly dirtySpaces = new Set<SpaceId>()
  private readonly removedSpaces = new Set<SpaceId>()
  private readonly dirtyFolders = new Set<FolderId>()
  private readonly removedFolders = new Set<FolderId>()
  private readonly settings = new Map<string, unknown>()
  private timer: NodeJS.Timeout | null = null
  private firstDirtyAt = 0
  private source: PersistSource | null = null
  private extraFlushers: Array<() => void> = []
  private closed = false
  writes = 0

  constructor(
    private readonly db: Database,
    private readonly store: SessionStore,
    private readonly options: PersisterOptions = { debounceMs: 800, maxWaitMs: 4000 }
  ) {}

  attach(source: PersistSource): void {
    this.source = source
  }

  /** Other services (history) piggyback on the same flush cadence. */
  addFlusher(fn: () => void): void {
    this.extraFlushers.push(fn)
  }

  markTab(id: TabId): void {
    this.removedTabs.delete(id)
    this.dirtyTabs.add(id)
    this.schedule()
  }

  removeTab(id: TabId): void {
    this.dirtyTabs.delete(id)
    this.removedTabs.add(id)
    this.schedule()
  }

  markSpace(id: SpaceId): void {
    this.removedSpaces.delete(id)
    this.dirtySpaces.add(id)
    this.schedule()
  }

  removeSpace(id: SpaceId): void {
    this.dirtySpaces.delete(id)
    this.removedSpaces.add(id)
    this.schedule()
  }

  markFolder(id: FolderId): void {
    this.removedFolders.delete(id)
    this.dirtyFolders.add(id)
    this.schedule()
  }

  removeFolder(id: FolderId): void {
    this.dirtyFolders.delete(id)
    this.removedFolders.add(id)
    this.schedule()
  }

  setSetting(key: string, value: unknown): void {
    this.settings.set(key, value)
    this.schedule()
  }

  get pending(): boolean {
    return (
      this.dirtyTabs.size +
        this.removedTabs.size +
        this.dirtySpaces.size +
        this.removedSpaces.size +
        this.dirtyFolders.size +
        this.removedFolders.size +
        this.settings.size >
      0
    )
  }

  /** No more writes (database is about to close). */
  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.closed) return
    const now = Date.now()
    if (!this.timer) this.firstDirtyAt = now
    else clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(this.options.debounceMs, this.firstDirtyAt + this.options.maxWaitMs - now))
    this.timer = setTimeout(() => this.flush(), wait)
    this.timer.unref?.()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.closed) return
    for (const fn of this.extraFlushers) fn()
    if (!this.pending || !this.source) return
    const source = this.source
    this.db.transaction(() => {
      for (const id of this.removedTabs) this.store.deleteTab(id)
      for (const id of this.removedFolders) this.store.deleteFolder(id)
      for (const id of this.removedSpaces) this.store.deleteSpace(id)
      for (const id of this.dirtySpaces) {
        const record = source.spaceRecord(id)
        if (record) this.store.saveSpace(record)
      }
      for (const id of this.dirtyFolders) {
        const record = source.folderRecord(id)
        if (record) this.store.saveFolder(record)
      }
      for (const id of this.dirtyTabs) {
        const record = source.tabRecord(id)
        if (record) this.store.saveTab(record)
      }
      for (const [key, value] of this.settings) this.store.saveSetting(key, value)
    })
    this.writes += 1
    this.removedTabs.clear()
    this.removedSpaces.clear()
    this.dirtySpaces.clear()
    this.removedFolders.clear()
    this.dirtyFolders.clear()
    this.dirtyTabs.clear()
    this.settings.clear()
  }
}
