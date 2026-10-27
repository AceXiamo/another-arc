import { useEffect, useRef, useState } from 'react'
import type { Locale, Translate } from '@shared/i18n'
import { fileKind } from '@shared/file-kind'
import type { DownloadState } from '@shared/types'
import { displayHost } from '@shared/url'
import { Icon, type IconName } from '../../components/Icon'
import { FileIcon } from '../../components/Illustration'
import { formatBytes } from '../../lib/format'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { EmptyNote, PageLayout, SecondaryButton, SmallButton } from './PageLayout'

const DAY = 86_400_000

/** Bytes per second, smoothed over the progress updates (one every 250 ms). */
function useSpeed(d: DownloadState): number | null {
  const last = useRef<{ bytes: number; at: number; speed: number | null } | null>(null)
  const [speed, setSpeed] = useState<number | null>(null)
  const active = d.status === 'progressing' && !d.paused
  useEffect(() => {
    if (!active) {
      last.current = null
      setSpeed(null)
      return
    }
    const now = performance.now()
    const prev = last.current
    if (prev && now - prev.at > 100 && d.receivedBytes >= prev.bytes) {
      const sample = ((d.receivedBytes - prev.bytes) * 1000) / (now - prev.at)
      const smoothed = prev.speed === null ? sample : prev.speed * 0.7 + sample * 0.3
      last.current = { bytes: d.receivedBytes, at: now, speed: smoothed }
      setSpeed(smoothed)
    } else if (!prev) {
      last.current = { bytes: d.receivedBytes, at: now, speed: null }
    }
  }, [active, d.receivedBytes])
  return speed
}

function duration(seconds: number, locale: Locale): string {
  const [value, unit] =
    seconds < 60
      ? [Math.max(1, Math.round(seconds)), 'second']
      : seconds < 3600
        ? [Math.round(seconds / 60), 'minute']
        : [Math.round(seconds / 360) / 10, 'hour']
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value)
}

function meta(d: DownloadState, speed: number | null, t: Translate, locale: Locale): string[] {
  switch (d.status) {
    case 'completed':
      return [formatBytes(d.totalBytes || d.receivedBytes)]
    case 'cancelled':
      return [t('downloads.status.cancelled')]
    case 'interrupted':
      return [t('downloads.status.interrupted')]
  }
  if (d.paused) return [t('downloads.status.paused', { size: formatBytes(d.receivedBytes) })]
  const parts = [`${formatBytes(d.receivedBytes)}${d.totalBytes ? ` / ${formatBytes(d.totalBytes)}` : ''}`]
  if (speed && speed > 0) {
    parts.push(`${formatBytes(speed)}/s`)
    if (d.totalBytes > d.receivedBytes)
      parts.push(t('downloads.left', { time: duration((d.totalBytes - d.receivedBytes) / speed, locale) }))
  }
  return parts
}

function RowButton({ icon, label, onClick, quiet }: { icon: IconName; label: string; onClick: () => void; quiet?: boolean }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--ink)] transition-[opacity,scale,background-color,color] duration-150 ease-out hover:bg-[var(--hover)] hover:text-[var(--ink-strong)] focus-visible:opacity-100 active:scale-[0.96] active:bg-[var(--press)] ${
        quiet ? 'opacity-0 group-hover:opacity-100' : ''
      }`}
    >
      <Icon name={icon} size={14} strokeWidth={1.8} />
    </button>
  )
}

function DownloadRow({ d, showDate }: { d: DownloadState; showDate: boolean }) {
  const t = useT()
  const locale = useLocale()
  const speed = useSpeed(d)
  const progress = d.totalBytes > 0 ? Math.min(1, d.receivedBytes / d.totalBytes) : 0
  const active = d.status === 'progressing'
  const done = d.status === 'completed'
  const failed = d.status === 'cancelled' || d.status === 'interrupted'
  const source = d.url && !d.url.startsWith('data:') && !d.url.startsWith('blob:') ? displayHost(d.url, locale) : ''
  const when = new Date(d.endedAt ?? d.startedAt).toLocaleString(
    locale,
    showDate ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' }
  )
  const parts = [...meta(d, speed, t, locale), ...(source ? [source] : []), ...(active ? [] : [when])]
  return (
    <div
      draggable={done}
      title={done ? t('downloads.dragHint') : undefined}
      onDragStart={(e) => {
        // A native drag of the file itself (see downloads.drag).
        e.preventDefault()
        send('downloads.drag', d.id)
      }}
      className="group flex items-center gap-3 py-2.5 pl-3 pr-2 first:rounded-t-[12px] last:rounded-b-[12px]"
    >
      <FileIcon kind={fileKind(d.filename, d.mimeType)} className={failed ? 'opacity-45 saturate-0' : ''} />
      <div className="min-w-0 flex-1">
        <button
          className={`block max-w-full truncate rounded-[4px] text-left text-[13.5px] ${
            done ? 'hover:underline hover:decoration-[var(--ink-faint)] hover:underline-offset-2' : 'cursor-default'
          } ${failed ? 'text-[var(--text-3)] line-through decoration-[var(--ink-faint)]' : ''}`}
          title={d.filename}
          onClick={() => done && send('downloads.open', d.id)}
        >
          {d.filename}
        </button>
        <div className="mt-0.5 flex min-w-0 gap-1.5 text-[12px] tabular-nums text-[var(--text-3)]">
          {parts.map((p, i) => (
            <span key={i} className={`flex min-w-0 gap-1.5 ${p === source ? 'truncate' : 'shrink-0'}`}>
              {i > 0 && <span aria-hidden>·</span>}
              <span className={p === source ? 'truncate' : ''} title={p === source ? d.url : undefined}>
                {p}
              </span>
            </span>
          ))}
        </div>
        {active && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-[var(--press)]">
            <div
              className={`h-full w-full origin-left transition-transform duration-300 ease-out ${
                d.paused ? 'bg-[var(--ink-faint)]' : d.totalBytes > 0 ? 'bg-[var(--accent-fill)]' : 'bg-[var(--accent-fill)] opacity-60'
              }`}
              style={{ transform: `scaleX(${d.totalBytes > 0 ? progress : 1})` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {active && !d.paused && <RowButton icon="pause" label={t('downloads.pause')} onClick={() => send('downloads.pause', d.id)} />}
        {active && d.paused && <RowButton icon="play" label={t('downloads.resume')} onClick={() => send('downloads.resume', d.id)} />}
        {active && <RowButton icon="close" label={t('common.cancel')} onClick={() => send('downloads.cancel', d.id)} />}
        {done && <RowButton icon="folder" label={t('downloads.showInFinder')} onClick={() => send('downloads.reveal', d.id)} />}
        {failed && /^https?:/.test(d.url) && (
          <SmallButton onClick={() => send('downloads.retry', d.id)}>{t('downloads.retry')}</SmallButton>
        )}
        {!active && <RowButton quiet icon="close" label={t('downloads.remove')} onClick={() => send('downloads.remove', d.id)} />}
      </div>
    </div>
  )
}

/** Today, yesterday, earlier: by when each one started. */
function groups(list: DownloadState[]): Array<{ key: 'today' | 'yesterday' | 'earlier'; items: DownloadState[] }> {
  const midnight = new Date().setHours(0, 0, 0, 0)
  const out = { today: [] as DownloadState[], yesterday: [] as DownloadState[], earlier: [] as DownloadState[] }
  for (const d of list) {
    if (d.startedAt >= midnight || d.status === 'progressing') out.today.push(d)
    else if (d.startedAt >= midnight - DAY) out.yesterday.push(d)
    else out.earlier.push(d)
  }
  return (['today', 'yesterday', 'earlier'] as const).filter((k) => out[k].length > 0).map((key) => ({ key, items: out[key] }))
}

export default function DownloadsPage() {
  const t = useT()
  const downloads = useBrowser((s) => s.downloads)
  const list = Object.values(downloads).sort((a, b) => b.startedAt - a.startedAt)
  return (
    <PageLayout
      title={t('page.downloads')}
      actions={
        <div className="flex items-center gap-1.5">
          {list.some((d) => d.status !== 'progressing') && (
            <SmallButton onClick={() => send('downloads.clear')}>{t('downloads.clearCompleted')}</SmallButton>
          )}
          <SecondaryButton icon="folder" onClick={() => send('downloads.openFolder')}>
            {t('downloads.openFolder')}
          </SecondaryButton>
        </div>
      }
    >
      {list.length === 0 ? (
        <EmptyNote art="downloads" title={t('downloads.empty')} hint={t('downloads.emptyHint')} />
      ) : (
        groups(list).map(({ key, items }) => (
          <section key={key} className="flex flex-col gap-2">
            <h2 className="px-1 text-[12px] font-semibold text-[var(--text-2)]">{t(`downloads.${key}`)}</h2>
            <div className="flex flex-col rounded-[12px] bg-[var(--surface-2)] shadow-[var(--card-shadow)] [&>*+*]:shadow-[inset_0_0.5px_0_var(--line)]">
              {items.map((d) => (
                <DownloadRow key={d.id} d={d} showDate={key === 'earlier'} />
              ))}
            </div>
          </section>
        ))
      )}
    </PageLayout>
  )
}
