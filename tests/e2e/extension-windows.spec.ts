import { expect, test, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, ROOT, rpc, startServer, tempDir, waitForShown } from './helpers'

// Extension UI opens in its own native window (src/main/extensions/extension-window.ts):
// action popups sized to their content, chrome.sidePanel pages at side panel size.
const PROBE = join(ROOT, 'tests/fixtures/extensions/api-probe')
const SIDE_PANEL = join(ROOT, 'tests/fixtures/extensions/side-panel')

interface WindowInfo {
  id: number
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  content: number[]
  movable: boolean
  resizable: boolean
  childOfBrowser: boolean
  title: string
}

/** The extension window whose page URL contains `fragment`, if any. */
function extWindow(app: ElectronApplication, fragment: string): Promise<WindowInfo | null> {
  return inMain(
    app,
    (b, f: string, electron) => {
      const win = electron.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(f))
      if (!win) return null
      return {
        id: win.id,
        visible: win.isVisible(),
        bounds: win.getBounds(),
        content: win.getContentSize(),
        movable: win.isMovable(),
        resizable: win.isResizable(),
        childOfBrowser: win.getParentWindow()?.id === b.window.win.id,
        title: win.getTitle()
      }
    },
    fragment
  )
}

async function visibleWindow(app: ElectronApplication, fragment: string): Promise<WindowInfo> {
  await expect.poll(async () => (await extWindow(app, fragment))?.visible ?? false, { timeout: 15_000 }).toBe(true)
  return (await extWindow(app, fragment))!
}

async function gone(app: ElectronApplication, fragment: string): Promise<void> {
  await expect.poll(async () => (await extWindow(app, fragment)) === null, { timeout: 10_000 }).toBe(true)
}

/** Run `code` in the extension window's page (or any page) whose URL contains `fragment`. */
function inPage<T>(app: ElectronApplication, fragment: string, code: string): Promise<T> {
  return inMain(
    app,
    (_b, arg: { fragment: string; code: string }, electron) => {
      const wc = electron.webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().includes(arg.fragment))
      if (!wc) throw new Error(`no page ${arg.fragment}`)
      return wc.executeJavaScript(arg.code)
    },
    { fragment, code }
  ) as Promise<T>
}

/** A hidden extension page to drive chrome.* from (not one of our extension windows). */
function openDriver(app: ElectronApplication, url: string): Promise<void> {
  return inMain(
    app,
    async (b, u: string, electron) => {
      const win = new electron.BrowserWindow({ show: false, webPreferences: { session: b.extensions['ses'] } })
      ;(globalThis as { __driver?: unknown }).__driver = win
      await win.loadURL(u)
    },
    url
  )
}

function pressCmdW(app: ElectronApplication, fragment: string): Promise<void> {
  return inMain(
    app,
    (_b, f: string, electron) => {
      const wc = electron.webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getURL().includes(f))!
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] })
    },
    fragment
  )
}

test('action popups open in a movable window: one per extension, toggled by the button', async () => {
  const { url, server } = await startServer()
  const { app, shell, userData } = await launch()
  try {
    const ext = await inMain(app, (b, path: string) => b.extensions.install(path), PROBE)
    await rpc(shell, 'tabs.create', { url: `${url}/page/a` })
    await waitForShown(app, '/page/a')
    const icon = shell.locator(`img[src*="extension-icon/${ext.id}"]`)
    const button = shell.locator('button', { has: icon })

    await icon.click()
    const first = await visibleWindow(app, '/popup.html')
    expect(first).toMatchObject({ movable: true, resizable: true, childOfBrowser: true, title: 'API Probe' })
    // Sized to the popup's content (220px body + padding), not a fixed size.
    expect(first.content[0]).toBeGreaterThan(220)
    expect(first.content[0]).toBeLessThan(400)
    expect(first.content[1]).toBeGreaterThan(40)
    await expect(button).toHaveAttribute('aria-pressed', 'true')

    // It survives losing focus (a wallet stays open next to the dApp)…
    await inMain(app, (_b, id: number, electron) => void electron.BrowserWindow.fromId(id)!.emit('blur'), first.id)
    await new Promise((r) => setTimeout(r, 300))
    expect((await extWindow(app, '/popup.html'))?.visible).toBe(true)

    // …and can be moved; the position is remembered.
    const moved = { x: first.bounds.x + 40, y: first.bounds.y + 30 }
    await inMain(app, (_b, a: { id: number; x: number; y: number }, electron) => electron.BrowserWindow.fromId(a.id)!.setPosition(a.x, a.y), {
      id: first.id,
      ...moved
    })
    expect((await extWindow(app, '/popup.html'))?.bounds).toMatchObject(moved)
    await new Promise((r) => setTimeout(r, 600))

    // A second click closes it (one window per extension).
    await icon.click()
    await gone(app, '/popup.html')
    await expect(button).toHaveAttribute('aria-pressed', 'false')

    await icon.click()
    const reopened = await visibleWindow(app, '/popup.html')
    expect(reopened.bounds).toMatchObject(moved)
    const count = await inMain(app, (_b, _a, electron) =>
      electron.BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('/popup.html')).length
    )
    expect(count).toBe(1)

    // ⌘W while it has focus closes it…
    await pressCmdW(app, '/popup.html')
    await gone(app, '/popup.html')
    // …and so does the page's own window.close().
    await icon.click()
    await visibleWindow(app, '/popup.html')
    await inPage(app, '/popup.html', 'setTimeout(() => window.close(), 20)')
    await gone(app, '/popup.html')
    // Closing the popup never touched the browser's tabs.
    expect(await inMain(app, (b) => b.tabs.model.activeTab()?.url)).toContain('/page/a')
  } finally {
    await quit(app)
    server.close()
    removeDir(userData)
  }
})

test('chrome.sidePanel: the API works and the panel opens in a resizable extension window', async () => {
  test.setTimeout(120_000)
  const { url, server } = await startServer()
  const userData = tempDir()
  let run = await launch(userData)
  try {
    const ext = await inMain(run.app, (b, path: string) => b.extensions.install(path), SIDE_PANEL)
    const base = `chrome-extension://${ext.id}/`
    await rpc(run.shell, 'tabs.create', { url: `${url}/page/a` })
    await waitForShown(run.app, '/page/a')

    // The worker survived its top-level chrome.sidePanel call and answers.
    await openDriver(run.app, `${base}check.html`)
    const checks = await inPage<Record<string, unknown>>(run.app, 'check.html', `chrome.runtime.sendMessage({ type: 'checks' })`)
    expect(checks).toEqual({
      getPanelBehavior: true,
      getOptions: { path: 'panel.html', enabled: true },
      'getOptions(callback)': { path: 'panel.html', enabled: true },
      'setOptions(tabId)': { path: 'panel.html?tab', enabled: true, tabId: 987654 },
      getLayout: { side: 'right' }
    })
    // Extension pages get the API too.
    expect(await inPage(run.app, 'check.html', `typeof chrome.sidePanel.setPanelBehavior`)).toBe('function')

    // openPanelOnActionClick: the action opens the panel, at side panel size.
    const icon = run.shell.locator(`img[src*="extension-icon/${ext.id}"]`)
    await icon.click()
    const panel = await visibleWindow(run.app, '/panel.html')
    expect(panel).toMatchObject({ movable: true, resizable: true, childOfBrowser: true, title: 'Side Panel Probe' })
    expect(panel.content).toEqual([380, 640])
    // The page sees itself as a SIDE_PANEL context; the worker got onOpened.
    const storage = (key: string) => inPage<unknown>(run.app, 'check.html', `chrome.storage.local.get(${JSON.stringify(key)}).then(r => r[${JSON.stringify(key)}])`)
    await expect.poll(() => storage('sp:panel')).toMatchObject({ self: true })
    await expect.poll(() => storage('sp:opened')).toMatchObject({ path: 'panel.html' })

    // Resized and moved by the user: both are remembered.
    await inMain(
      run.app,
      (_b, id: number, electron) => {
        const win = electron.BrowserWindow.fromId(id)!
        win.setContentSize(420, 600)
        const b = win.getBounds()
        win.setPosition(b.x - 20, b.y + 10)
      },
      panel.id
    )
    const placed = (await extWindow(run.app, '/panel.html'))!
    await new Promise((r) => setTimeout(r, 600))

    // Toggle closed from the button; onClosed fires.
    await icon.click()
    await gone(run.app, '/panel.html')
    await expect.poll(() => storage('sp:closed')).toMatchObject({ path: 'panel.html' })

    // chrome.sidePanel.open() from an extension page reopens it where it was.
    await inPage(run.app, 'check.html', `chrome.sidePanel.open({ windowId: -2 })`)
    const again = await visibleWindow(run.app, '/panel.html')
    expect(again.content).toEqual([420, 600])
    expect({ x: again.bounds.x, y: again.bounds.y }).toEqual({ x: placed.bounds.x, y: placed.bounds.y })
    await inPage(run.app, '/panel.html', 'setTimeout(() => window.close(), 20)')
    await gone(run.app, '/panel.html')

    // chrome.windows.create popups (wallet approval windows) still get their own window.
    const created = await inPage<{ id: number; type: string }>(
      run.app,
      'check.html',
      `chrome.windows.create({ url: 'check.html?approval', type: 'popup', width: 320, height: 420, focused: false })`
    )
    expect(typeof created?.id).toBe('number')
    const approval = await visibleWindow(run.app, 'check.html?approval')
    expect(approval.bounds.width).toBe(320)
    await pressCmdW(run.app, 'check.html?approval')
    await gone(run.app, 'check.html?approval')

    // The panel behavior persists, so a click after a restart opens the
    // panel even before the worker runs again.
    await quit(run.app)
    run = await launch(userData)
    expect(await inMain(run.app, (b, id: string) => b.extensions['sidePanel'].behavior(id), ext.id)).toBe(true)
  } finally {
    await quit(run.app)
    server.close()
    removeDir(userData)
  }
})
