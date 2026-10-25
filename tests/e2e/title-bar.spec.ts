import { expect, test } from '@playwright/test'
import { inMain, launch, quit, removeDir } from './helpers'

// Title-bar areas (sidebar header, the gap above the page, the space bar):
// press-and-drag moves the window and double-click runs the system action.
// Main follows the OS cursor while the button is down; tests feed it a fake one.

test('dragging and double-clicking the title-bar areas', async () => {
  const { app, shell, userData } = await launch()
  try {
    await inMain(app, (b, _a, electron) => {
      const g = globalThis as unknown as { __cursor: { x: number; y: number }; __dblAction: string }
      g.__cursor = { x: 0, y: 0 }
      g.__dblAction = 'Maximize'
      electron.screen.getCursorScreenPoint = () => ({ ...g.__cursor })
      electron.systemPreferences.getUserDefault = (() => g.__dblAction) as never
      b.window.win.setBounds({ x: 100, y: 100, width: 1100, height: 700 })
    })
    const setCursor = (x: number, y: number) =>
      inMain(app, (_b, p: { x: number; y: number }) => {
        ;(globalThis as unknown as { __cursor: { x: number; y: number } }).__cursor = p
      }, { x, y })
    const position = () => inMain(app, (b) => b.window.win.getPosition() as number[])

    // Press in each area, move the (fake) cursor, release.
    const areas = { 'gap above the page': { x: 700, y: 4 }, 'sidebar header': { x: 160, y: 22 } }
    for (const [label, at] of Object.entries(areas)) {
      await inMain(app, (b) => b.window.win.setPosition(100, 100))
      await setCursor(500, 500)
      await shell.mouse.move(at.x, at.y)
      await shell.mouse.down()
      await setCursor(501, 501) // under the click slop: nothing moves
      await shell.waitForTimeout(60)
      expect(await position(), label).toEqual([100, 100])
      await setCursor(560, 530)
      await expect.poll(position, { message: label }).toEqual([160, 130])
      await shell.mouse.up()
      await setCursor(700, 700)
      await shell.waitForTimeout(60)
      expect(await position(), `${label} after release`).toEqual([160, 130])
    }

    // Buttons inside the header keep their clicks (here: collapse the sidebar) and never start a drag.
    await inMain(app, (b) => b.window.win.setPosition(100, 100))
    await setCursor(500, 500)
    await shell.locator('aside button').first().hover()
    await shell.mouse.down()
    await setCursor(600, 600)
    await shell.waitForTimeout(60)
    await shell.mouse.up()
    expect(await position()).toEqual([100, 100])
    await expect.poll(() => inMain(app, (b) => b.snapshot().window.sidebarCollapsed)).toBe(true)
    // Collapsed: the whole top gap is the title bar.
    await setCursor(500, 500)
    await shell.mouse.move(160, 4)
    await shell.mouse.down()
    await setCursor(520, 540)
    await expect.poll(position).toEqual([120, 140])
    await shell.mouse.up()
    await inMain(app, (b) => b.setSidebar({ collapsed: false }))
    await expect(shell.locator('aside')).toBeVisible()

    // Double-click follows "Double-click a window's title bar to…".
    await shell.mouse.dblclick(700, 4)
    await expect.poll(() => inMain(app, (b) => b.window.win.isMaximized())).toBe(true)
    await shell.waitForTimeout(600) // let the zoom animation finish
    await shell.mouse.dblclick(160, 22)
    await expect.poll(() => inMain(app, (b) => b.window.win.isMaximized())).toBe(false)
    await inMain(app, () => {
      ;(globalThis as unknown as { __dblAction: string }).__dblAction = 'None'
    })
    await shell.mouse.dblclick(700, 4)
    await shell.waitForTimeout(300)
    expect(await inMain(app, (b) => b.window.win.isMaximized())).toBe(false)
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
