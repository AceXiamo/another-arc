// Small color toolkit shared by main (window background), the shell (color
// picker) and tests: #rrggbb ↔ sRGB ↔ OKLab/OKLCH, HSV, and WCAG contrast.
// Channels are 0–1 floats; out-of-gamut results are clipped like Chromium does.

export type Rgb = [r: number, g: number, b: number]
export interface Oklch {
  l: number
  c: number
  /** Degrees, 0–360. */
  h: number
}
export interface Hsv {
  /** Degrees, 0–360. */
  h: number
  s: number
  v: number
}

const HEX = /^#([0-9a-f]{6})$/i

export function parseHex(hex: string): Rgb | null {
  const m = HEX.exec(hex)
  if (!m) return null
  const n = Number.parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Typed hex: "#abc" / "abc" / "#aabbcc" / "aabbcc" → "#aabbcc"; anything else → null. */
export function normalizeHexInput(input: string): string | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(raw)) return `#${[...raw].map((c) => c + c).join('')}`
  if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`
  return null
}

const clamp01 = (n: number) => (n <= 0 ? 0 : n >= 1 ? 1 : n)

export function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) =>
      Math.round(clamp01(Number.isFinite(c) ? c : 0) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.sign(c) * Math.abs(c) ** (1 / 2.4) - 0.055)

export function rgbToOklch([r, g, b]: Rgb): Oklch {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

export function oklchToRgb({ l: L, c, h }: Oklch): Rgb {
  const A = c * Math.cos((h * Math.PI) / 180)
  const B = c * Math.sin((h * Math.PI) / 180)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    clamp01(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
  ]
}

const POWERLESS_CHROMA = 0.02

/** `color-mix(in oklch, a <t>, b)`: `t` is a's share, hues take the shorter arc. */
export function mixOklch(a: Oklch, b: Oklch, t: number): Oklch {
  // A near-gray has no meaningful hue; it takes the other color's (CSS
  // "powerless" hue). Chromium treats sRGB colors with chroma < 0.02 so.
  let ha = a.c < POWERLESS_CHROMA ? b.h : a.h
  let hb = b.c < POWERLESS_CHROMA ? ha : b.h
  if (hb - ha > 180) ha += 360
  else if (ha - hb > 180) hb += 360
  const h = (ha * t + hb * (1 - t)) % 360
  return { l: a.l * t + b.l * (1 - t), c: a.c * t + b.c * (1 - t), h }
}

export function rgbToHsv([r, g, b]: Rgb): Hsv {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return [f(5), f(3), f(1)]
}

/** WCAG 2 relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
