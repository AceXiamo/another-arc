import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LAYOUT, viewportFrame } from '@shared/layout'
import { presetById, rotated, VIEWPORT_LIMITS, type ViewportSpec } from '@shared/viewport'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'

/**
 * Device emulation in the page card: the device toolbar on top, and around
 * the emulated page a backdrop with a hole exactly where main put the page's
 * view (`viewportFrame`, run here on the same integers). The view sits above
 * the shell, so the hole only shows when the shell is raised over it.
 */
export function DeviceFrame({ tabId, viewport }: { tabId: string; viewport: ViewportSpec }) {
  const area = useRef<HTMLDivElement>(null)
  const hole = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  // Placed outside React on every resize: a ResizeObserver runs before paint,
  // so the hole moves in the frame the window does.
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const place = () => {
      // The area is ContentArea's hole, 1px inside the page bounds main fits into.
      const f = viewportFrame({ width: el.clientWidth + 2, height: el.clientHeight + 2 }, viewport)
      const style = hole.current!.style
      style.left = `${f.x - 1}px`
      style.top = `${f.y - 1}px`
      style.width = `${f.width}px`
      style.height = `${f.height}px`
      setScale(f.scale)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(el)
    return () => observer.disconnect()
  }, [viewport])

  const set = (spec: ViewportSpec | null) => send('viewport.set', tabId, spec)

  /** Drag an edge or the corner: a custom size, in CSS pixels of the page. */
  const resize = (dx: 0 | 1, dy: 0 | 1) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY, width: viewport.width, height: viewport.height, scale }
    const clamp = (n: number) => Math.round(Math.min(VIEWPORT_LIMITS.max, Math.max(VIEWPORT_LIMITS.min, n)))
    let next = viewport
    let frame = 0
    const move = (ev: PointerEvent) => {
      // The device is centered: an edge moves half as far as the size changes.
      const width = dx ? clamp(start.width + ((ev.clientX - start.x) * 2) / start.scale) : start.width
      const height = dy ? clamp(start.height + (ev.clientY - start.y) / start.scale) : start.height
      next = { ...viewport, width, height, preset: null }
      frame ||= requestAnimationFrame(() => {
        frame = 0
        set(next)
      })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      if (frame) cancelAnimationFrame(frame)
      if (next !== viewport) set(next)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  return (
    <div ref={area} data-device-frame className="absolute inset-0 overflow-hidden">
      <div
        ref={hole}
        data-device-hole
        className="absolute"
        style={{
          boxShadow: '0 0 0 0.5px var(--popover-line), 0 6px 28px rgb(0 0 0 / 0.14), 0 0 0 100vmax var(--surface-2)'
        }}
      >
        <div onPointerDown={resize(1, 0)} className="no-drag absolute -right-[14px] top-0 h-full w-[14px] cursor-ew-resize" />
        <div onPointerDown={resize(0, 1)} className="no-drag absolute -bottom-[14px] left-0 h-[14px] w-full cursor-ns-resize" />
        <div onPointerDown={resize(1, 1)} className="no-drag absolute -bottom-[14px] -right-[14px] h-[14px] w-[14px] cursor-nwse-resize" />
      </div>
      <DeviceToolbar tabId={tabId} viewport={viewport} scale={scale} set={set} />
    </div>
  )
}

function DeviceToolbar({
  tabId,
  viewport,
  scale,
  set
}: {
  tabId: string
  viewport: ViewportSpec
  scale: number
  set(spec: ViewportSpec | null): void
}) {
  const t = useT()
  const preset = presetById(viewport.preset)
  const menu = (which: 'device' | 'options') => (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    send('viewport.menu', tabId, which, { x: r.left, y: r.bottom + 4 })
  }
  const options = [
    viewport.deviceScaleFactor ? `DPR ${viewport.deviceScaleFactor}` : t('device.dprDefault'),
    viewport.mobile ? t('device.mobile') : t('device.desktop')
  ].join(' · ')

  return (
    <div
      data-device-toolbar
      className="absolute inset-x-0 top-0 flex items-center gap-1.5 border-b border-[var(--line)] bg-[var(--surface)] px-2 text-[12px] text-[var(--text-1)]"
      style={{ height: LAYOUT.deviceBar - 1 }}
    >
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5">
        <button type="button" onClick={menu('device')} className={`${BUTTON} min-w-0 max-w-[220px] gap-1.5 px-2`} title={t('device.pick')}>
          <Icon name="device" size={14} className="text-[var(--ink)]" />
          <span className="truncate font-medium">{preset?.name ?? t('device.responsive')}</span>
          <Icon name="chevron" size={12} className="text-[var(--ink)]" />
        </button>
        <SizeInput label={t('device.width')} value={viewport.width} onCommit={(width) => set({ ...viewport, width, preset: null })} />
        <span className="text-[var(--text-3)]">×</span>
        <SizeInput label={t('device.height')} value={viewport.height} onCommit={(height) => set({ ...viewport, height, preset: null })} />
        <button type="button" onClick={() => set(rotated(viewport))} className={`${BUTTON} w-[26px] justify-center`} title={t('device.rotate')}>
          <Icon name="rotate" size={15} className="text-[var(--ink)]" />
        </button>
        <span className="w-[38px] text-center tabular-nums text-[var(--text-3)]" title={t('device.scale')}>
          {Math.round(scale * 100)}%
        </span>
        <button type="button" onClick={menu('options')} className={`${BUTTON} gap-1 px-2`} title={t('device.options')}>
          <span className="whitespace-nowrap">{options}</span>
          <Icon name="chevron" size={12} className="text-[var(--ink)]" />
        </button>
      </div>
      <button type="button" onClick={() => set(null)} className={`${BUTTON} w-[26px] justify-center`} title={t('device.close')}>
        <Icon name="close" size={14} className="text-[var(--ink)]" />
      </button>
    </div>
  )
}

const BUTTON = 'no-drag flex h-[26px] shrink-0 items-center rounded-[7px] hover:bg-[var(--hover)] active:bg-[var(--press)]'

/** A size field: Enter or leaving it applies, Escape reverts, ↑ / ↓ step by 1 (⇧ by 10). */
function SizeInput({ label, value, onCommit }: { label: string; value: number; onCommit(n: number): void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = (raw: string) => {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n !== value) onCommit(Math.min(VIEWPORT_LIMITS.max, Math.max(VIEWPORT_LIMITS.min, n)))
    else setText(String(value))
  }
  return (
    <input
      aria-label={label}
      title={label}
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit(text)
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          setText(String(value))
          e.currentTarget.blur()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
          commit(String(value + step))
        }
      }}
      className="no-drag h-[24px] w-[52px] rounded-[6px] bg-[var(--surface-2)] text-center text-[12px] tabular-nums text-[var(--text)] outline-none focus:shadow-[0_0_0_2px_var(--focus)]"
    />
  )
}
