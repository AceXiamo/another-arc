// Device emulation (the device toolbar): a tab laid out at another screen's
// size, pixel ratio and input, like Chrome's device mode. Applied in main over
// the DevTools protocol (see TabRuntime.setViewport); the shell draws the
// toolbar, agents set it with the set_viewport tool.

export interface ViewportSpec {
  /** Layout viewport in CSS pixels. */
  width: number
  height: number
  /** Device pixel ratio; 0 keeps the screen's own. */
  deviceScaleFactor: number
  /** A phone or tablet: meta viewport, overlay scrollbars, touch input and a mobile user agent. */
  mobile: boolean
  /** The preset it was picked from; null for a custom size (custom sizes keep it while only rotated). */
  preset: string | null
}

export type DeviceKind = 'phone' | 'tablet' | 'desktop'

export interface ViewportPreset {
  id: string
  name: string
  kind: DeviceKind
  width: number
  height: number
  deviceScaleFactor: number
  /** User agent family for mobile devices. */
  agent: 'iphone' | 'ipad' | 'android' | null
}

export const VIEWPORT_LIMITS = { min: 50, max: 9999 } as const

/** Sizes as the devices report them in CSS pixels (portrait for phones and tablets). */
export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: 'iphone-se', name: 'iPhone SE', kind: 'phone', width: 375, height: 667, deviceScaleFactor: 2, agent: 'iphone' },
  { id: 'iphone-16', name: 'iPhone 16', kind: 'phone', width: 393, height: 852, deviceScaleFactor: 3, agent: 'iphone' },
  { id: 'iphone-16-pro-max', name: 'iPhone 16 Pro Max', kind: 'phone', width: 440, height: 956, deviceScaleFactor: 3, agent: 'iphone' },
  { id: 'pixel-9', name: 'Pixel 9', kind: 'phone', width: 412, height: 923, deviceScaleFactor: 2.625, agent: 'android' },
  { id: 'galaxy-s24', name: 'Galaxy S24', kind: 'phone', width: 360, height: 780, deviceScaleFactor: 3, agent: 'android' },
  { id: 'ipad-mini', name: 'iPad mini', kind: 'tablet', width: 744, height: 1133, deviceScaleFactor: 2, agent: 'ipad' },
  { id: 'ipad-air', name: 'iPad Air', kind: 'tablet', width: 820, height: 1180, deviceScaleFactor: 2, agent: 'ipad' },
  { id: 'ipad-pro', name: 'iPad Pro 13"', kind: 'tablet', width: 1032, height: 1376, deviceScaleFactor: 2, agent: 'ipad' },
  { id: 'laptop', name: 'Laptop', kind: 'desktop', width: 1280, height: 800, deviceScaleFactor: 0, agent: null },
  { id: 'laptop-hd', name: 'Laptop HD', kind: 'desktop', width: 1366, height: 768, deviceScaleFactor: 0, agent: null },
  { id: 'macbook-air', name: 'MacBook Air', kind: 'desktop', width: 1440, height: 900, deviceScaleFactor: 2, agent: null },
  { id: 'desktop-fhd', name: 'Full HD', kind: 'desktop', width: 1920, height: 1080, deviceScaleFactor: 1, agent: null },
  { id: 'desktop-qhd', name: 'QHD', kind: 'desktop', width: 2560, height: 1440, deviceScaleFactor: 1, agent: null }
]

/** Mobile user agents (Chrome's device mode sends the device's own browser). */
export const MOBILE_USER_AGENTS = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  /** `{major}`: the Chromium version the browser runs, as its own user agent says. */
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Mobile Safari/537.36'
} as const

export const DEFAULT_VIEWPORT_PRESET = 'iphone-16'

export function presetById(id: string | null | undefined): ViewportPreset | undefined {
  return id ? VIEWPORT_PRESETS.find((p) => p.id === id) : undefined
}

export function presetSpec(id: string): ViewportSpec | null {
  const p = presetById(id)
  if (!p) return null
  return { width: p.width, height: p.height, deviceScaleFactor: p.deviceScaleFactor, mobile: p.kind !== 'desktop', preset: p.id }
}

/** The user agent a viewport browses with, or null for the browser's own. */
export function viewportUserAgent(spec: ViewportSpec, chromeMajor: string): string | null {
  if (!spec.mobile) return null
  const agent = presetById(spec.preset)?.agent
  return MOBILE_USER_AGENTS[agent ?? 'android'].replace('{major}', chromeMajor)
}

function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n))) : fallback
}

/** A well-formed spec from untrusted input (IPC, agents, stored settings), or null. */
export function sanitizeViewport(input: unknown): ViewportSpec | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<Record<keyof ViewportSpec, unknown>>
  const { min, max } = VIEWPORT_LIMITS
  const width = clampInt(raw.width, min, max, NaN)
  const height = clampInt(raw.height, min, max, NaN)
  if (Number.isNaN(width) || Number.isNaN(height)) return null
  const dsf = typeof raw.deviceScaleFactor === 'number' && Number.isFinite(raw.deviceScaleFactor) ? raw.deviceScaleFactor : 0
  const preset = typeof raw.preset === 'string' && presetById(raw.preset) ? raw.preset : null
  return {
    width,
    height,
    deviceScaleFactor: dsf <= 0 ? 0 : Math.round(Math.min(4, Math.max(0.5, dsf)) * 1000) / 1000,
    mobile: raw.mobile === true,
    preset
  }
}

export function sameViewport(a: ViewportSpec | null | undefined, b: ViewportSpec | null | undefined): boolean {
  if (!a || !b) return !a === !b
  return a.width === b.width && a.height === b.height && a.deviceScaleFactor === b.deviceScaleFactor && a.mobile === b.mobile && a.preset === b.preset
}

/** Width and height swapped. */
export function rotated(spec: ViewportSpec): ViewportSpec {
  return { ...spec, width: spec.height, height: spec.width }
}

/** "393×852 @3x, mobile" — how a viewport reads to agents. */
export function describeViewport(spec: ViewportSpec): string {
  const name = presetById(spec.preset)?.name
  const dpr = spec.deviceScaleFactor ? ` @${spec.deviceScaleFactor}x` : ''
  const landscape = name && presetById(spec.preset)!.width !== spec.width ? ', landscape' : ''
  return `${name ? `${name} (${spec.width}×${spec.height}${dpr}${landscape})` : `${spec.width}×${spec.height}${dpr}`}${spec.mobile ? ', mobile with touch' : ''}`
}
