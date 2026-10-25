import { mixOklch, oklchToRgb, parseHex, rgbToOklch, toHex, type Rgb } from './color'
import type { SpaceAppearance, SpaceTheme } from './types'

// Space themes (Arc's "Edit Theme"): data defaults, sanitizing, and the chrome
// color math. styles.css computes the same chrome colors with color-mix();
// `chromeColor` mirrors it for places that cannot run CSS (the native window
// background in main, and the contrast tests).

export const SPACE_APPEARANCES = ['system', 'light', 'dark'] as const satisfies readonly SpaceAppearance[]

export const THEME_LIMITS = {
  /** Gradient colors after the primary one. */
  gradientStops: 2
} as const

/** Never mutate; `sanitizeSpaceTheme(null)` returns a fresh copy. */
export const DEFAULT_SPACE_THEME: Readonly<SpaceTheme> = {
  gradient: [],
  angle: 160,
  intensity: 50,
  noise: 20,
  appearance: 'system'
}

/**
 * Chrome tint per appearance. `base` is --chrome-base in styles.css; the
 * share of the space color at intensity 50 / 100 is `tint`; `minL` / `maxL`
 * keep the chrome light enough for dark text (light) or dark enough for
 * light text (dark) at any intensity. Keep in sync with styles.css.
 */
export const CHROME = {
  light: { base: '#ebebf0', text: '#1c1c21', text2: 0.68, tint: [0.17, 0.8], minL: 0.76 },
  dark: { base: '#19191d', text: '#ececf0', text2: 0.66, tint: [0.15, 0.7], maxL: 0.36 },
  /** Extra opacity of secondary text (--text-2) on the chrome at full ink boost. */
  text2Boost: 0.18
} as const

/**
 * 0–1: how much stronger the chrome's secondary ink gets (styles.css:
 * --ink-boost on .chrome-ink). 0 up to the classic intensity, 1 from 75 up.
 */
export function inkBoost(intensity: number): number {
  return clamp((clamp(intensity, 0, 100) / 100 - 0.5) * 4, 0, 1)
}

const HEX = /^#[0-9a-f]{6}$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * A valid theme from anything (stored JSON, an IPC patch merged over the
 * current theme, Arc's file). Every field that is missing or unusable falls
 * back to `base`; numbers are clamped and rounded, colors must be #rrggbb.
 */
export function sanitizeSpaceTheme(raw: unknown, base: Readonly<SpaceTheme> = DEFAULT_SPACE_THEME): SpaceTheme {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const gradient = Array.isArray(r.gradient)
    ? r.gradient.filter(isHexColor).slice(0, THEME_LIMITS.gradientStops).map((c) => c.toLowerCase())
    : [...base.gradient]
  return {
    gradient,
    angle: finite(r.angle) ? ((Math.round(r.angle) % 360) + 360) % 360 : base.angle,
    intensity: finite(r.intensity) ? Math.round(clamp(r.intensity, 0, 100)) : base.intensity,
    noise: finite(r.noise) ? Math.round(clamp(r.noise, 0, 100)) : base.noise,
    appearance: SPACE_APPEARANCES.includes(r.appearance as SpaceAppearance) ? (r.appearance as SpaceAppearance) : base.appearance
  }
}

/** Stored JSON (null for spaces saved before themes existed) → theme. */
export function parseStoredTheme(json: string | null | undefined): SpaceTheme {
  if (!json) return sanitizeSpaceTheme(null)
  try {
    return sanitizeSpaceTheme(JSON.parse(json))
  } catch {
    return sanitizeSpaceTheme(null)
  }
}

export function themesEqual(a: Readonly<SpaceTheme>, b: Readonly<SpaceTheme>): boolean {
  return (
    a.angle === b.angle &&
    a.intensity === b.intensity &&
    a.noise === b.noise &&
    a.appearance === b.appearance &&
    a.gradient.length === b.gradient.length &&
    a.gradient.every((c, i) => c.toLowerCase() === b.gradient[i]?.toLowerCase())
  )
}

/** Still exactly the defaults (never customized). */
export function isDefaultTheme(theme: Readonly<SpaceTheme>): boolean {
  return themesEqual(theme, DEFAULT_SPACE_THEME)
}

/** Share of a theme color mixed into the chrome base, 0–1 (styles.css: --tint). */
export function chromeTint(intensity: number, dark: boolean): number {
  const [mid, max] = (dark ? CHROME.dark : CHROME.light).tint
  const i = clamp(intensity, 0, 100) / 100
  return Math.min(i, 0.5) * 2 * mid + Math.max(i - 0.5, 0) * 2 * (max - mid)
}

/** The chrome color one theme color produces, as #rrggbb (styles.css: --chrome-N). */
export function chromeColor(color: string, intensity: number, dark: boolean): string {
  const spec = dark ? CHROME.dark : CHROME.light
  const rgb: Rgb = parseHex(color) ?? parseHex(spec.base)!
  const mixed = mixOklch(rgbToOklch(rgb), rgbToOklch(parseHex(spec.base)!), chromeTint(intensity, dark))
  const l = dark ? Math.min(mixed.l, CHROME.dark.maxL) : Math.max(mixed.l, CHROME.light.minL)
  return toHex(oklchToRgb({ ...mixed, l }))
}

/** Opacity of the grain layer for a `noise` value (styles.css: --grain-opacity). */
export function grainOpacity(noise: number): number {
  return Math.round(clamp(noise, 0, 100) * 0.4) / 100
}
