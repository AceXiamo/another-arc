import { describe, expect, it } from 'vitest'
import { clampDevtoolsSize, devtoolsExtent, LAYOUT, splitCard, viewportFrame } from '../../src/shared/layout'
import {
  describeViewport,
  presetSpec,
  rotated,
  sameViewport,
  sanitizeViewport,
  VIEWPORT_PRESETS,
  viewportUserAgent
} from '../../src/shared/viewport'

const card = { x: 260, y: 8, width: 1000, height: 800 }

describe('splitCard', () => {
  it('leaves the card to the page without DevTools', () => {
    expect(splitCard(card, null)).toEqual({ page: card, devtools: null })
  })

  it('docks DevTools on each side, a gutter from the page', () => {
    const right = splitCard(card, { side: 'right', size: 400 })
    expect(right.page).toEqual({ x: 260, y: 8, width: 592, height: 800 })
    expect(right.devtools).toEqual({ x: 860, y: 8, width: 400, height: 800 })

    const left = splitCard(card, { side: 'left', size: 400 })
    expect(left.devtools).toEqual({ x: 260, y: 8, width: 400, height: 800 })
    expect(left.page).toEqual({ x: 668, y: 8, width: 592, height: 800 })

    const bottom = splitCard(card, { side: 'bottom', size: 300 })
    expect(bottom.page).toEqual({ x: 260, y: 8, width: 1000, height: 492 })
    expect(bottom.devtools).toEqual({ x: 260, y: 508, width: 1000, height: 300 })
  })

  it('keeps the page its minimum, and DevTools theirs', () => {
    expect(devtoolsExtent(1000, 5000)).toBe(1000 - LAYOUT.devtoolsPageMin - LAYOUT.gutter)
    expect(devtoolsExtent(1000, 10)).toBe(LAYOUT.devtoolsMin)
    // A card too small for both: DevTools keep their minimum, the page gives way.
    const tiny = splitCard({ x: 0, y: 0, width: 300, height: 400 }, { side: 'right', size: 480 })
    expect(tiny.devtools!.width).toBe(LAYOUT.devtoolsMin)
    expect(tiny.page.width).toBe(300 - LAYOUT.devtoolsMin - LAYOUT.gutter)
  })

  it('clamps stored sizes', () => {
    expect(clampDevtoolsSize(12.4, 480)).toBe(LAYOUT.devtoolsMin)
    expect(clampDevtoolsSize(Number.NaN, 480)).toBe(480)
    expect(clampDevtoolsSize(512.6, 480)).toBe(513)
  })
})

describe('viewportFrame', () => {
  const area = { width: 1000, height: 800 }

  it('shows a device that fits at its size, centered below the toolbar', () => {
    const f = viewportFrame(area, { width: 393, height: 600 })
    expect(f).toEqual({ x: Math.floor((1000 - 393) / 2), y: LAYOUT.deviceBar + LAYOUT.devicePad, width: 393, height: 600, scale: 1 })
  })

  it('scales a device down, never up, keeping its shape', () => {
    const f = viewportFrame(area, { width: 1920, height: 1080 })
    expect(f.scale).toBeCloseTo((1000 - LAYOUT.devicePad * 2) / 1920)
    expect(f.width).toBeLessThanOrEqual(1000 - LAYOUT.devicePad * 2)
    expect(Math.abs(f.width / f.height - 1920 / 1080)).toBeLessThan(0.01)
    const tall = viewportFrame(area, { width: 400, height: 2000 })
    expect(tall.y + tall.height).toBeLessThanOrEqual(800 - LAYOUT.devicePad)
  })
})

describe('viewport specs', () => {
  it('turns presets into specs; phones and tablets are mobile', () => {
    expect(presetSpec('iphone-16')).toEqual({ width: 393, height: 852, deviceScaleFactor: 3, mobile: true, preset: 'iphone-16' })
    expect(presetSpec('desktop-fhd')!.mobile).toBe(false)
    expect(presetSpec('nope')).toBeNull()
    for (const p of VIEWPORT_PRESETS) expect(sanitizeViewport(presetSpec(p.id))).toEqual(presetSpec(p.id))
  })

  it('sanitizes untrusted input', () => {
    expect(sanitizeViewport({ width: 10, height: 99999.6, deviceScaleFactor: 9, mobile: 'yes', preset: 'made-up' })).toEqual({
      width: 50,
      height: 9999,
      deviceScaleFactor: 4,
      mobile: false,
      preset: null
    })
    expect(sanitizeViewport({ width: 'wide', height: 500 })).toBeNull()
    expect(sanitizeViewport(null)).toBeNull()
    expect(sanitizeViewport({ width: 800, height: 600, deviceScaleFactor: -1 })!.deviceScaleFactor).toBe(0)
  })

  it('rotates, compares and describes', () => {
    const phone = presetSpec('iphone-se')!
    const side = rotated(phone)
    expect(side).toMatchObject({ width: 667, height: 375, preset: 'iphone-se' })
    expect(sameViewport(phone, side)).toBe(false)
    expect(sameViewport(null, undefined)).toBe(true)
    expect(describeViewport(phone)).toBe('iPhone SE (375×667 @2x), mobile with touch')
    expect(describeViewport(side)).toBe('iPhone SE (667×375 @2x, landscape), mobile with touch')
    expect(describeViewport({ width: 800, height: 600, deviceScaleFactor: 0, mobile: false, preset: null })).toBe('800×600')
  })

  it('browses with the device’s own browser when mobile', () => {
    expect(viewportUserAgent(presetSpec('iphone-16')!, '152')).toContain('iPhone')
    expect(viewportUserAgent(presetSpec('pixel-9')!, '152')).toContain('Chrome/152.0.0.0 Mobile')
    expect(viewportUserAgent({ ...presetSpec('desktop-fhd')!, mobile: true, preset: null }, '152')).toContain('Android')
    expect(viewportUserAgent(presetSpec('laptop')!, '152')).toBeNull()
  })
})
