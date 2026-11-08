import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, tempDir, waitForShown } from './helpers'

// DevTools docked in the window (beside the page, or in a window of their
// own) and the device toolbar. Main lays the views out; the shell cuts holes
// and draws the splitter and toolbar with its own arithmetic. These tests
// hold the two to the same pixels.

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Responsive</title>
<body style="margin:0;font:16px system-ui"><button id="b" style="margin:40px" onclick="this.textContent = 'clicked ' + innerWidth">Press</button></body>`

let server: Server
let site: string

test.beforeAll(async () => {
  server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(() => server.close())

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The fields of a tab these tests look at. */
function tabOf(app: ElectronApplication, id: string) {
  return inMain(app, (b, tabId: string) => {
    const t = b.tabs.model.getTab(tabId)
    return { devtools: t?.devtools === true, viewport: t?.viewport ?? null }
  }, id) as Promise<{ devtools: boolean; viewport: { preset: string | null; width: number } | null }>
}

function windowState(app: ElectronApplication) {
  return inMain(app, (b) => b.snapshot().window) as Promise<{ devtoolsDock: string; devtoolsWidth: number; devtoolsHeight: number }>
}

/** Bounds of the shown page view and of docked DevTools (null when none are in the window). */
function views(app: ElectronApplication) {
  return inMain(app, (b) => {
    const w = b.window
    const page = w.currentPage
    const children = w.win.contentView.children
    const devtools = children.find((v: any) => v.webContents?.getURL().startsWith('devtools://'))
    return {
      page: page ? page.getBounds() : null,
      devtools: devtools ? devtools.getBounds() : null,
      devtoolsId: devtools ? devtools.webContents.id : null
    } as { page: Rect | null; devtools: Rect | null; devtoolsId: number | null }
  })
}

function domRect(shell: Page, selector: string): Promise<Rect | null> {
  return shell.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  }, selector)
}

/** The shell's hole for the page is the view's bounds, 1px in on every side. */
async function expectHoleMatches(shell: Page, app: ElectronApplication): Promise<void> {
  await expect
    .poll(async () => {
      const { page } = await views(app)
      const hole = await domRect(shell, '[data-page-card]')
      return page && hole ? [hole.x - page.x, hole.y - page.y, page.width - hole.width, page.height - hole.height] : null
    })
    .toEqual([1, 1, 2, 2])
}

test('DevTools dock beside the page, move between sides and a window of their own, and keep their state', async () => {
  const { app, shell, userData } = await launch()
  try {
    await inMain(app, (b) => b.window.win.setSize(1300, 820))
    const tab = await rpc<string>(shell, 'tabs.create', { url: site })
    await waitForShown(app, site)

    await rpc(shell, 'devtools.toggle', tab)
    await expect.poll(async () => (await views(app)).devtools).not.toBeNull()
    expect((await tabOf(app, tab)).devtools).toBe(true)
    const { page, devtools, devtoolsId } = await views(app)
    // Right, a gutter apart, same height.
    expect(devtools!.x).toBe(page!.x + page!.width + 8)
    expect(devtools!.y).toBe(page!.y)
    expect(devtools!.height).toBe(page!.height)
    expect(devtools!.width).toBe(480)
    await expectHoleMatches(shell, app)
    // The splitter fills the gap.
    expect(await domRect(shell, '[data-devtools-splitter]')).toEqual({ x: page!.x + page!.width, y: page!.y, width: 8, height: page!.height })

    // Resize from the splitter: main and the shell agree.
    await rpc(shell, 'devtools.setLayout', { width: 600 })
    await expect.poll(async () => (await views(app)).devtools?.width).toBe(600)
    await expectHoleMatches(shell, app)
    // More than fits leaves the page its minimum.
    await rpc(shell, 'devtools.setLayout', { width: 3000 })
    await expect.poll(async () => (await views(app)).page?.width).toBe(240)
    await expectHoleMatches(shell, app)
    await rpc(shell, 'devtools.setLayout', { width: 480 })

    for (const dock of ['bottom', 'left'] as const) {
      await rpc(shell, 'devtools.setLayout', { dock })
      await expect.poll(async () => (await windowState(app)).devtoolsDock).toBe(dock)
      const v = await views(app)
      if (dock === 'bottom') {
        expect(v.devtools!.y).toBe(v.page!.y + v.page!.height + 8)
        expect(v.devtools!.height).toBe(320)
        expect(v.devtools!.width).toBe(v.page!.width)
      } else {
        expect(v.page!.x).toBe(v.devtools!.x + v.devtools!.width + 8)
      }
      // The same DevTools moved: nothing was reopened.
      expect(v.devtoolsId).toBe(devtoolsId)
      await expectHoleMatches(shell, app)
    }

    // A window of their own, then back: still the same DevTools.
    const windows = () => inMain(app, (_b, _a, { BaseWindow }) => BaseWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)
    const before = await windows()
    await rpc(shell, 'devtools.setLayout', { dock: 'undocked' })
    await expect.poll(windows).toBe(before + 1)
    expect((await views(app)).devtools).toBeNull()
    expect(await domRect(shell, '[data-devtools-splitter]')).toBeNull()
    await expectHoleMatches(shell, app)
    const undocked = await inMain(app, (b, id: string) => b.tabs.runtime(id).devtools.webContents.id, tab)
    expect(undocked).toBe(devtoolsId)
    await rpc(shell, 'devtools.setLayout', { dock: 'right' })
    await expect.poll(windows).toBe(before)
    expect((await views(app)).devtoolsId).toBe(devtoolsId)

    // Closing their window closes DevTools; they open in a window again next time.
    await rpc(shell, 'devtools.setLayout', { dock: 'undocked' })
    await expect.poll(windows).toBe(before + 1)
    await inMain(app, (_b, _a, { BaseWindow }) => BaseWindow.getAllWindows().find((w) => w.getTitle().startsWith('DevTools'))!.close())
    await expect.poll(async () => (await tabOf(app, tab)).devtools).toBe(false)
    await expect.poll(windows).toBe(before)
    await rpc(shell, 'devtools.toggle', tab)
    await expect.poll(windows).toBe(before + 1)
    await rpc(shell, 'devtools.toggle', tab)
    await expect.poll(windows).toBe(before)
    await rpc(shell, 'devtools.setLayout', { dock: 'right' })
    await rpc(shell, 'devtools.toggle', tab)
    await expect.poll(async () => (await views(app)).devtools).not.toBeNull()
    const reopened = (await views(app)).devtoolsId!

    // Closing destroys the frontend.
    await rpc(shell, 'devtools.toggle', tab)
    await expect.poll(async () => (await views(app)).devtools).toBeNull()
    expect((await tabOf(app, tab)).devtools).toBe(false)
    await expect.poll(() => inMain(app, (_b, id: number, { webContents }) => !webContents.fromId(id), reopened)).toBe(true)
    await expectHoleMatches(shell, app)

    // Context-menu "Inspect" opens them on the element.
    await inMain(app, (b, id: string) => b.tabs.openDevTools(id, { inspect: { x: 60, y: 60 } }), tab)
    await expect.poll(async () => (await views(app)).devtools).not.toBeNull()
  } finally {
    await quit(app)
    removeDir(userData)
  }
})

test('the device toolbar emulates a device, fits it to the window, and follows navigation', async () => {
  const { app, shell, userData } = await launch()
  try {
    await inMain(app, (b) => b.window.win.setSize(1300, 820))
    const tab = await rpc<string>(shell, 'tabs.create', { url: site })
    await waitForShown(app, site)
    const page = (code: string) => inMain(app, (b, [id, c]: [string, string]) => b.tabs.runtime(id).wc.executeJavaScript(c), [tab, code])
    const natural = await page('innerWidth')

    await rpc(shell, 'viewport.toggle', tab)
    await expect.poll(async () => (await tabOf(app, tab)).viewport?.preset).toBe('iphone-16')
    await expect.poll(() => page('innerWidth')).toBe(393)
    expect(await page('[innerHeight, devicePixelRatio, navigator.maxTouchPoints]')).toEqual([852, 3, 5])
    expect(await page('navigator.userAgent')).toContain('iPhone')
    // The view is the fit device; the shell's hole is exactly there, the toolbar above it.
    const fit = async () => ({ view: (await views(app)).page!, hole: (await domRect(shell, '[data-device-hole]'))! })
    const offset = async () => {
      const { view, hole } = await fit()
      return [hole.x - view.x, hole.y - view.y, hole.width - view.width, hole.height - view.height]
    }
    await expect.poll(offset).toEqual([0, 0, 0, 0])
    expect(await domRect(shell, '[data-device-toolbar]')).not.toBeNull()

    // A desktop bigger than the window: laid out at its size, drawn smaller.
    await rpc(shell, 'viewport.set', tab, { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, preset: 'desktop-fhd' })
    await expect.poll(() => page('innerWidth')).toBe(1920)
    expect(await page('navigator.userAgent')).toContain('Macintosh')
    await expect.poll(offset).toEqual([0, 0, 0, 0])
    const { view } = await fit()
    expect(view.width).toBeLessThan(1920)
    expect(Math.abs(view.width / view.height - 1920 / 1080)).toBeLessThan(0.01)

    // A click on the scaled page lands where it should.
    await inMain(app, (b, id: string) => {
      const wc = b.tabs.runtime(id).wc
      const scale = b.tabs.runtime(id).emulationScale
      for (const type of ['mouseDown', 'mouseUp'])
        wc.sendInputEvent({ type, x: Math.round(60 * scale), y: Math.round(50 * scale), button: 'left', clickCount: 1 })
    }, tab)
    await expect.poll(() => page('document.getElementById("b").textContent')).toBe('clicked 1920')

    // Emulation stays across a new document.
    await rpc(shell, 'tabs.navigate', tab, `${site}/again`)
    await waitForShown(app, `${site}/again`)
    await expect.poll(() => page('innerWidth')).toBe(1920)

    // Off: the page is back at the card's size.
    await rpc(shell, 'viewport.toggle', tab)
    await expect.poll(() => page('innerWidth')).toBe(natural)
    expect(await domRect(shell, '[data-device-toolbar]')).toBeNull()
    await expectHoleMatches(shell, app)

    // On again: the device used last.
    await rpc(shell, 'viewport.toggle', tab)
    await expect.poll(() => page('innerWidth')).toBe(1920)
  } finally {
    await quit(app)
    removeDir(userData)
  }
})

test('the dock side and size are remembered', async () => {
  const userData = tempDir()
  let { app, shell } = await launch(userData)
  try {
    await rpc(shell, 'devtools.setLayout', { dock: 'bottom', height: 400 })
    await quit(app)
    ;({ app, shell } = await launch(userData))
    expect(await windowState(app)).toMatchObject({ devtoolsDock: 'bottom', devtoolsHeight: 400 })
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
