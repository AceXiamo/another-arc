import type { WebContents } from 'electron'

/** A window whose content area should follow its popup page's size. */
export interface FitTarget {
  readonly webContents: WebContents
  alive(): boolean
  /** Size of the page's viewport (the window's content area). */
  setContentSize(width: number, height: number): void
  /** The first fit is done; the window can be placed and shown. */
  fitted(): void
  /** The user resized the window by hand: stop following the page. */
  userSized(): boolean
}

/** Chrome's popup limits. */
export const POPUP_MIN = 25
export const POPUP_MAX = { width: 800, height: 600 }
/** Used when a popup cannot be measured. */
export const POPUP_FALLBACK = { width: 360, height: 480 }
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

const clampWidth = (w: number) => Math.floor(Math.min(POPUP_MAX.width, Math.max(POPUP_MIN, w || 0)))
const clampHeight = (h: number) => Math.floor(Math.min(POPUP_MAX.height, Math.max(POPUP_MIN, h || 0)))

/**
 * Electron 44 never emits `preferred-size-changed`, so size popups the way
 * Chrome does instead: the narrowest width the content fits in without
 * horizontal overflow, and the content height at that width. The first fit
 * runs while the window is still hidden; afterwards (and after each
 * navigation inside the popup) the window only grows to follow late
 * rendering, so it never visibly collapses.
 */
export function fitPopup(target: FitTarget): void {
  const wc = target.webContents
  const alive = () => target.alive() && !wc.isDestroyed()
  const measure = async () =>
    (await wc.executeJavaScript(MEASURE, false)) as { width: number; height: number; cw: number; ch: number }
  let current: { width: number; height: number } | null = null
  /** Bumped on every load so an older follow-up loop stops. */
  let generation = 0

  const setSize = (width: number, height: number) => {
    current = { width: clampWidth(width), height: clampHeight(height) }
    target.setContentSize(current.width, current.height)
  }

  const firstFit = async () => {
    if (!alive()) return
    // At 25px the document overflows to its natural (min-content) width…
    target.setContentSize(POPUP_MIN, POPUP_MIN)
    let { width } = await measure()
    if (!alive()) return
    if (width < FLUID_THRESHOLD) {
      const natural = (await wc.executeJavaScript(MAX_CONTENT_WIDTH, false)) as number
      width = Math.max(width, Math.min(FLUID_MAX_WIDTH, natural))
      if (!alive()) return
    }
    // …and with a 25px-high viewport scrollHeight is the content height.
    target.setContentSize(clampWidth(width), POPUP_MIN)
    const { height } = await measure()
    if (!alive()) return
    setSize(width, height)
  }

  const followUp = async (gen: number) => {
    for (const delay of FOLLOW_UP_MS) {
      await new Promise((r) => setTimeout(r, delay))
      if (!alive() || gen !== generation || target.userSized() || !current) return
      const m = await measure().catch(() => null)
      if (!m || gen !== generation || !alive() || target.userSized()) return
      const width = m.width > m.cw ? clampWidth(m.width) : current.width
      const height = m.height > m.ch ? clampHeight(m.height) : current.height
      if (width !== current.width || height !== current.height) setSize(width, height)
    }
  }

  let first = true
  const onLoad = () => {
    const gen = ++generation
    if (first) {
      first = false
      void firstFit()
        .catch(() => undefined)
        .finally(() => {
          if (!alive()) return
          // Could not measure (the page threw, or crashed): still show something usable.
          if (!current) setSize(POPUP_FALLBACK.width, POPUP_FALLBACK.height)
          target.fitted()
        })
        .then(() => followUp(gen))
        .catch(() => undefined)
    } else if (!target.userSized()) {
      void followUp(gen).catch(() => undefined)
    }
  }
  wc.on('did-finish-load', onLoad)
}
