import type { Translate } from '@shared/i18n'
import { fileKind } from '@shared/file-kind'
import type { DownloadState } from '@shared/types'
import { displayHost } from '@shared/url'
import { Icon } from '../../components/Icon'
import { FileIcon } from '../../components/Illustration'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { EmptyNote, PageLayout, SmallButton } from './PageLayout'

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function status(d: DownloadState, t: Translate): string {
  switch (d.status) {
    case 'completed':
      return formatBytes(d.totalBytes || d.receivedBytes)
    case 'cancelled':
      return t('downloads.status.cancelled')
    case 'interrupted':
      return t('downloads.status.interrupted')
    default:
      return d.paused
        ? t('downloads.status.paused', { size: formatBytes(d.receivedBytes) })
        : `${formatBytes(d.receivedBytes)}${d.totalBytes ? ` / ${formatBytes(d.totalBytes)}` : ''}`
  }
}

function DownloadRow({ d }: { d: DownloadState }) {
  const t = useT()
  const locale = useLocale()
  const progress = d.totalBytes > 0 ? Math.min(1, d.receivedBytes / d.totalBytes) : 0
  const active = d.status === 'progressing'
  const done = d.status === 'completed'
  const failed = d.status === 'cancelled' || d.status === 'interrupted'
  const source = d.url && !d.url.startsWith('data:') && !d.url.startsWith('blob:') ? displayHost(d.url, locale) : ''
  return (
    <div className="group flex items-center gap-3 rounded-[12px] bg-[var(--surface-2)] py-2.5 pl-3 pr-2 shadow-[var(--card-shadow)]">
      <FileIcon kind={fileKind(d.filename, d.mimeType)} className={failed ? 'opacity-45 saturate-0' : ''} />
      <div className="min-w-0 flex-1">
        <button
          className={`block max-w-full truncate rounded-[4px] text-left ${
            done ? 'hover:underline hover:decoration-[var(--ink-faint)] hover:underline-offset-2' : ''
          } ${failed ? 'text-[var(--text-3)] line-through decoration-[var(--ink-faint)]' : ''}`}
          title={d.filename}
          onClick={() => done && send('downloads.open', d.id)}
        >
          {d.filename}
        </button>
        <div className="mt-0.5 flex min-w-0 gap-1.5 text-[12px] tabular-nums text-[var(--text-3)]">
          <span className="shrink-0">{status(d, t)}</span>
          {source && (
            <>
              <span aria-hidden className="shrink-0">·</span>
              <span className="min-w-0 truncate" title={d.url}>
                {source}
              </span>
            </>
          )}
        </div>
        {active && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--press)]">
            <div
              className={`h-full w-full origin-left transition-transform duration-300 ease-out ${
                d.paused ? 'bg-[var(--ink-faint)]' : 'bg-[var(--accent-fill)]'
              }`}
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {active && !d.paused && <SmallButton onClick={() => send('downloads.pause', d.id)}>{t('downloads.pause')}</SmallButton>}
        {active && d.paused && <SmallButton onClick={() => send('downloads.resume', d.id)}>{t('downloads.resume')}</SmallButton>}
        {active && (
          <SmallButton danger onClick={() => send('downloads.cancel', d.id)}>
            {t('common.cancel')}
          </SmallButton>
        )}
        {done && <SmallButton onClick={() => send('downloads.reveal', d.id)}>{t('downloads.showInFinder')}</SmallButton>}
        {!active && (
          <button
            title={t('downloads.remove')}
            onClick={() => send('downloads.remove', d.id)}
            className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--ink)] transition-[scale,background-color] duration-150 ease-out hover:bg-[var(--hover)] hover:text-[var(--ink-strong)] active:scale-[0.96] active:bg-[var(--press)]"
          >
            <Icon name="close" size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  )
}

export default function DownloadsPage() {
  const t = useT()
  const downloads = useBrowser((s) => s.downloads)
  const list = Object.values(downloads).sort((a, b) => b.startedAt - a.startedAt)
  return (
    <PageLayout
      title={t('page.downloads')}
      actions={list.some((d) => d.status !== 'progressing') && <SmallButton onClick={() => send('downloads.clear')}>{t('downloads.clearCompleted')}</SmallButton>}
    >
      {list.length === 0 ? (
        <EmptyNote art="downloads" title={t('downloads.empty')} hint={t('downloads.emptyHint')} />
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((d) => (
            <DownloadRow key={d.id} d={d} />
          ))}
        </div>
      )}
    </PageLayout>
  )
}
