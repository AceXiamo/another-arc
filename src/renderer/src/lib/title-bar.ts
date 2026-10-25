import { send } from './rpc'

/** Elements inside a title-bar area that keep their own clicks. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], .no-drag'

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) !== null
}

/**
 * Title-bar behaviour for shell areas that are also marked `.drag`: press and
 * drag moves the window, double-click runs the system action. Main moves the
 * window between the two `window.drag` messages (BrowserWindowController.beginDrag),
 * so it keeps following the cursor even when the page stops seeing moves.
 */
export const titleBar = {
  onPointerDown(e: React.PointerEvent<HTMLElement>): void {
    if (e.button !== 0 || isInteractive(e.target)) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    send('window.drag', 'start')
    let done = false
    const end = () => {
      if (done) return
      done = true
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      el.removeEventListener('lostpointercapture', end)
      window.removeEventListener('blur', end)
      send('window.drag', 'end')
    }
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('lostpointercapture', end)
    window.addEventListener('blur', end)
  },
  onDoubleClick(e: React.MouseEvent<HTMLElement>): void {
    if (!isInteractive(e.target)) send('window.titleBarDoubleClick')
  }
}
