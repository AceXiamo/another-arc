import { useEffect, useMemo, useRef, useState } from 'react'
import { LOCALES, translate, type Locale, type MessageKey, type Translate } from '@shared/i18n'
import { LAYOUT } from '@shared/layout'
import type { Suggestion, TabState } from '@shared/types'
import {
  displayUrl,
  fallbackTitle,
  INTERNAL_PAGES,
  isInternalUrl,
  resolveInput,
  SEARCH_ENGINES,
  searchTemplate,
  type InternalPage
} from '@shared/url'
import { Favicon } from '../../components/Favicon'
import { Icon, type IconName } from '../../components/Icon'
import { useLocale, useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import { useUi, type PaletteMode } from '../../stores/ui'

interface Item {
  key: string
  icon: { kind: 'icon'; name: IconName } | { kind: 'favicon'; url: string; favicon: string | null; title: string }
  title: string
  subtitle?: string
  hint: string
  run(background: boolean): void
}

interface Command {
  id: string
  /** Match words in every language, so typing English or Chinese finds it. */
  words: string[]
  title(t: Translate): string
  icon: IconName
  run(): void
}

/** A command's comma-separated match words, gathered from every locale. */
function keywords(key: MessageKey): string[] {
  return LOCALES.flatMap((l) =>
    translate(l.id, key)
      .split(',')
      .map((w) => w.trim())
      .filter(Boolean)
  )
}

const COMMANDS: Command[] = [
  ...(Object.entries(INTERNAL_PAGES) as Array<[InternalPage, MessageKey]>).map(([page, name]) => ({
    id: `open:${page}`,
    words: [...LOCALES.map((l) => translate(l.id, name)), page],
    title: (t: Translate) => t('palette.command.openPage', { page: t(name) }),
    icon: ({ settings: 'settings', extensions: 'puzzle', history: 'history', downloads: 'download' } as const)[page],
    run: () => send('tabs.openInternal', page)
  })),
  {
    id: 'new-space',
    words: keywords('palette.keywords.newSpace'),
    title: (t) => t('palette.command.newSpace'),
    icon: 'plus',
    run: () => useUi.setState({ spaceEditor: 'new' })
  },
  {
    id: 'reopen-closed',
    words: keywords('palette.keywords.reopenClosedTab'),
    title: (t) => t('palette.command.reopenClosedTab'),
    icon: 'history',
    run: () => send('tabs.reopenClosed')
  },
  {
    id: 'toggle-sidebar',
    words: keywords('palette.keywords.toggleSidebar'),
    title: (t) => t('palette.command.toggleSidebar'),
    icon: 'sidebar',
    run: () => {
      const collapsed = useBrowser.getState().window.sidebarCollapsed
      send('window.setSidebar', { collapsed: !collapsed })
    }
  },
  {
    id: 'load-unpacked-extension',
    words: keywords('palette.keywords.loadUnpackedExtension'),
    title: (t) => t('palette.command.loadUnpackedExtension'),
    icon: 'puzzle',
    run: () => send('extensions.install')
  },
  {
    id: 'import-extensions-arc',
    words: keywords('extImport.palette.keywords'),
    title: (t) => t('extImport.palette.command', { browser: 'Arc' }),
    icon: 'download',
    // Main confirms first, or says when no Arc profile was found.
    run: () => send('extensions.importFromBrowser', 'arc')
  },
  {
    id: 'import-browser',
    words: keywords('browserImport.palette.keywords'),
    title: (t) => t('browserImport.palette.command'),
    icon: 'download',
    // Bookmarks, extensions and logins; main picks the browser and confirms first.
    run: () => send('import.best')
  }
]

function matches(text: string, q: string): boolean {
  return text.toLowerCase().includes(q)
}

function tabItem(tab: TabState, current: string | undefined, t: Translate, locale: Locale): Item {
  return {
    key: `tab:${tab.id}`,
    icon: { kind: 'favicon', url: tab.url, favicon: tab.favicon, title: tab.title },
    title: tab.title || fallbackTitle(tab.url, locale),
    subtitle: isInternalUrl(tab.url) ? undefined : displayUrl(tab.url),
    hint: tab.id === current ? t('palette.hint.current') : t('palette.hint.switchToTab'),
    run: () => send('tabs.activate', tab.id)
  }
}

export function CommandPalette({ mode, cardLeft }: { mode: PaletteMode; cardLeft: string }) {
  const t = useT()
  const locale = useLocale()
  const activeTab = useBrowser(selectActiveTab)
  const tabs = useBrowser((s) => s.tabs)
  const settings = useBrowser((s) => s.settings)
  const initial = mode === 'edit-url' && activeTab && !isInternalUrl(activeTab.url) ? activeTab.url : ''
  const [query, setQuery] = useState(initial)
  const [selected, setSelected] = useState(0)
  const [history, setHistory] = useState<Suggestion[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const close = () => useUi.setState({ palette: null })

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    if (initial) input.select()
  }, [initial])

  // History suggestions. Each keystroke issues one indexed query (~1 ms in
  // main); responses for outdated input are dropped.
  const trimmed = query.trim()
  const pristine = mode === 'edit-url' && query === initial
  useEffect(() => {
    if (!trimmed || pristine) {
      setHistory([])
      return
    }
    let alive = true
    rpc('history.suggest', trimmed, 8)
      .then((r) => alive && setHistory(r))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [trimmed, pristine])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const q = trimmed.toLowerCase()
    const template = searchTemplate(settings)
    const engine = settings.searchEngine === 'custom' ? t('search.genericEngine') : SEARCH_ENGINES[settings.searchEngine].name
    const openHint = mode === 'edit-url' ? t('palette.hint.go') : t('common.open')
    const seen = new Set<string>()

    if (q && !pristine) {
      const resolved = resolveInput(trimmed, template)
      if (resolved) {
        seen.add(resolved.url)
        out.push({
          key: 'go',
          icon: { kind: 'icon', name: resolved.kind === 'url' ? 'globe' : 'search' },
          title: resolved.kind === 'url' ? displayUrl(resolved.url) : trimmed,
          subtitle: resolved.kind === 'url' ? undefined : t('palette.subtitle.searchWith', { engine }),
          hint: openHint,
          run: (background) => {
            if (mode === 'edit-url' && activeTab) send('tabs.navigate', activeTab.id, trimmed)
            else send('tabs.create', { url: trimmed, background })
          }
        })
      }
    }

    const allTabs = Object.values(tabs)
    if (q && !pristine) {
      for (const tab of allTabs) {
        if (out.length >= 5) break
        if (tab.id === activeTab?.id) continue
        if (matches(tab.title, q) || matches(tab.url, q)) {
          seen.add(tab.url)
          out.push(tabItem(tab, activeTab?.id, t, locale))
        }
      }
      for (const h of history) {
        if (seen.has(h.url)) continue
        seen.add(h.url)
        out.push({
          key: `h:${h.url}`,
          icon: { kind: 'favicon', url: h.url, favicon: null, title: h.title },
          title: h.title || displayUrl(h.url),
          subtitle: displayUrl(h.url),
          hint: openHint,
          run: (background) => {
            if (mode === 'edit-url' && activeTab) send('tabs.navigate', activeTab.id, h.url)
            else send('tabs.create', { url: h.url, background })
          }
        })
      }
      let commands = 0
      for (const c of COMMANDS) {
        if (commands >= 3) break
        if (c.words.some((w) => matches(w, q) || (q.length >= 2 && w.toLowerCase().startsWith(q)))) {
          commands += 1
          out.push({
            key: `cmd:${c.id}`,
            icon: { kind: 'icon', name: c.icon },
            title: c.title(t),
            hint: t('palette.hint.command'),
            run: c.run
          })
        }
      }
    } else if (mode === 'new-tab') {
      // Nothing typed yet: offer the most recently used tabs.
      const recent = allTabs
        .filter((tab) => tab.id !== activeTab?.id)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, 6)
      for (const tab of recent) out.push(tabItem(tab, activeTab?.id, t, locale))
    }
    return out
  }, [trimmed, pristine, history, tabs, settings, mode, activeTab, t, locale])

  useEffect(() => setSelected(0), [trimmed])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const runSelected = (background: boolean) => {
    const item = items[selected]
    if (item) item.run(background)
    else if (pristine) send('window.focusPage')
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      setSelected((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      setSelected((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      runSelected(e.metaKey)
    } else if (e.key === 'Tab' && !e.shiftKey) {
      const item = items[selected]
      if (item?.subtitle && item.key.startsWith('h:')) {
        e.preventDefault()
        setQuery(item.subtitle)
      }
    }
  }

  return (
    <div className="anim-fade absolute inset-0 z-40" onPointerDown={close} style={{ background: 'var(--overlay)' }}>
      <div
        className="absolute flex justify-center"
        style={{ left: cardLeft, right: LAYOUT.gutter, top: LAYOUT.gutter, bottom: LAYOUT.gutter, paddingTop: '13vh' }}
      >
        <div
          className="anim-pop flex h-fit max-h-[70vh] w-[min(640px,calc(100%-32px))] flex-col overflow-hidden rounded-[16px] bg-[var(--popover)] shadow-[var(--popover-shadow)]"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 px-[18px]">
            <Icon name="search" size={18} className="text-[var(--ink)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
              placeholder={mode === 'edit-url' ? t('palette.input.editUrlPlaceholder') : t('palette.input.searchPlaceholder')}
              className="h-[54px] min-w-0 flex-1 bg-transparent text-[17px] outline-none"
            />
          </div>
          {items.length > 0 && (
            <div ref={listRef} className="scroll-y border-t border-[var(--popover-line)] p-1.5">
              {items.map((item, i) => {
                const current = i === selected
                return (
                  <div
                    key={item.key}
                    data-index={i}
                    onPointerMove={() => !current && setSelected(i)}
                    onClick={(e) => {
                      item.run(e.metaKey)
                      close()
                    }}
                    className={`flex h-10 items-center gap-3 rounded-[10px] px-3 ${current ? 'bg-[var(--accent-soft)]' : ''}`}
                  >
                    {item.icon.kind === 'icon' ? (
                      <span className={`grid h-4 w-4 shrink-0 place-items-center ${current ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                        <Icon name={item.icon.name} size={16} />
                      </span>
                    ) : (
                      <Favicon url={item.icon.url} favicon={item.icon.favicon} title={item.icon.title} />
                    )}
                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="shrink-0 truncate max-w-[70%]">{item.title}</span>
                      {item.subtitle && <span className="min-w-0 truncate text-[12px] text-[var(--text-3)]">{item.subtitle}</span>}
                    </div>
                    <span
                      className={`flex shrink-0 items-center gap-1.5 text-[11.5px] ${
                        current ? 'text-[var(--accent)]' : 'text-[var(--text-3)] opacity-0'
                      }`}
                    >
                      {item.hint}
                      <Icon name="enter" size={12} strokeWidth={1.9} />
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
