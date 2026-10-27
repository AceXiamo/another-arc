import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'

const RING = { size: 26, stroke: 2 }
const R = (RING.size - RING.stroke) / 2
const CIRCUMFERENCE = 2 * Math.PI * R

/** Overall progress of what is downloading: 0…1, null when a size is unknown, undefined when idle. */
function useProgress(): {
  active: number
  fraction: number | null | undefined
} {
  return useBrowser(
    useShallow((s) => {
      let active = 0
      let received = 0
      let total = 0
      let unknown = false
      for (const d of Object.values(s.downloads)) {
        if (d.status !== 'progressing') continue
        active++
        received += d.receivedBytes
        if (d.totalBytes > 0) total += d.totalBytes
        else unknown = true
      }
      // Rounded so the selector only changes (and re-renders) every percent.
      const fraction = active === 0 ? undefined : unknown || total === 0 ? null : Math.round((received / total) * 100) / 100
      return { active, fraction }
    })
  )
}

/**
 * The downloads button in the space bar: there once anything was
 * downloaded, with a progress ring while something is. Downloads that start
 * fly into it (DownloadFlights); it gives a little bounce when they land.
 */
export function DownloadsButton() {
  const t = useT()
  const hasAny = useBrowser((s) => Object.keys(s.downloads).length > 0)
  const { active, fraction } = useProgress()
  const landed = useUi((s) => s.downloadLanded)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (landed === 0 || !ref.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    ref.current.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.22)', offset: 0.35 },
        { transform: 'scale(0.95)', offset: 0.7 },
        { transform: 'scale(1)' }
      ],
      { duration: 420, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    )
  }, [landed])

  if (!hasAny && landed === 0) return null
  return (
    <button
      ref={ref}
      data-downloads-button
      title={t('sidebar.spaceBar.downloads')}
      onClick={() => send('tabs.openInternal', 'downloads')}
      className="anim-pop relative grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--ink)] transition-[background-color,color] duration-150 hover:bg-[var(--sb-hover)] hover:text-[var(--ink-strong)] active:bg-[var(--sb-press)]"
    >
      <Icon name="download" size={active > 0 ? 13 : 16} strokeWidth={active > 0 ? 2 : 1.7} />
      {fraction !== undefined && (
        <svg
          width={RING.size}
          height={RING.size}
          viewBox={`0 0 ${RING.size} ${RING.size}`}
          className={`pointer-events-none absolute left-[1px] top-[1px] ${fraction === null ? 'animate-spin motion-reduce:animate-none' : ''}`}
          aria-hidden
        >
          <g transform={`rotate(-90 ${RING.size / 2} ${RING.size / 2})`}>
            <circle
              cx={RING.size / 2}
              cy={RING.size / 2}
              r={R}
              fill="none"
              strokeWidth={RING.stroke}
              stroke="color-mix(in oklch, var(--text) 14%, transparent)"
            />
            <circle
              cx={RING.size / 2}
              cy={RING.size / 2}
              r={R}
              fill="none"
              strokeWidth={RING.stroke}
              strokeLinecap="round"
              stroke="var(--accent-fill)"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - (fraction ?? 0.25))}
              className="transition-[stroke-dashoffset] duration-300 ease-out"
            />
          </g>
        </svg>
      )}
      {active > 1 && (
        <span className="absolute -right-1 -top-1 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-[var(--accent-fill)] px-[3px] text-[9px] font-semibold leading-none text-white tabular-nums">
          {active}
        </span>
      )}
    </button>
  )
}
