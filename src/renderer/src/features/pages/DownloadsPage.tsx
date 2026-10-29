import { useEffect, useRef, useState } from 'react'
import type { Locale, Translate } from '@shared/i18n'
import { fileKind, type FileKind } from '@shared/file-kind'
import type { DownloadState } from '@shared/types'
import { displayHost } from '@shared/url'
import { Icon, type IconName } from '../../components/Icon'
import { FileTile, Illustration } from '../../components/Illustration'
import { formatBytes } from '../../lib/format'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { PageLayout, SmallButton } from './PageLayout'

const DAY = 86_400_000

/** Kinds QuickLook draws a real thumbnail for. */
const PREVIEWABLE: ReadonlySet<FileKind> = new Set(['image', 'video', 'pdf'])

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

const files = (count: number, t: Translate) => t(count === 1 ? 'downloads.files.one' : 'downloads.files.other', { count })

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

/**
 * The file type tile; a finished image, video or PDF fades its QuickLook
 * thumbnail in over it, and keeps the tile if there is none (file moved).
 */
function Preview({ d, kind, dim }: { d: DownloadState; kind: FileKind; dim: boolean }) {
  const [thumb, setThumb] = useState<'loading' | 'shown' | 'none'>('loading')
  const wanted = d.status === 'completed' && PREVIEWABLE.has(kind) && thumb !== 'none'
  const shown = wanted && thumb === 'shown'
  return (
    <FileTile kind={kind} covered={shown} className={dim ? 'opacity-45 saturate-0' : ''}>
      {wanted && (
        <img
          src={`thumb://download/${encodeURIComponent(d.id)}?v=${d.endedAt ?? 0}`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setThumb('shown')}
          onError={() => setThumb('none')}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ease-out ${shown ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {shown && kind === 'video' && (
        <span className="absolute bottom-1 left-1 grid h-4 w-4 place-items-center rounded-full bg-[rgb(0_0_0/0.45)] text-white backdrop-blur-sm">
          <Icon name="play" size={8} strokeWidth={2.4} />
        </span>
      )}
    </FileTile>
  )
}

/** The name, cut in the middle when too long so the extension stays in view. */
function FileName({ name }: { name: string }) {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 10 ? name.length - dot : 0
  const tail = Math.min(name.length, ext + 6)
  if (name.length - tail < 8) return <span className="min-w-0 truncate whitespace-pre">{name}</span>
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate whitespace-pre">{name.slice(0, -tail)}</span>
      <span className="shrink-0 whitespace-pre">{name.slice(-tail)}</span>
    </span>
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
  const kind = fileKind(d.filename, d.mimeType)
  const source = d.url && !d.url.startsWith('data:') && !d.url.startsWith('blob:') ? displayHost(d.url, locale) : ''
  const when = new Date(d.endedAt ?? d.startedAt).toLocaleString(
    locale,
    showDate ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' }
  )
  const parts = [...meta(d, speed, t, locale), ...(source ? [source] : []), ...(active ? [] : [when])]
  const open = () => done && send('downloads.open', d.id)
  return (
    <div
      draggable={done}
      title={done ? t('downloads.dragHint') : undefined}
      onDragStart={(e) => {
        // A native drag of the file itself (see downloads.drag).
        e.preventDefault()
        send('downloads.drag', d.id)
      }}
      className="group flex items-center gap-3 py-2.5 pl-2.5 pr-2 transition-colors duration-150 first:rounded-t-[14px] last:rounded-b-[14px] hover:bg-[var(--hover)]"
    >
      <button tabIndex={-1} onClick={open} className={`shrink-0 rounded-[10px] ${done ? '' : 'cursor-default'}`}>
        <Preview d={d} kind={kind} dim={failed} />
      </button>
      <div className="min-w-0 flex-1">
        <button
          className={`flex max-w-full rounded-[4px] text-left text-[13px] font-medium text-[var(--text-1)] ${
            done ? 'hover:underline hover:decoration-[var(--ink-faint)] hover:underline-offset-2' : 'cursor-default'
          } ${failed ? 'text-[var(--text-3)] line-through decoration-[var(--ink-faint)]' : ''}`}
          title={d.filename}
          onClick={open}
        >
          <FileName name={d.filename} />
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
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--press)]">
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
        {done && <RowButton quiet icon="folder" label={t('downloads.showInFinder')} onClick={() => send('downloads.reveal', d.id)} />}
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

/** Title banner: what is in the list, the folder, and the spot art in the space's color. */
function Banner({ list }: { list: DownloadState[] }) {
  const t = useT()
  const finished = list.filter((d) => d.status === 'completed')
  const active = list.filter((d) => d.status === 'progressing').length
  const bytes = finished.reduce((sum, d) => sum + (d.totalBytes || d.receivedBytes), 0)
  const summary =
    list.length === 0
      ? [t('downloads.emptyHint')]
      : [files(finished.length, t), ...(bytes > 0 ? [formatBytes(bytes)] : []), ...(active ? [t('downloads.active', { count: active })] : [])]
  return (
    <header
      className="@container relative isolate flex items-center overflow-hidden rounded-[16px] shadow-[var(--card-shadow)]"
      style={{
        background:
          'radial-gradient(70% 120% at 92% 50%, color-mix(in oklch, var(--space) 16%, transparent), transparent 72%), linear-gradient(100deg, var(--surface-2) 30%, color-mix(in oklch, var(--space) 7%, var(--surface-2)))'
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-5 py-6 pl-6 pr-4">
        <div className="min-w-0">
          <h1 className="truncate text-[24px] font-semibold leading-tight tracking-[-0.01em]">{t('page.downloads')}</h1>
          <p className="mt-1 flex flex-wrap gap-x-1.5 text-[12.5px] tabular-nums text-[var(--text-2)]">
            {summary.map((s, i) => (
              <span key={i} className="flex gap-1.5">
                {i > 0 && <span aria-hidden className="text-[var(--text-3)]">·</span>}
                {s}
              </span>
            ))}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => send('downloads.openFolder')}
            className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] bg-[var(--sb-active)] px-3 text-[12.5px] font-medium text-[var(--text)] shadow-[var(--active-shadow)] transition-[scale,filter] duration-150 ease-out hover:brightness-[1.03] active:scale-[0.96]"
          >
            <Icon name="folder" size={14} strokeWidth={1.8} />
            {t('downloads.openFolder')}
          </button>
          {list.some((d) => d.status !== 'progressing') && (
            <SmallButton onClick={() => send('downloads.clear')}>{t('downloads.clearCompleted')}</SmallButton>
          )}
        </div>
      </div>
      <Illustration name="downloads-hero" className="mr-9 @max-[420px]:hidden" />
    </header>
  )
}

export default function DownloadsPage() {
  const t = useT()
  const downloads = useBrowser((s) => s.downloads)
  const list = Object.values(downloads).sort((a, b) => b.startedAt - a.startedAt)
  return (
    <PageLayout title={t('page.downloads')} header={<Banner list={list} />}>
      {groups(list).map(({ key, items }) => (
        <section key={key} className="flex flex-col gap-2">
          <h2 className="flex gap-1.5 px-1 text-[12px] font-semibold text-[var(--text-2)]">
            {t(`downloads.${key}`)}
            <span className="font-normal tabular-nums text-[var(--text-3)]">{items.length}</span>
          </h2>
          <div className="flex flex-col rounded-[14px] bg-[var(--surface-2)] shadow-[var(--card-shadow)] [&>*+*]:shadow-[inset_0_0.5px_0_var(--line)]">
            {items.map((d) => (
              <DownloadRow key={d.id} d={d} showDate={key === 'earlier'} />
            ))}
          </div>
        </section>
      ))}
    </PageLayout>
  )
}
