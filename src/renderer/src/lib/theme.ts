import { DEFAULT_SPACE_THEME, grainOpacity } from '@shared/theme'
import type { SpaceTheme } from '@shared/types'
import { useBrowser } from '../stores/browser'

const media = window.matchMedia('(prefers-color-scheme: dark)')

/** What the chrome is painted with: a space's color and theme. */
export interface ChromeLook {
  color: string
  theme: SpaceTheme
}

let preview: ChromeLook | null = null
let applyTheme: (() => void) | null = null

/**
 * Theme and layout variables live on <html> and are updated outside React:
 * switching spaces or resizing the sidebar never re-renders components, and
 * a space's theme is nothing but CSS variables (see styles.css).
 */
export function startTheme(): void {
  const root = document.documentElement
  const written = new Map<string, string>()
  const setVar = (name: string, value: string) => {
    if (written.get(name) === value) return
    written.set(name, value)
    root.style.setProperty(name, value)
  }
  const setAttr = (name: 'theme' | 'grain', value: string) => {
    if (root.dataset[name] !== value) root.dataset[name] = value
  }
  const apply = () => {
    const s = useBrowser.getState()
    const space = s.spaces[s.window.activeSpaceId]
    const look = preview ?? (space ? { color: space.color, theme: space.theme ?? DEFAULT_SPACE_THEME } : null)
    const appearance = look?.theme.appearance ?? 'system'
    const globalDark = s.settings.theme === 'dark' || (s.settings.theme === 'system' && media.matches)
    setAttr('theme', (appearance === 'system' ? globalDark : appearance === 'dark') ? 'dark' : 'light')
    if (root.lang !== s.settings.language) root.lang = s.settings.language
    if (look) applyLook(look, setVar, setAttr)
    // Not cached: the resizer writes it directly while dragging.
    root.style.setProperty('--sidebar-width', `${s.window.sidebarWidth}px`)
  }
  applyTheme = apply
  apply()
  media.addEventListener('change', apply)
  useBrowser.subscribe((s, prev) => {
    if (
      s.window.activeSpaceId !== prev.window.activeSpaceId ||
      s.window.sidebarWidth !== prev.window.sidebarWidth ||
      s.settings.theme !== prev.settings.theme ||
      s.settings.language !== prev.settings.language ||
      s.spaces[s.window.activeSpaceId] !== prev.spaces[prev.window.activeSpaceId]
    ) {
      apply()
    }
  })
}

function applyLook(
  { color, theme }: ChromeLook,
  setVar: (name: string, value: string) => void,
  setAttr: (name: 'grain', value: string) => void
): void {
  const [second, third] = theme.gradient
  setVar('--space', color)
  setVar('--space-2', second ?? color)
  setVar('--space-3', third ?? second ?? color)
  setVar('--intensity', String(theme.intensity / 100))
  setVar('--theme-angle', `${theme.angle}deg`)
  // The gradient string only references variables, so it changes with the
  // number of colors, not with the colors themselves.
  setVar(
    '--chrome-image',
    third
      ? 'linear-gradient(in oklab var(--theme-angle), var(--chrome-0), var(--chrome-1), var(--chrome-2))'
      : second
        ? 'linear-gradient(in oklab var(--theme-angle), var(--chrome-0), var(--chrome-1))'
        : 'none'
  )
  const opacity = grainOpacity(theme.noise)
  if (opacity > 0) ensureGrainTile()
  setVar('--grain-opacity', String(opacity))
  setAttr('grain', opacity > 0 ? 'on' : 'off')
}

/**
 * Paint the chrome with a theme that is not saved yet (the theme editor's
 * live preview); null goes back to the active space's own theme.
 */
export function previewChrome(look: ChromeLook | null): void {
  preview = look
  applyTheme?.()
}

/** CSS px of one grain tile; drawn at the display's pixel density. */
const GRAIN_TILE = 128

let grainTile = false

/**
 * The grain tile is drawn once, off the startup path: drawing and encoding
 * it takes ~5 ms, and the first frame must not wait for it (the window is
 * shown on first paint). Until it lands the grain layer simply paints nothing.
 */
function ensureGrainTile(): void {
  if (grainTile) return
  grainTile = true
  requestIdleCallback(drawGrainTile, { timeout: 400 })
}

/**
 * Deterministic, roughly Gaussian luminance noise as black or white specks
 * with varying alpha, so it reads as film grain over light and dark chrome
 * alike. It is injected as a style rule rather than a variable on <html>,
 * which surfaces mirror on every change.
 */
function drawGrainTile(): void {
  const scale = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)))
  const size = GRAIN_TILE * scale
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const image = ctx.createImageData(size, size)
  const data = image.data
  let seed = 0x2f6b4d1c
  const random = () => {
    // xorshift32: same tile on every launch, so screenshots are stable.
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }
  for (let i = 0; i < data.length; i += 4) {
    const n = (random() + random() + random()) / 1.5 - 1 // −1…1, peaked at 0
    const v = n > 0 ? 255 : 0
    data[i] = v
    data[i + 1] = v
    data[i + 2] = v
    data[i + 3] = Math.min(255, Math.round(Math.abs(n) * 290))
  }
  ctx.putImageData(image, 0, 0)
  const style = document.createElement('style')
  style.dataset.grain = ''
  style.textContent = `.chrome-grain,.chrome-surface::before{background-image:url(${canvas.toDataURL('image/png')});--grain-size:${GRAIN_TILE}px}`
  document.head.appendChild(style)
}

/** Live sidebar width while dragging the resizer (main is told separately). */
export function setSidebarWidthVar(width: number): void {
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
}

/** Copy theme state onto another document (floating surfaces). */
export function mirrorTheme(target: Document): () => void {
  const sync = () => {
    target.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'light'
    target.documentElement.style.cssText = document.documentElement.style.cssText
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
  return () => observer.disconnect()
}
