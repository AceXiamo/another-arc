import { useEffect, useState } from 'react'
import type { ImportSourceSummary } from '@shared/ext-import'
import type { ExtensionInfo } from '@shared/types'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { EmptyNote, PageLayout, PrimaryButton, SmallButton, Toggle } from './PageLayout'

function PermissionList({ ext }: { ext: ExtensionInfo }) {
  const t = useT()
  const all = [...ext.permissions, ...ext.hostPermissions]
  if (all.length === 0) return <div className="px-4 pb-3 text-[12px] text-[var(--text-3)]">{t('extensions.card.noPermissions')}</div>
  const broad = ext.hostPermissions.some((p) => p === '<all_urls>' || p.startsWith('*://*/') || p === 'http://*/*' || p === 'https://*/*')
  return (
    <div className="flex flex-col gap-2 px-4 pb-3">
      {broad && (
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--danger)]">
          <Icon name="warning" size={13} strokeWidth={1.9} />
          {t('extensions.card.broadAccess')}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {all.map((p) => (
          <code
            key={p}
            className="rounded-[5px] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line)]"
          >
            {p}
          </code>
        ))}
      </div>
    </div>
  )
}

function ExtensionCard({ ext }: { ext: ExtensionInfo }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col rounded-[12px] bg-[var(--surface-2)] shadow-[var(--card-shadow)]">
      <div className="flex items-start gap-3 p-4">
        {ext.icon ? (
          <img src={ext.icon} width={36} height={36} alt="" className={`shrink-0 ${ext.enabled ? '' : 'opacity-50 grayscale'}`} />
        ) : (
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] bg-[var(--surface-3)] text-[var(--ink)]">
            <Icon name="puzzle" size={18} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate font-semibold ${ext.enabled ? '' : 'text-[var(--text-2)]'}`}>{ext.name}</span>
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--text-3)]">{ext.version}</span>
            <span className="shrink-0 rounded-[4px] bg-[var(--hover)] px-1 py-px text-[10px] font-semibold text-[var(--text-2)]">
              MV{ext.manifestVersion}
            </span>
          </div>
          {ext.description && <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-[var(--text-2)]">{ext.description}</p>}
          <p className="mt-1 truncate font-mono text-[11px] text-[var(--text-3)]" title={ext.sourcePath}>
            {ext.id}
          </p>
        </div>
        <Toggle checked={ext.enabled} label={t('extensions.card.enable')} onChange={(v) => void run(() => rpc('extensions.setEnabled', ext.id, v))} />
      </div>
      {ext.error && (
        <div className="mx-4 mb-3 flex items-start gap-1.5 rounded-[8px] bg-[var(--danger-soft)] px-2.5 py-2 text-[12px] text-[var(--danger)]">
          <Icon name="warning" size={13} className="mt-px" />
          <span className="break-all">{ext.error}</span>
        </div>
      )}
      {open && <PermissionList ext={ext} />}
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 shadow-[inset_0_0.5px_0_var(--line)]">
        <SmallButton onClick={() => setOpen((v) => !v)}>{open ? t('extensions.card.hidePermissions') : t('extensions.card.showPermissions')}</SmallButton>
        {ext.hasAction && (
          <SmallButton onClick={() => send('extensions.setPinned', ext.id, !ext.pinned)}>
            {ext.pinned ? t('extensions.card.unpin') : t('extensions.card.pin')}
          </SmallButton>
        )}
        {ext.optionsUrl && (
          <SmallButton disabled={!ext.enabled} onClick={() => send('extensions.openOptions', ext.id)}>
            {t('extensions.card.options')}
          </SmallButton>
        )}
        <SmallButton disabled={busy} onClick={() => void run(() => rpc('extensions.update', ext.id))}>
          {t('extensions.card.update')}
        </SmallButton>
        <div className="flex-1" />
        <SmallButton danger disabled={busy} onClick={() => void run(() => rpc('extensions.uninstall', ext.id))}>
          {t('extensions.card.remove')}
        </SmallButton>
      </div>
    </div>
  )
}

/** "Import from Arc" (and Chrome): shown only for browsers detected with extensions. */
function ImportButtons() {
  const t = useT()
  const [sources, setSources] = useState<ImportSourceSummary[]>([])
  const [busy, setBusy] = useState<ImportSourceSummary['id'] | null>(null)
  const refresh = () => rpc('extensions.importSources').then(setSources, () => undefined)
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
  const run = async (source: ImportSourceSummary) => {
    setBusy(source.id)
    try {
      await rpc('extensions.importFromBrowser', source.id)
    } catch {
      // Main reports everything in its own dialogs.
    } finally {
      setBusy(null)
      void refresh()
    }
  }
  return sources.map((source) => (
    <button
      key={source.id}
      disabled={busy !== null}
      title={t('extImport.button.title', { browser: source.browserName, profile: source.profileName })}
      onClick={() => void run(source)}
      className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] bg-[var(--surface-2)] px-3 text-[12.5px] font-medium text-[var(--text)] shadow-[var(--card-shadow)] hover:bg-[var(--surface-3)] active:brightness-95 disabled:opacity-50 disabled:hover:bg-[var(--surface-2)]"
    >
      <Icon name="download" size={14} strokeWidth={2} />
      {busy === source.id ? t('extImport.button.busy') : t('extImport.button', { browser: source.browserName })}
    </button>
  ))
}

export default function ExtensionsPage() {
  const t = useT()
  const extensions = useBrowser((s) => s.extensions)
  return (
    <PageLayout
      title={t('page.extensions')}
      actions={
        <div className="flex items-center gap-2">
          <ImportButtons />
          <PrimaryButton onClick={() => send('extensions.install')}>
            <Icon name="plus" size={14} strokeWidth={2} />
            {t('extensions.page.load')}
          </PrimaryButton>
        </div>
      }
    >
      <p className="-mt-3 px-1 text-[12px] leading-relaxed text-[var(--text-3)]">
        {t('extensions.page.intro')}
      </p>
      {extensions.length === 0 ? (
        <EmptyNote art="extensions" title={t('extensions.page.empty')} hint={t('extensions.page.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-3">
          {extensions.map((ext) => (
            <ExtensionCard key={ext.id} ext={ext} />
          ))}
        </div>
      )}
    </PageLayout>
  )
}
