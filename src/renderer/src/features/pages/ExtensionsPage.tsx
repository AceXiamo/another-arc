import { useEffect, useMemo, useState } from 'react'
import type { ImportSourceSummary } from '@shared/ext-import'
import type { ExtensionInfo } from '@shared/types'
import { Icon, type IconName } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import ExtensionDetails from './ExtensionDetails'
import { ExtensionIcon, useExtensionsNav } from './extension-ui'
import { EmptyNote, PageLayout, PrimaryButton, SecondaryButton, SmallButton, Toggle } from './PageLayout'

const STORE_URL = 'https://chromewebstore.google.com/category/extensions'
/** Past this many, the list gets a search field. */
const SEARCH_FROM = 7

/** browser://extensions?id=<id> shows one extension, like chrome://extensions/?id=. */
function detailsId(url: string): string | null {
  const id = /[?&]id=([a-p]{32})\b/.exec(url)?.[1]
  return id ?? null
}

export default function ExtensionsPage() {
  const url = useBrowser((s) => selectActiveTab(s)?.url ?? '')
  const id = detailsId(url)
  return id ? <ExtensionDetails key={id} id={id} /> : <ExtensionList />
}

function ExtensionList() {
  const t = useT()
  const extensions = useBrowser((s) => s.extensions)
  const [query, setQuery] = useState('')
  const sorted = useMemo(() => [...extensions].sort((a, b) => a.name.localeCompare(b.name)), [extensions])
  const q = query.trim().toLowerCase()
  const shown = q ? sorted.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(q)) : sorted
  return (
    <PageLayout
      title={t('page.extensions')}
      actions={
        <div className="flex items-center gap-1.5">
          <SecondaryButton icon="store" onClick={() => send('tabs.create', { url: STORE_URL })}>
            {t('extensions.page.store')}
          </SecondaryButton>
          <PrimaryButton onClick={() => send('extensions.install')}>
            <Icon name="plus" size={14} strokeWidth={2} />
            {t('extensions.page.load')}
          </PrimaryButton>
        </div>
      }
    >
      {extensions.length === 0 ? (
        <EmptyNote art="extensions" title={t('extensions.page.empty')} hint={t('extensions.page.emptyHint')} />
      ) : (
        <>
          <Attention extensions={sorted} />
          {extensions.length >= SEARCH_FROM && <SearchField value={query} onChange={setQuery} />}
          {shown.length === 0 ? (
            <p className="px-1 text-[13px] text-[var(--text-3)]">{t('extensions.page.noMatch', { query: query.trim() })}</p>
          ) : (
            <div className="flex flex-col rounded-[12px] bg-[var(--surface-2)] shadow-[var(--card-shadow)] [&>*+*]:shadow-[inset_0_0.5px_0_var(--line)]">
              {shown.map((ext) => (
                <ExtensionRow key={ext.id} ext={ext} />
              ))}
            </div>
          )}
        </>
      )}
      <ImportLinks />
    </PageLayout>
  )
}

function ExtensionRow({ ext }: { ext: ExtensionInfo }) {
  const t = useT()
  const nav = useExtensionsNav()
  const hasErrors = ext.errorCount > 0
  return (
    <div className="group relative flex min-h-[60px] items-center gap-3 px-4 py-2.5 first:rounded-t-[12px] last:rounded-b-[12px] hover:bg-[var(--hover)] has-[>button:first-child:active]:bg-[var(--press)]">
      {/* The whole row opens the details; the controls sit above it. */}
      <button
        aria-label={t('extensions.page.open', { name: ext.name })}
        onClick={() => nav.open(ext.id)}
        className="absolute inset-0 rounded-[inherit] focus-visible:outline-offset-[-2px]"
      />
      <ExtensionIcon ext={ext} size={28} />
      <div className="pointer-events-none min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className={`truncate text-[13.5px] font-medium ${ext.enabled ? 'text-[var(--text)]' : 'text-[var(--text-2)]'}`}>
            {ext.name}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--text-3)]">{ext.version}</span>
        </div>
        {ext.description && <p className="mt-0.5 truncate text-[12px] text-[var(--text-3)]">{ext.description}</p>}
      </div>
      {hasErrors && (
        <span className="pointer-events-none flex shrink-0 items-center gap-1 rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--danger)]">
          <Icon name="warning" size={11} strokeWidth={2} />
          {t('extensions.row.error')}
        </span>
      )}
      {ext.hasAction && ext.enabled && (
        <button
          title={ext.pinned ? t('extensions.action.unpin') : t('extensions.action.pin')}
          aria-pressed={ext.pinned}
          onClick={() => send('extensions.setPinned', ext.id, !ext.pinned)}
          className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-[7px] transition-[opacity,scale,background-color,color] duration-150 ease-out hover:bg-[var(--hover)] active:scale-[0.96] active:bg-[var(--press)] ${
            ext.pinned ? 'text-[var(--accent)]' : 'text-[var(--ink-faint)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          }`}
        >
          <Icon name="pin" size={14} strokeWidth={1.8} />
        </button>
      )}
      <span className="relative">
        <Toggle
          checked={ext.enabled}
          label={t('extensions.action.enable')}
          onChange={(v) => void rpc('extensions.setEnabled', ext.id, v)}
        />
      </span>
      <Icon name="chevronRight" size={14} strokeWidth={1.8} className="pointer-events-none -mr-1 text-[var(--ink-faint)]" />
    </div>
  )
}

/** What needs the user: user scripts waiting for permission, extensions with errors. */
function Attention({ extensions }: { extensions: ExtensionInfo[] }) {
  const t = useT()
  const nav = useExtensionsNav()
  const [busy, setBusy] = useState<string | null>(null)
  const items: Array<{
    id: string
    icon: IconName
    text: string
    action: string
    run: () => void
    tone: 'accent' | 'danger'
  }> = []
  for (const ext of extensions) {
    if (!ext.enabled) continue
    if (ext.userScripts === false) {
      items.push({
        id: `${ext.id}:us`,
        icon: 'code',
        tone: 'accent',
        text: t('extensions.attention.userScripts', { name: ext.name }),
        action: t('extensions.attention.turnOn'),
        run: () => {
          setBusy(`${ext.id}:us`)
          rpc('extensions.setUserScripts', ext.id, true).finally(() => setBusy(null))
        }
      })
    }
    if (ext.errorCount > 0) {
      items.push({
        id: `${ext.id}:err`,
        icon: 'warning',
        tone: 'danger',
        text: t(ext.error ? 'extensions.attention.loadFailed' : 'extensions.attention.errors', { name: ext.name }),
        action: t('extensions.attention.view'),
        run: () => nav.open(ext.id)
      })
    }
  }
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((item) => (
        <div
          key={item.id}
          className={`anim-fade flex items-center gap-2.5 rounded-[10px] py-1.5 pl-3 pr-1.5 text-[12.5px] ${
            item.tone === 'danger' ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--accent-soft)] text-[var(--text)]'
          }`}
        >
          <Icon name={item.icon} size={14} strokeWidth={1.9} className={item.tone === 'accent' ? 'text-[var(--accent)]' : ''} />
          <span className="min-w-0 flex-1 text-pretty">{item.text}</span>
          <button
            disabled={busy === item.id}
            onClick={item.run}
            className={`h-7 shrink-0 rounded-[7px] px-2.5 text-[12px] font-medium transition-[scale,background-color,opacity] duration-150 ease-out active:scale-[0.96] disabled:opacity-50 ${
              item.tone === 'danger'
                ? 'hover:bg-[color-mix(in_oklab,var(--danger)_14%,transparent)]'
                : 'bg-[var(--accent-fill)] text-white hover:brightness-110'
            }`}
          >
            {item.action}
          </button>
        </div>
      ))}
    </div>
  )
}

function SearchField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  return (
    <label className="flex h-8 items-center gap-2 rounded-[9px] bg-[var(--surface-2)] px-2.5 shadow-[var(--card-shadow)] focus-within:shadow-[inset_0_0_0_1px_var(--focus),0_0_0_3px_color-mix(in_oklch,var(--space)_18%,transparent)]">
      <Icon name="search" size={14} className="text-[var(--ink-faint)]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')}
        placeholder={t('extensions.page.search')}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-3)]"
      />
    </label>
  )
}

/** "Import from Arc" (and other browsers): only for browsers found with extensions. */
function ImportLinks() {
  const t = useT()
  const [sources, setSources] = useState<ImportSourceSummary[]>([])
  const [busy, setBusy] = useState<ImportSourceSummary['id'] | null>(null)
  useEffect(() => {
    let alive = true
    rpc('extensions.importSources').then(
      (list) => alive && setSources(list),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])
  if (sources.length === 0) return null
  const run = async (source: ImportSourceSummary) => {
    setBusy(source.id)
    try {
      await rpc('extensions.importFromBrowser', source.id)
    } catch {
      // Main reports everything in its own dialogs.
    } finally {
      setBusy(null)
      rpc('extensions.importSources').then(setSources, () => undefined)
    }
  }
  return (
    <div className="-mt-3 flex flex-wrap items-center gap-0.5 px-0.5">
      {sources.map((source) => (
        <SmallButton key={source.id} disabled={busy !== null} onClick={() => void run(source)}>
          <span
            className="flex items-center gap-1.5"
            title={t('extImport.button.title', {
              browser: source.browserName,
              profile: source.profileName
            })}
          >
            <Icon name="download" size={13} strokeWidth={1.9} />
            {busy === source.id ? t('extImport.button.busy') : t('extImport.button', { browser: source.browserName })}
          </span>
        </SmallButton>
      ))}
    </div>
  )
}
