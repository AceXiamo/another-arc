import { useCallback, useEffect, useRef, useState } from 'react'
import type { Locale, Translate } from '@shared/i18n'
import type { HistoryEntry } from '@shared/types'
import { displayUrl } from '@shared/url'
import { Favicon } from '../../components/Favicon'
import { Icon } from '../../components/Icon'
import { useLocale, useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { EmptyNote, PageLayout, SmallButton } from './PageLayout'

const PAGE = 100

/** BCP 47 tag for date and time formatting. */
const dateLocale = (locale: Locale) => (locale === 'zh-CN' ? 'zh-CN' : 'en-US')

function dayLabel(ts: number, t: Translate, locale: Locale): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86_400_000)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return t('history.today')
  if (same(d, yesterday)) return t('history.yesterday')
  return d.toLocaleDateString(dateLocale(locale), { month: 'long', day: 'numeric', weekday: 'short' })
}

export default function HistoryPage() {
  const t = useT()
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [done, setDone] = useState(false)
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
    try {
      const page = await rpc('history.list', query, cursor.current, PAGE)
      if (gen !== generation.current) return
      const last = page[page.length - 1]
      if (last) cursor.current = last.visitedAt
      setEntries((prev) => [...prev, ...page])
      setDone(page.length < PAGE)
    } finally {
      loading.current = false
    }
  }, [query])

  const reset = useCallback(() => {
    generation.current += 1
    cursor.current = Number.MAX_SAFE_INTEGER
    loading.current = false
    setEntries([])
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

  let lastDay = ''
  return (
    <PageLayout
      title={t('page.history')}
      actions={
        <SmallButton danger onClick={() => void rpc('history.clear').then(reset)}>
          {t('history.clearData')}
        </SmallButton>
      }
    >
      <label className="flex h-9 items-center gap-2 rounded-[10px] bg-[var(--surface-2)] px-3 shadow-[var(--card-shadow)] focus-within:shadow-[inset_0_0_0_1px_var(--focus),0_0_0_3px_color-mix(in_oklch,var(--space)_18%,transparent)]">
        <Icon name="search" size={15} className="text-[var(--ink)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('history.searchPlaceholder')}
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent outline-none"
        />
      </label>
      <div className="-mt-3 flex flex-col">
        {entries.map((e) => {
          const day = dayLabel(e.visitedAt, t, locale)
          const header = day !== lastDay
          lastDay = day
          return (
            <div key={e.id}>
              {header && (
                <div className="mb-1 mt-5 px-2 text-[12px] font-semibold text-[var(--text-2)]">
                  {day}
                </div>
              )}
              <div className="group flex h-9 items-center gap-3 rounded-[8px] px-2 hover:bg-[var(--hover)]">
                {/* 12-hour times ("10:14 PM") need a wider column than "22:14". */}
                <span
                  className={`${locale === 'zh-CN' ? 'w-10' : 'w-[58px]'} shrink-0 whitespace-nowrap text-[12px] tabular-nums text-[var(--text-3)]`}
                >
                  {new Date(e.visitedAt).toLocaleTimeString(dateLocale(locale), { hour: '2-digit', minute: '2-digit' })}
                </span>
                <Favicon url={e.url} favicon={null} title={e.title} />
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => send('tabs.create', { url: e.url })}>
                  {e.title || displayUrl(e.url)}
                  <span className="ml-2 text-[12px] text-[var(--text-3)]">{displayUrl(e.url)}</span>
                </button>
                <button
                  title={t('common.delete')}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[var(--ink)] opacity-0 hover:bg-[var(--press)] hover:text-[var(--ink-strong)] group-hover:opacity-100"
                  onClick={() => {
                    send('history.delete', [e.id])
                    setEntries((list) => list.filter((x) => x.id !== e.id))
                  }}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            </div>
          )
        })}
        {entries.length === 0 && (
          <div className="mt-3">
            <EmptyNote icon={query ? 'search' : 'history'}>{query ? t('history.noMatches') : t('history.empty')}</EmptyNote>
          </div>
        )}
        <div ref={sentinel} className="h-4" />
      </div>
    </PageLayout>
  )
}
