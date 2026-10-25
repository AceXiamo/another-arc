import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  hsvToRgb,
  mixOklch,
  normalizeHexInput,
  oklchToRgb,
  parseHex,
  rgbToHsv,
  rgbToOklch,
  toHex,
  type Rgb
} from '@shared/color'
import { SPACE_COLORS } from '@shared/defaults'
import {
  CHROME,
  chromeColor,
  chromeTint,
  DEFAULT_SPACE_THEME,
  grainOpacity,
  inkBoost,
  isDefaultTheme,
  parseStoredTheme,
  sanitizeSpaceTheme,
  themesEqual
} from '@shared/theme'

describe('sanitizeSpaceTheme', () => {
  it('fills defaults for missing or unusable input', () => {
    for (const raw of [null, undefined, 42, 'x', [], {}]) {
      expect(sanitizeSpaceTheme(raw)).toEqual(DEFAULT_SPACE_THEME)
    }
    // A fresh copy every time: callers may keep and change it.
    expect(sanitizeSpaceTheme(null)).not.toBe(DEFAULT_SPACE_THEME)
    expect(sanitizeSpaceTheme(null).gradient).not.toBe(DEFAULT_SPACE_THEME.gradient)
  })

  it('has a default that keeps the classic tint and a subtle grain', () => {
    expect(DEFAULT_SPACE_THEME.intensity).toBe(50)
    expect(DEFAULT_SPACE_THEME.gradient).toEqual([])
    expect(DEFAULT_SPACE_THEME.appearance).toBe('system')
    expect(DEFAULT_SPACE_THEME.noise).toBeGreaterThan(0)
    expect(DEFAULT_SPACE_THEME.noise).toBeLessThanOrEqual(30)
    // Intensity 50 = the 17% / 15% mix styles.css used before themes existed.
    expect(chromeTint(50, false)).toBeCloseTo(0.17)
    expect(chromeTint(50, true)).toBeCloseTo(0.15)
  })

  it('clamps and rounds numbers, wraps the angle', () => {
    expect(sanitizeSpaceTheme({ intensity: 140, noise: -3, angle: 725.4 })).toMatchObject({ intensity: 100, noise: 0, angle: 5 })
    expect(sanitizeSpaceTheme({ intensity: 33.6, noise: 12.2, angle: -90 })).toMatchObject({ intensity: 34, noise: 12, angle: 270 })
    expect(sanitizeSpaceTheme({ intensity: Number.NaN, noise: Infinity, angle: '45' })).toMatchObject({
      intensity: DEFAULT_SPACE_THEME.intensity,
      noise: DEFAULT_SPACE_THEME.noise,
      angle: DEFAULT_SPACE_THEME.angle
    })
  })

  it('keeps only #rrggbb gradient colors, at most two, lowercased', () => {
    expect(sanitizeSpaceTheme({ gradient: ['#AABBCC', 'red', '#123', 7, '#00ff00', '#0000ff'] }).gradient).toEqual([
      '#aabbcc',
      '#00ff00'
    ])
    expect(sanitizeSpaceTheme({ gradient: 'nope' }).gradient).toEqual([])
  })

  it('accepts only known appearances', () => {
    expect(sanitizeSpaceTheme({ appearance: 'dark' }).appearance).toBe('dark')
    expect(sanitizeSpaceTheme({ appearance: 'sepia' }).appearance).toBe('system')
  })

  it('merges a partial theme over a base (IPC updates)', () => {
    const base = sanitizeSpaceTheme({ gradient: ['#112233'], angle: 90, intensity: 80, noise: 0, appearance: 'light' })
    expect(sanitizeSpaceTheme({ noise: 40 }, base)).toEqual({ ...base, noise: 40 })
    expect(sanitizeSpaceTheme({ intensity: 'x' }, base).intensity).toBe(80)
  })

  it('parses stored JSON; null and corrupt rows (pre-v3 spaces) get the defaults', () => {
    expect(parseStoredTheme(null)).toEqual(DEFAULT_SPACE_THEME)
    expect(parseStoredTheme('{oops')).toEqual(DEFAULT_SPACE_THEME)
    expect(parseStoredTheme(JSON.stringify({ noise: 75, gradient: ['#ff0000'] }))).toMatchObject({ noise: 75, gradient: ['#ff0000'] })
  })

  it('compares themes', () => {
    expect(isDefaultTheme(sanitizeSpaceTheme(null))).toBe(true)
    expect(isDefaultTheme(sanitizeSpaceTheme({ noise: 0 }))).toBe(false)
    expect(themesEqual(sanitizeSpaceTheme({ gradient: ['#ABCDEF'] }), sanitizeSpaceTheme({ gradient: ['#abcdef'] }))).toBe(true)
  })

  it('maps noise to a bounded grain opacity, 0 = off', () => {
    expect(grainOpacity(0)).toBe(0)
    expect(grainOpacity(100)).toBeLessThanOrEqual(0.6)
    expect(grainOpacity(50)).toBeGreaterThan(grainOpacity(20))
  })
})

describe('chrome colors', () => {
  const textLight = parseHex(CHROME.light.text)!
  const textDark = parseHex(CHROME.dark.text)!
  const extremes = [...SPACE_COLORS, '#000000', '#ffffff', '#1e1b4b', '#fde047', '#00ff00', '#ff00ff', '#0000ff']
  const intensities = [0, 25, 50, 60, 75, 90, 100]
  /** --text-2 (translucent text) composited over the chrome, as the browser does. */
  const secondary = (text: Rgb, bg: Rgb, alpha: number): Rgb => [0, 1, 2].map((i) => text[i]! * alpha + bg[i]! * (1 - alpha)) as Rgb

  it('keeps primary text readable at every intensity, light and dark', () => {
    for (const color of extremes) {
      for (const intensity of intensities) {
        const light = parseHex(chromeColor(color, intensity, false))!
        const dark = parseHex(chromeColor(color, intensity, true))!
        expect(contrastRatio(light, textLight), `${color} @${intensity} light`).toBeGreaterThanOrEqual(6.5)
        expect(contrastRatio(dark, textDark), `${color} @${intensity} dark`).toBeGreaterThanOrEqual(7)
      }
    }
  })

  it('keeps secondary text at least as readable as the classic tint did', () => {
    for (const dark of [false, true]) {
      const spec = dark ? CHROME.dark : CHROME.light
      const text = dark ? textDark : textLight
      const ratio = (color: string, intensity: number) => {
        const bg = parseHex(chromeColor(color, intensity, dark))!
        return contrastRatio(secondary(text, bg, spec.text2 + CHROME.text2Boost * inkBoost(intensity)), bg)
      }
      // WCAG AA (4.5), or the worst preset of the classic tint when that was already lower.
      const classic = Math.min(...SPACE_COLORS.map((c) => ratio(c, 50)))
      expect(classic).toBeGreaterThan(4)
      const floor = Math.min(classic, 4.5) * 0.97
      for (const color of extremes) {
        for (const intensity of intensities.filter((i) => i > 50)) {
          expect(ratio(color, intensity), `${color} @${intensity} ${dark ? 'dark' : 'light'}`).toBeGreaterThanOrEqual(floor)
        }
      }
    }
  })

  it('matches the classic tint at the default intensity', () => {
    // Before themes: color-mix(in oklch, var(--space) 17%, #ebebf0).
    const classic = toHex(oklchToRgb(mixOklch(rgbToOklch(parseHex('#3b82f6')!), rgbToOklch(parseHex('#ebebf0')!), 0.17)))
    expect(chromeColor('#3b82f6', 50, false)).toBe(classic)
    // Intensity 0 is the neutral base (its faint hue is "powerless", as in Chromium).
    const zero = rgbToOklch(parseHex(chromeColor('#ef4444', 0, false))!)
    const base = rgbToOklch(parseHex(CHROME.light.base)!)
    expect(zero.l).toBeCloseTo(base.l, 2)
    expect(zero.c).toBeCloseTo(base.c, 2)
  })

  it('takes on more color as intensity rises', () => {
    const chroma = (i: number) => rgbToOklch(parseHex(chromeColor('#3b82f6', i, false))!).c
    expect(chroma(100)).toBeGreaterThan(chroma(50))
    expect(chroma(50)).toBeGreaterThan(chroma(10))
  })
})

describe('color conversions', () => {
  it('round-trips hex through OKLCH and HSV', () => {
    for (const hex of ['#7c6cf2', '#000000', '#ffffff', '#14b8a6', '#808080']) {
      expect(toHex(oklchToRgb(rgbToOklch(parseHex(hex)!)))).toBe(hex)
      expect(toHex(hsvToRgb(rgbToHsv(parseHex(hex)!)))).toBe(hex)
    }
    expect(parseHex('#12345')).toBeNull()
    expect(toHex([2, -1, 0.5])).toBe('#ff0080')
  })

  it('normalizes typed hex values', () => {
    expect(normalizeHexInput('#ABC')).toBe('#aabbcc')
    expect(normalizeHexInput(' 3b82f6 ')).toBe('#3b82f6')
    expect(normalizeHexInput('#12')).toBeNull()
    expect(normalizeHexInput('zzzzzz')).toBeNull()
  })
})
