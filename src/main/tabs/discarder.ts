import { app } from 'electron'
import type { SettingsService } from '../settings/settings-service'
import type { TabManager } from './tab-manager'

const TICK_MS = 60_000
/** Tabs discarded per tick when over the memory budget (memory frees lazily). */
const MAX_PRESSURE_DISCARDS = 3

/**
 * Reclaims background tabs: those idle longer than the configured timeout,
 * and — when a memory budget is set — the least recently used ones until the
 * app fits again. Discarded tabs keep their history and reload on demand.
 */
export class TabDiscarder {
  private timer: NodeJS.Timeout | null = null
  discarded = 0

  constructor(
    private readonly tabs: TabManager,
    private readonly settings: SettingsService
  ) {}

  start(): void {
    this.timer ??= setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(now = Date.now()): void {
    const { discardAfterMinutes, memoryBudgetMB } = this.settings.get()
    const candidates = this.tabs.discardCandidates()
    if (discardAfterMinutes > 0) {
      const cutoff = now - discardAfterMinutes * 60_000
      for (const tab of candidates) {
        if (tab.lastActiveAt < cutoff && this.tabs.discardTab(tab.id)) this.discarded += 1
      }
    }
    if (memoryBudgetMB > 0 && totalMemoryMB() > memoryBudgetMB) {
      let n = 0
      for (const tab of this.tabs.discardCandidates()) {
        if (n >= MAX_PRESSURE_DISCARDS) break
        if (this.tabs.discardTab(tab.id)) {
          n += 1
          this.discarded += 1
        }
      }
    }
  }
}

export function totalMemoryMB(): number {
  let kb = 0
  for (const m of app.getAppMetrics()) kb += m.memory.workingSetSize
  return Math.round(kb / 1024)
}
