import type { BrowserWindow } from 'electron'

/** The parts of electron-chrome-extensions' PopupView we rely on. */
interface PopupViewLike {
  browserWindow?: BrowserWindow
  isDestroyed(): boolean
  setSize(rect: { width?: number; height?: number }): void
  // Private in the library's typings, present at runtime.
  updatePosition?(): void
  show?(): void
}

const MIN = 25
const MAX = { width: 800, height: 600 }
/** Below this the layout is fluid; fall back to its max-content width. */
const FLUID_THRESHOLD = 160
const FLUID_MAX_WIDTH = 400
/** Re-check after async UI (React/Vue popups) has rendered. */
const FOLLOW_UP_MS = [150, 400, 900, 1800, 3500]

const MAX_CONTENT_WIDTH = `(() => {
  const d = document.documentElement
  const prev = d.style.width
  d.style.width = 'max-content'
  const w = Math.ceil(d.getBoundingClientRect().width)
  d.style.width = prev
  return w
})()`

const MEASURE = `(() => {
  const d = document.documentElement
  return { width: d.scrollWidth, height: d.scrollHeight, cw: d.clientWidth, ch: d.clientHeight }
})()`

/**
 * Electron 44 never emits `preferred-size-changed` for extension popups, so
 * the library would leave them hidden at 25×25. Size them the way Chrome
 * does instead: the narrowest width the content fits in without horizontal
 * overflow, and the content height at that width.
 */
export function fitPopup(popup: PopupViewLike): void {
  const win = popup.browserWindow
  if (!win) return
  const wc = win.webContents
  const alive = () => !popup.isDestroyed() && !win.isDestroyed() && !wc.isDestroyed()
  const measure = async () =>
    (await wc.executeJavaScript(MEASURE, false)) as { width: number; height: number; cw: number; ch: number }

  const firstFit = async () => {
    if (!alive()) return
    // At 25px the document overflows to its natural (min-content) width…
    popup.setSize({ width: MIN, height: MIN })
    let { width } = await measure()
    if (!alive()) return
    if (width < FLUID_THRESHOLD) {
      const natural = (await wc.executeJavaScript(MAX_CONTENT_WIDTH, false)) as number
      width = Math.max(width, Math.min(FLUID_MAX_WIDTH, natural))
      if (!alive()) return
    }
    // …and with a 25px-high viewport scrollHeight is the content height.
    popup.setSize({ width, height: MIN })
    const { height } = await measure()
    if (!alive()) return
    popup.setSize({ width, height })
    popup.updatePosition?.()
    popup.show?.()
    let current = { width: Math.min(width, MAX.width), height: Math.min(height, MAX.height) }

    for (const delay of FOLLOW_UP_MS) {
      await new Promise((r) => setTimeout(r, delay))
      if (!alive()) return
      const m = await measure().catch(() => null)
      if (!m) return
      const grow = {
        width: m.width > m.cw ? Math.min(MAX.width, m.width) : current.width,
        height: m.height > m.ch ? Math.min(MAX.height, m.height) : current.height
      }
      if (grow.width !== current.width || grow.height !== current.height) {
        current = grow
        popup.setSize(grow)
        popup.updatePosition?.()
      }
    }
  }

  if (wc.isLoading()) wc.once('did-finish-load', () => void firstFit().catch(() => undefined))
  else void firstFit().catch(() => undefined)
}
