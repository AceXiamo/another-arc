import { clampDevtoolsSize, devtoolsExtent, LAYOUT, type DockSide } from '@shared/layout'
import type { Insets } from '../../lib/card-layout'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { setDevtoolsSizeVar } from '../../lib/theme'
import { useBrowser } from '../../stores/browser'

/**
 * The gutter between the page and docked DevTools: drag to resize (the CSS
 * variable follows every pointer move, main once per frame), double-click
 * for the default size, right-click for where DevTools dock.
 */
export function DevToolsSplitter({ side, insets, tabId }: { side: DockSide; insets: Insets; tabId: string }) {
  const t = useT()
  const across = side !== 'bottom'
  const axis = across ? 'width' : 'height'

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const w = useBrowser.getState().window
    const cardLength = across
      ? window.innerWidth - (w.sidebarCollapsed ? LAYOUT.gutter : w.sidebarWidth) - LAYOUT.gutter
      : window.innerHeight - LAYOUT.gutter * 2
    // Start from what shows, which can be less than the stored size.
    const startSize = devtoolsExtent(cardLength, across ? w.devtoolsWidth : w.devtoolsHeight)
    const start = across ? e.clientX : e.clientY
    let size = startSize
    let frame = 0
    const flush = () => {
      frame = 0
      send('devtools.setLayout', { [axis]: size })
    }
    const move = (ev: PointerEvent) => {
      const delta = Math.round((across ? ev.clientX : ev.clientY) - start)
      size = devtoolsExtent(cardLength, clampDevtoolsSize(side === 'left' ? startSize + delta : startSize - delta, startSize))
      setDevtoolsSizeVar(axis, size)
      frame ||= requestAnimationFrame(flush)
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      if (frame) cancelAnimationFrame(frame)
      flush()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  return (
    <div
      data-devtools-splitter={side}
      onPointerDown={onPointerDown}
      onDoubleClick={() => send('devtools.setLayout', { [axis]: across ? LAYOUT.devtoolsWidth : LAYOUT.devtoolsHeight })}
      onContextMenu={(e) => {
        e.preventDefault()
        send('devtools.menu', tabId, { x: e.clientX, y: e.clientY })
      }}
      className="group no-drag absolute z-10 flex items-center justify-center"
      style={{ ...insets, cursor: across ? 'col-resize' : 'row-resize' }}
      title={t('devtools.splitter.hint')}
    >
      <div
        className="rounded-full bg-[var(--ink-faint)] opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        style={across ? { width: 3, height: 32 } : { width: 32, height: 3 }}
      />
    </div>
  )
}
