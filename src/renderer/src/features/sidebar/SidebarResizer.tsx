import { clampSidebarWidth } from '@shared/layout'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { setSidebarWidthVar } from '../../lib/theme'
import { useBrowser } from '../../stores/browser'

/**
 * Drag handle on the sidebar's right edge. The CSS variable updates on every
 * pointer move; main (which moves the page view) is updated once per frame.
 */
export function SidebarResizer() {
  const t = useT()
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startWidth = useBrowser.getState().window.sidebarWidth
    let width = startWidth
    let frame = 0
    const flush = () => {
      frame = 0
      send('window.setSidebar', { width })
    }
    const move = (ev: PointerEvent) => {
      width = clampSidebarWidth(startWidth + ev.clientX - startX)
      setSidebarWidthVar(width)
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
      onPointerDown={onPointerDown}
      onDoubleClick={() => send('window.setSidebar', { width: 260 })}
      className="no-drag absolute bottom-0 right-0 top-0 z-10 w-[5px] cursor-col-resize"
      title={t('sidebar.resizer.hint')}
    />
  )
}
