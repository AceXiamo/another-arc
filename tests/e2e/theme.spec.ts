import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseHex } from '../../src/shared/color'
import { chromeColor, DEFAULT_SPACE_THEME, grainOpacity } from '../../src/shared/theme'
import type { SpaceTheme } from '../../src/shared/types'
import { inMain, launch, quit, removeDir, rpc, screenshot, startServer, t, tempDir, waitForShown } from './helpers'

// Space themes: CSS variables on <html>, persistence, per-space appearance,
// the editor's live preview / Cancel, and (with THEME_SHOT_DIR) screenshots.

const activeSpace = (app: ElectronApplication) => inMain(app, (b) => b.tabs.model.activeSpaceId as string)
const modelTheme = (app: ElectronApplication, id: string) =>
  inMain(app, (b, spaceId: string) => b.tabs.model.getSpace(spaceId)?.theme, id) as Promise<SpaceTheme>

/** The <html> variables and attributes the theme writes. */
const rootVars = (shell: Page) =>
  shell.evaluate(() => {
    const root = document.documentElement
    const css = getComputedStyle(root)
    const v = (name: string) => css.getPropertyValue(name).trim()
    return {
      space: v('--space'),
      space2: v('--space-2'),
      space3: v('--space-3'),
      intensity: v('--intensity'),
      angle: v('--theme-angle'),
      image: v('--chrome-image'),
      grain: v('--grain-opacity'),
      grainAttr: root.dataset.grain ?? '',
      theme: root.dataset.theme ?? ''
    }
  })

/** Rendered chrome color of the backdrop (sRGB 0–255), resolved by the browser itself. */
const backdropRgb = (shell: Page) =>
  shell.evaluate(() => {
    const el = document.querySelector('[data-chrome-backdrop]')!
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.fillStyle = getComputedStyle(el).backgroundColor
    ctx.fillRect(0, 0, 1, 1)
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]
  })

const expectColorNear = (actual: number[], hex: string) => {
  const expected = parseHex(hex)!.map((c) => Math.round(c * 255))
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i]! - expected[i]!), `${actual} vs ${hex}`).toBeLessThanOrEqual(2)
}

const nextFrame = (shell: Page) =>
  shell.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

test('a theme set over rpc becomes CSS variables, follows the space and survives a restart', async () => {
  const userData = tempDir()
  try {
    let run = await launch(userData)
    await rpc(run.shell, 'settings.update', { theme: 'light' })
    const home = await activeSpace(run.app)

    // Defaults: the classic tint, the default grain, no gradient.
    expect(await modelTheme(run.app, home)).toEqual(DEFAULT_SPACE_THEME)
    await expect.poll(async () => (await rootVars(run.shell)).intensity).toBe('0.5')
    const homeColor = (await inMain(run.app, (b, id: string) => b.tabs.model.getSpace(id).color, home)) as string
    expectColorNear(await backdropRgb(run.shell), chromeColor(homeColor, 50, false))
    expect((await rootVars(run.shell)).grainAttr).toBe(DEFAULT_SPACE_THEME.noise > 0 ? 'on' : 'off')

    // A themed second space; partial updates merge, and main clamps / rejects.
    const work = await rpc<string>(run.shell, 'spaces.create', {
      name: 'Work',
      icon: 'work',
      color: '#14b8a6',
      theme: { gradient: ['#3b82f6', '#7c6cf2'], angle: 400, intensity: 85 }
    })
    await rpc(run.shell, 'spaces.update', work, { theme: { noise: 150 } })
    expect(await modelTheme(run.app, work)).toEqual({
      gradient: ['#3b82f6', '#7c6cf2'],
      angle: 40,
      intensity: 85,
      noise: 100,
      appearance: 'system'
    })
    await expect(rpc(run.shell, 'spaces.update', work, { theme: { gradient: ['red'] } })).rejects.toThrow()
    await expect(rpc(run.shell, 'spaces.update', work, { theme: { gradient: ['#000000', '#111111', '#222222'] } })).rejects.toThrow()
    await expect(rpc(run.shell, 'spaces.update', work, { theme: { appearance: 'sepia' } })).rejects.toThrow()

    await expect.poll(async () => (await rootVars(run.shell)).space).toBe('#14b8a6')
    const vars = await rootVars(run.shell)
    expect(vars).toMatchObject({ space2: '#3b82f6', space3: '#7c6cf2', intensity: '0.85', angle: '40deg', grainAttr: 'on' })
    expect(vars.image).toContain('linear-gradient')
    expect(Number(vars.grain)).toBeCloseTo(grainOpacity(100))
    expectColorNear(await backdropRgb(run.shell), chromeColor('#14b8a6', 85, false))
    // The native window background follows the active space's chrome.
    expect(await inMain(run.app, (b) => b.window.win.getBackgroundColor().toLowerCase())).toBe(chromeColor('#14b8a6', 85, false))

    // Switching spaces only swaps variables.
    await rpc(run.shell, 'spaces.activate', home)
    await expect.poll(async () => (await rootVars(run.shell)).space).toBe(homeColor)
    expect((await rootVars(run.shell)).image).toBe('none')
    await rpc(run.shell, 'spaces.update', home, { theme: { noise: 0 } })
    await expect.poll(async () => (await rootVars(run.shell)).grainAttr).toBe('off')
    await rpc(run.shell, 'spaces.activate', work)
    await expect.poll(async () => (await rootVars(run.shell)).space).toBe('#14b8a6')
    await quit(run.app)

    // --- restart ---------------------------------------------------------------
    run = await launch(userData)
    expect(await activeSpace(run.app)).toBe(work)
    expect((await modelTheme(run.app, work)).gradient).toEqual(['#3b82f6', '#7c6cf2'])
    expect((await modelTheme(run.app, home)).noise).toBe(0)
    await expect.poll(async () => (await rootVars(run.shell)).intensity).toBe('0.85')
    expectColorNear(await backdropRgb(run.shell), chromeColor('#14b8a6', 85, false))
    await quit(run.app)
  } finally {
    removeDir(userData)
  }
})

test('a space appearance overrides the global light/dark setting', async () => {
  const { app, shell, userData } = await launch()
  try {
    await rpc(shell, 'settings.update', { theme: 'light' })
    const home = await activeSpace(app)
    const night = await rpc<string>(shell, 'spaces.create', { name: 'Night', icon: 'star', color: '#7c6cf2', theme: { appearance: 'dark' } })
    await expect.poll(async () => (await rootVars(shell)).theme).toBe('dark')
    expectColorNear(await backdropRgb(shell), chromeColor('#7c6cf2', 50, true))
    expect(await inMain(app, (b) => b.window.win.getBackgroundColor().toLowerCase())).toBe(chromeColor('#7c6cf2', 50, true))
    // Pages keep following the global setting.
    expect(await inMain(app, (b, _a, electron) => electron.nativeTheme.shouldUseDarkColors)).toBe(false)

    await rpc(shell, 'spaces.activate', home)
    await expect.poll(async () => (await rootVars(shell)).theme).toBe('light')

    // A light space stays light under a dark global theme; 'system' follows it.
    await rpc(shell, 'settings.update', { theme: 'dark' })
    await expect.poll(async () => (await rootVars(shell)).theme).toBe('dark')
    await rpc(shell, 'spaces.update', home, { theme: { appearance: 'light' } })
    await expect.poll(async () => (await rootVars(shell)).theme).toBe('light')
    await rpc(shell, 'spaces.update', home, { theme: { appearance: 'system' } })
    await expect.poll(async () => (await rootVars(shell)).theme).toBe('dark')
    await rpc(shell, 'spaces.activate', night)
    await expect.poll(async () => (await rootVars(shell)).theme).toBe('dark')
  } finally {
    await quit(app)
    removeDir(userData)
  }
})

test('the theme editor previews live; Cancel restores the original, Save persists', async () => {
  const { app, shell, userData } = await launch()
  try {
    await rpc(shell, 'settings.update', { theme: 'light' })
    const home = await activeSpace(app)
    const original = await modelTheme(app, home)
    const before = await rootVars(shell)

    // "Edit Theme…" opens the panel on its own, raised over the page.
    await inMain(app, (b, id: string) => b.shell.command({ type: 'space.edit', spaceId: id, theme: true }), home)
    const panel = shell.locator('[data-theme-panel]')
    await expect(panel).toBeVisible()
    await expect.poll(() => inMain(app, (b) => b.window.isOverlayOpen)).toBe(true)

    await panel.getByRole('slider', { name: t('theme.intensity.label') }).fill('90')
    await panel.getByRole('slider', { name: t('theme.noise.label') }).fill('0')
    await panel.getByRole('button', { name: t('theme.colors.add') }).click()
    await panel.getByRole('radio', { name: t('theme.appearance.dark') }).click()
    await expect.poll(async () => (await rootVars(shell)).intensity).toBe('0.9')
    const preview = await rootVars(shell)
    expect(preview).toMatchObject({ grainAttr: 'off', theme: 'dark' })
    expect(preview.image).toContain('linear-gradient')
    // Nothing is saved while previewing.
    expect(await modelTheme(app, home)).toEqual(original)

    await panel.getByRole('button', { name: t('common.cancel') }).click()
    await expect(panel).toHaveCount(0)
    await nextFrame(shell)
    expect(await rootVars(shell)).toEqual(before)
    expect(await modelTheme(app, home)).toEqual(original)
    await expect.poll(() => inMain(app, (b) => b.window.isOverlayOpen)).toBe(false)

    // Escape cancels too; from the space card, the panel opens beside it.
    await inMain(app, (b, id: string) => b.shell.command({ type: 'space.edit', spaceId: id }), home)
    await expect(shell.getByText(t('sidebar.spaceEditor.titleEdit'))).toBeVisible()
    await shell.locator('[data-theme-open]').click()
    await expect(panel).toBeVisible()
    await panel.getByRole('slider', { name: t('theme.noise.label') }).fill('64')
    await panel.getByRole('button', { name: t('theme.panel.done') }).click()
    await expect(panel).toHaveCount(0)
    // The draft outlives the panel until the card saves it.
    await expect.poll(async () => (await rootVars(shell)).grain).toBe(String(grainOpacity(64)))
    await shell.locator('[data-space-editor]').getByRole('button', { name: t('common.save') }).click()
    await expect.poll(async () => (await modelTheme(app, home)).noise).toBe(64)
    expect(await rootVars(shell)).toMatchObject({ grain: String(grainOpacity(64)) })

    await inMain(app, (b, id: string) => b.shell.command({ type: 'space.edit', spaceId: id, theme: true }), home)
    await panel.getByRole('slider', { name: t('theme.noise.label') }).fill('5')
    await shell.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    expect((await modelTheme(app, home)).noise).toBe(64)
    await expect.poll(async () => (await rootVars(shell)).grain).toBe(String(grainOpacity(64)))

    // A click on the page area dismisses like Escape: the panel folds, then the editor cancels.
    await inMain(app, (b, id: string) => b.shell.command({ type: 'space.edit', spaceId: id }), home)
    await shell.locator('[data-theme-open]').click()
    await panel.getByRole('slider', { name: t('theme.intensity.label') }).fill('20')
    await expect.poll(async () => (await rootVars(shell)).intensity).toBe('0.2')
    const page = { x: 900, y: 120 }
    await shell.mouse.click(page.x, page.y)
    await expect(panel).toHaveCount(0)
    await expect(shell.locator('[data-space-editor]')).toBeVisible()
    await shell.mouse.click(page.x, page.y)
    await expect(shell.locator('[data-space-editor]')).toHaveCount(0)
    await expect.poll(async () => (await rootVars(shell)).intensity).toBe('0.5')
    await expect.poll(() => inMain(app, (b) => b.window.isOverlayOpen)).toBe(false)
    expect((await modelTheme(app, home)).intensity).toBe(original.intensity)
  } finally {
    await quit(app)
    removeDir(userData)
  }
})

// -- screenshots (THEME_SHOT_DIR) ------------------------------------------------

const SHOTS = process.env.THEME_SHOT_DIR

test('captures theme screenshots', async () => {
  test.skip(!SHOTS, 'set THEME_SHOT_DIR to capture screenshots')
  test.setTimeout(180_000)
  mkdirSync(SHOTS!, { recursive: true })
  const { url, server } = await startServer()
  const { app, shell, userData } = await launch()
  const shot = async (name: string) => {
    await shell.waitForFunction(() => [...document.images].every((img) => img.complete))
    await shell.evaluate(() => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => r())), 220)))
    await screenshot(app, join(SHOTS!, `${name}.png`))
  }
  const both = async (name: string) => {
    for (const mode of ['light', 'dark'] as const) {
      await rpc(shell, 'settings.update', { theme: mode })
      await expect.poll(async () => (await rootVars(shell)).theme).toBe(mode)
      await shot(`${name}-${mode}`)
    }
  }
  try {
    await inMain(app, (b) => b.window.win.setContentSize(1180, 760))
    const home = await activeSpace(app)
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) await rpc(shell, 'tabs.create', { url: `${url}/page/${name}` })
    await waitForShown(app, '/page/epsilon')
    const set = (theme: Partial<SpaceTheme>, color?: string) =>
      rpc(shell, 'spaces.update', home, { ...(color ? { color } : {}), theme: { ...DEFAULT_SPACE_THEME, ...theme } })

    // Three contrasting looks.
    await set({ intensity: 72, noise: 0 }, '#14b8a6')
    await both('theme-flat')
    await set({ gradient: ['#ec4899', '#f97316'], angle: 160, intensity: 80, noise: 22 }, '#7c6cf2')
    await both('theme-gradient')
    await set({ intensity: 62, noise: 100 }, '#64748b')
    await both('theme-heavy-grain')

    // Grain levels on the default tint.
    for (const noise of [0, 50, 100]) {
      await set({ noise }, '#3b82f6')
      await both(`grain-${noise}`)
    }

    // The editor: the space card with the theme panel beside it.
    await set({ gradient: ['#3b82f6'], intensity: 70, noise: 30 }, '#7c6cf2')
    await inMain(app, (b, id: string) => b.shell.command({ type: 'space.edit', spaceId: id }), home)
    await shell.locator('[data-theme-open]').click()
    await shell.locator('[data-stop="1"]').click()
    await shell.mouse.move(5, 5)
    await both('theme-editor')
    await rpc(shell, 'window.setSidebar', { width: 200 })
    await both('theme-editor-narrow')
    await shell.keyboard.press('Escape')
    await shell.keyboard.press('Escape')
    await expect(shell.locator('[data-space-editor]')).toHaveCount(0)
    await rpc(shell, 'window.setSidebar', { width: 260 })

    // "Edit Theme…" from the space menu: the panel alone, with Cancel / Save.
    await set({ gradient: ['#ec4899', '#f97316'], angle: 160, intensity: 80, noise: 22 }, '#7c6cf2')
    await inMain(app, (b, id: string) => b.shell.command({ type: 'space.edit', spaceId: id, theme: true }), home)
    await expect(shell.locator('[data-theme-panel]')).toBeVisible()
    await both('theme-editor-standalone')
    await shell.keyboard.press('Escape')

    // An internal page inside the themed chrome (the card hole, its corners).
    await rpc(shell, 'tabs.openInternal', 'settings')
    await expect(shell.getByRole('heading', { name: t('page.settings') })).toBeVisible()
    await both('theme-settings-page')

    // The peeking sidebar paints the same gradient and grain.
    await rpc(shell, 'window.setSidebar', { collapsed: true })
    await shell.mouse.move(300, 300)
    await shell.mouse.move(2, 300)
    await expect.poll(() => inMain(app, (b) => b.window.isOverlayOpen)).toBe(true)
    await both('theme-peek')
  } finally {
    await quit(app)
    server.close()
    removeDir(userData)
  }
})
