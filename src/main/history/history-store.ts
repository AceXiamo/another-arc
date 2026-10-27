import type { HistoryEntry, Suggestion } from '@shared/types'
import type { Database } from '../persistence/database'

const DAY = 86_400_000

/** Frecency: visit counts weighted by recency, typed URLs count extra. */
const SCORE_SQL = `
  (h.visit_count + h.typed_count * 4) *
  CASE
    WHEN :now - h.last_visit_at < ${4 * DAY} THEN 1.0
    WHEN :now - h.last_visit_at < ${14 * DAY} THEN 0.7
    WHEN :now - h.last_visit_at < ${31 * DAY} THEN 0.5
    WHEN :now - h.last_visit_at < ${90 * DAY} THEN 0.3
    ELSE 0.1
  END *
  CASE WHEN instr(h.url, '://' || :prefix) > 0 OR instr(h.url, '://www.' || :prefix) > 0 THEN 4 ELSE 1 END`

/** Trigram tokens need at least three characters to hit the index. */
const MIN_FTS_TERM = 3
/** Short queries scan only this many of the most recent URLs. */
const SHORT_QUERY_WINDOW = 5000

export function isRecordableUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://') || url.startsWith('file://')
}

function splitTerms(query: string): { fts: string[]; short: string[] } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return {
    fts: terms.filter((t) => t.length >= MIN_FTS_TERM),
    short: terms.filter((t) => t.length < MIN_FTS_TERM)
  }
}

function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ')
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Origin of an http(s) page; other schemes have no site icon to borrow. */
function webOrigin(url: string): string | null {
  if (!url.startsWith('https://') && !url.startsWith('http://')) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export class HistoryStore {
  constructor(private readonly db: Database) {}

  recordVisit(url: string, title: string, typed: boolean, at: number): void {
    if (!isRecordableUrl(url)) return
    this.db.transaction(() => {
      const row = this.db.get<{ id: number }>(
        `INSERT INTO history_urls (url, title, visit_count, typed_count, last_visit_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           visit_count = visit_count + 1,
           typed_count = typed_count + excluded.typed_count,
           last_visit_at = excluded.last_visit_at,
           title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END
         RETURNING id`,
        url,
        title,
        typed ? 1 : 0,
        at
      )
      if (row) this.db.run('INSERT INTO visits (url_id, visited_at) VALUES (?, ?)', row.id, at)
    })
  }

  updateTitle(url: string, title: string): void {
    if (!title || !isRecordableUrl(url)) return
    this.db.run('UPDATE history_urls SET title = ? WHERE url = ? AND title <> ?', title, url, title)
  }

  updateFavicon(url: string, favicon: string): void {
    if (!favicon || !isRecordableUrl(url)) return
    this.db.run('UPDATE history_urls SET favicon = ? WHERE url = ? AND favicon IS NOT ?', favicon, url, favicon)
  }

  suggest(query: string, limit: number, now = Date.now()): Suggestion[] {
    const q = query.trim()
    if (!q) return []
    const { fts, short } = splitTerms(q)
    const prefix = q.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').split(/\s+/)[0]!
    const shortFilters = short.map(
      (_, i) => `AND (h.url LIKE :s${i} ESCAPE '\\' OR h.title LIKE :s${i} ESCAPE '\\')`
    )
    const params: Record<string, string | number> = { now, prefix, limit }
    short.forEach((t, i) => (params[`s${i}`] = `%${escapeLike(t)}%`))

    let sql: string
    if (fts.length > 0) {
      params.match = ftsQuery(fts)
      sql = `SELECT h.url AS url, h.title AS title, h.favicon AS favicon, ${SCORE_SQL} AS score
             FROM history_fts JOIN history_urls h ON h.id = history_fts.rowid
             WHERE history_fts MATCH :match ${shortFilters.join(' ')}
             ORDER BY score DESC LIMIT :limit`
    } else {
      sql = `SELECT h.url AS url, h.title AS title, h.favicon AS favicon, ${SCORE_SQL} AS score
             FROM (SELECT * FROM history_urls ORDER BY last_visit_at DESC LIMIT ${SHORT_QUERY_WINDOW}) h
             WHERE 1 ${shortFilters.join(' ')}
             ORDER BY score DESC LIMIT :limit`
    }
    const rows = this.db.stmt(sql).all(params) as Array<{ url: string; title: string; favicon: string | null }>
    return this.withSiteIcons(rows).map((r) => ({ kind: 'history', url: r.url, title: r.title, favicon: r.favicon }))
  }

  list(query: string, before: number, limit: number): HistoryEntry[] {
    const q = query.trim()
    if (!q) {
      return this.withSiteIcons(
        this.db.all<HistoryEntry>(
          `SELECT v.id AS id, h.url AS url, h.title AS title, v.visited_at AS visitedAt, h.favicon AS favicon
           FROM visits v JOIN history_urls h ON h.id = v.url_id
           WHERE v.visited_at < ? ORDER BY v.visited_at DESC LIMIT ?`,
          before,
          limit
        )
      )
    }
    const { fts, short } = splitTerms(q)
    const params: Record<string, string | number> = { before, limit }
    const filters: string[] = []
    if (fts.length > 0) {
      params.match = ftsQuery(fts)
      filters.push('AND v.url_id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH :match)')
    }
    short.forEach((t, i) => {
      params[`s${i}`] = `%${escapeLike(t)}%`
      filters.push(`AND (h.url LIKE :s${i} ESCAPE '\\' OR h.title LIKE :s${i} ESCAPE '\\')`)
    })
    return this.withSiteIcons(
      this.db.stmt(
        `SELECT v.id AS id, h.url AS url, h.title AS title, v.visited_at AS visitedAt, h.favicon AS favicon
         FROM visits v JOIN history_urls h ON h.id = v.url_id
         WHERE v.visited_at < :before ${filters.join(' ')}
         ORDER BY v.visited_at DESC LIMIT :limit`
      ).all(params) as unknown as HistoryEntry[]
    )
  }

  deleteVisits(ids: number[]): void {
    if (ids.length === 0) return
    this.db.transaction(() => {
      for (const id of ids) this.db.run('DELETE FROM visits WHERE id = ?', id)
      this.removeOrphans()
    })
  }

  clear(): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM visits')
      this.db.run('DELETE FROM history_urls')
    })
  }

  /** Drop visits older than `maxAgeDays` and URLs nothing refers to anymore. */
  prune(maxAgeDays: number, now = Date.now()): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM visits WHERE visited_at < ?', now - maxAgeDays * DAY)
      this.removeOrphans()
    })
  }

  /**
   * Pages that never reported an icon (visited before icons were recorded, or
   * left before theirs loaded) borrow one from another page of the same site,
   * else get the site's `/favicon.ico`, which the shell's favicon protocol
   * fetches on first display.
   */
  private withSiteIcons<T extends { url: string; favicon: string | null }>(rows: T[]): T[] {
    const bySite = new Map<string, string>()
    for (const row of rows) {
      if (row.favicon) continue
      const origin = webOrigin(row.url)
      if (!origin) continue
      let icon = bySite.get(origin)
      if (icon === undefined) {
        // A range on the url index covers exactly this origin's pages.
        icon =
          this.db.get<{ favicon: string }>(
            'SELECT favicon FROM history_urls WHERE url >= ? AND url < ? AND favicon IS NOT NULL LIMIT 1',
            `${origin}/`,
            `${origin}0`
          )?.favicon ?? `${origin}/favicon.ico`
        bySite.set(origin, icon)
      }
      row.favicon = icon
    }
    return rows
  }

  private removeOrphans(): void {
    this.db.run('DELETE FROM history_urls WHERE id NOT IN (SELECT DISTINCT url_id FROM visits)')
  }
}
