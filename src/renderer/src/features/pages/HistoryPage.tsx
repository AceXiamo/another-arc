import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Locale, Translate } from '@shared/i18n'
import type { HistoryEntry } from '@shared/types'
import { displayHost, displayUrl } from '@shared/url'
import { Favicon } from '../../components/Favicon'
import { Icon } from '../../components/Icon'
import { useLocale, useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { EmptyNote, PageLayout, SmallButton } from './PageLayout'

const PAGE = 100

/** BCP 47 tag for date and time formatting. */
const dateLocale = (locale: Locale) => (locale === 'zh-CN' ? 'zh-CN' : 'en-US')

/** One row: back-to-back visits of the same page (reloads, redirects back) fold into it. */
interface Row {
  ids: number[]
  url: string
  title: string
  favicon: string | null
  visitedAt: number
}

interface Day {
  key: string
  at: number
  rows: Row[]
}

function groupByDay(entries: HistoryEntry[]): Day[] {
  const days: Day[] = []
  for (const e of entries) {
    const key = new Date(e.visitedAt).toDateString()
    let day = days[days.length - 1]
    if (day?.key !== key) {
      day = { key, at: e.visitedAt, rows: [] }
      days.push(day)
    }
    const last = day.rows[day.rows.length - 1]
    if (last?.url === e.url) last.ids.push(e.id)
    else day.rows.push({ ids: [e.id], url: e.url, title: e.title, favicon: e.favicon, visitedAt: e.visitedAt })
  }
  return days
}

/** "Today" / "October 24" (+ the year when it is not this one), and the weekday or full date beside it. */
function dayLabels(ts: number, t: Translate, locale: Locale): { label: string; detail: string } {
  const tag = dateLocale(locale)
  const d = new Date(ts)
  const now = new Date()
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const weekday = d.toLocaleDateString(tag, { weekday: 'long' })
  const relative =
    d.toDateString() === now.toDateString()
      ? t('history.today')
      : d.toDateString() === yesterday.toDateString()
        ? t('history.yesterday')
        : null
  if (relative) return { label: relative, detail: d.toLocaleDateString(tag, { weekday: 'long', month: 'long', day: 'numeric' }) }
  const year = d.getFullYear() !== now.getFullYear() ? ({ year: 'numeric' } as const) : {}
  return { label: d.toLocaleDateString(tag, { month: 'long', day: 'numeric', ...year }), detail: weekday }
}

/** Address without the scheme or a leading "www.", for pages with no title. */
function bareUrl(url: string): string {
  return displayUrl(url).replace(/^https?:\/\/(www\.)?/, '')
}

/** Search words, lowercased, for highlighting. */
function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** `text` with every occurrence of the search words marked. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return text
  const lower = text.toLowerCase()
  const marks: Array<[number, number]> = []
  for (const term of terms) {
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + term.length)) marks.push([i, i + term.length])
  }
  if (marks.length === 0) return text
  marks.sort((a, b) => a[0] - b[0])
  const parts: React.ReactNode[] = []
  let pos = 0
  for (const [start, end] of marks) {
    if (end <= pos) continue
    if (start > pos) parts.push(text.slice(pos, start))
    parts.push(
      <mark key={start} className="rounded-[3px] bg-[var(--accent-soft)] text-inherit">
        {text.slice(Math.max(start, pos), end)}
      </mark>
    )
    pos = end
  }
  parts.push(text.slice(pos))
  return parts
}

function HistoryRow({ row, terms, onDelete }: { row: Row; terms: string[]; onDelete: (row: Row) => void }) {
  const t = useT()
  const locale = useLocale()
  const open = (background: boolean) => send('tabs.create', { url: row.url, background })
  return (
    <div className="group flex h-[46px] items-center rounded-[8px] hover:bg-[var(--hover)] has-[>button:first-child:active]:bg-[var(--press)]">
      <button
        title={displayUrl(row.url)}
        onClick={(e) => open(e.metaKey)}
        onAuxClick={(e) => e.button === 1 && open(true)}
        className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-[8px] pl-2 pr-1 text-left outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--focus)]"
      >
        <Favicon url={row.url} favicon={row.favicon} title={row.title} size={28} framed />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[var(--text-1)] group-hover:text-[var(--text)]">
            <Highlight text={row.title || bareUrl(row.url)} terms={terms} />
          </span>
          <span className="truncate text-[12px] leading-[16px] text-[var(--text-3)]">
            <Highlight text={displayHost(row.url, locale)} terms={terms} />
          </span>
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-3)]">
          {new Date(row.visitedAt).toLocaleTimeString(dateLocale(locale), { hour: '2-digit', minute: '2-digit' })}
        </span>
      </button>
      <button
        title={t('common.delete')}
        onClick={() => onDelete(row)}
        className="mr-1.5 grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--ink)] opacity-0 transition-[scale,opacity] duration-150 ease-out hover:bg-[var(--press)] hover:text-[var(--ink-strong)] focus-visible:opacity-100 active:scale-[0.92] group-hover:opacity-100"
      >
        <Icon name="close" size={13} strokeWidth={1.8} />
      </button>
    </div>
  )
}

export default function HistoryPage() {
  const t = useT()
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [done, setDone] = useState(false)
  // False until the first page for the current query arrives, so the empty
  // state never flashes while loading.
  const [loaded, setLoaded] = useState(false)
  // Paging state lives in refs so the IntersectionObserver never reads a
  // stale cursor from an old closure.
  const cursor = useRef(Number.MAX_SAFE_INTEGER)
  const generation = useRef(0)
  const loading = useRef(false)
  const sentinel = useRef<HTMLDivElement>(null)

  const loadMore = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    const gen = generation.current
    const first = cursor.current === Number.MAX_SAFE_INTEGER
    try {
      const page = await rpc('history.list', query, cursor.current, PAGE)
      if (gen !== generation.current) return
      const last = page[page.length - 1]
      if (last) cursor.current = last.visitedAt
      // The first page replaces the list: while typing, old results stay up
      // until the new ones arrive instead of blinking out.
      setEntries((prev) => (first ? page : [...prev, ...page]))
      setDone(page.length < PAGE)
      setLoaded(true)
    } finally {
      if (gen === generation.current) loading.current = false
    }
  }, [query])

  const reset = useCallback(() => {
    generation.current += 1
    cursor.current = Number.MAX_SAFE_INTEGER
    loading.current = false
    setDone(false)
    void loadMore()
  }, [loadMore])

  useEffect(reset, [reset])

  useEffect(() => {
    const node = sentinel.current
    if (!node || done) return
    const io = new IntersectionObserver((e) => {
      if (e[0]?.isIntersecting && cursor.current !== Number.MAX_SAFE_INTEGER) void loadMore()
    })
    io.observe(node)
    return () => io.disconnect()
  }, [loadMore, done])

  const days = useMemo(() => groupByDay(entries), [entries])
  const terms = useMemo(() => termsOf(query), [query])
  const remove = useCallback((row: Row) => {
    send('history.delete', row.ids)
    setEntries((list) => list.filter((x) => !row.ids.includes(x.id)))
  }, [])

  return (
    <PageLayout
      title={t('page.history')}
      actions={
        <SmallButton danger onClick={() => void rpc('history.clear').then(reset)}>
          {t('history.clearData')}
        </SmallButton>
      }
    >
      <label className="flex h-9 items-center gap-2 rounded-[10px] bg-[var(--surface-2)] pl-3 pr-1.5 shadow-[var(--card-shadow)] focus-within:shadow-[inset_0_0_0_1px_var(--focus),0_0_0_3px_color-mix(in_oklch,var(--space)_18%,transparent)]">
        <Icon name="search" size={15} className="text-[var(--ink)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
          placeholder={t('history.searchPlaceholder')}
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent outline-none"
        />
        {query && (
          <button
            title={t('history.clearSearch')}
            onClick={() => setQuery('')}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[var(--ink)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)] active:bg-[var(--press)]"
          >
            <Icon name="close" size={13} strokeWidth={1.8} />
          </button>
        )}
      </label>
      <div className="-mt-5 flex flex-col">
        {days.map((day) => {
          const { label, detail } = dayLabels(day.at, t, locale)
          return (
            <section key={day.key} className="flex flex-col">
              <h2 className="sticky top-0 z-10 -mx-2 flex items-baseline gap-2 bg-[var(--surface)] px-3 pb-2 pt-5">
                <span className="text-[13px] font-semibold text-[var(--text-1)]">{label}</span>
                <span className="text-[12px] text-[var(--text-3)]">{detail}</span>
              </h2>
              <div className="flex flex-col rounded-[12px] bg-[var(--surface-2)] p-1 shadow-[var(--card-shadow)]">
                {day.rows.map((row) => (
                  <HistoryRow key={row.ids[0]} row={row} terms={terms} onDelete={remove} />
                ))}
              </div>
            </section>
          )
        })}
        {loaded && entries.length === 0 && (
          <EmptyNote
            art={query ? 'no-results' : 'history'}
            title={query ? t('history.noMatches') : t('history.empty')}
            hint={query ? t('history.noMatchesHint') : t('history.emptyHint')}
          />
        )}
        {(!loaded || (entries.length > 0 && !done)) && (
          <div className={`grid place-items-center ${loaded ? 'py-6' : 'py-16'}`}>
            {/* Shows only if loading takes noticeably long. */}
            <span className="spinner [animation:spin_0.7s_linear_infinite,fade-in_0.2s_ease-out_0.4s_backwards]" />
          </div>
        )}
        <div ref={sentinel} className="h-4" />
      </div>
    </PageLayout>
  )
}
