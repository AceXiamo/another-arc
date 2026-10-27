import { expect, test, type ElectronApplication } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, startServer, state, waitForShown } from './helpers'

// ⌘Z in the running app: undo closing a tab (or the window) unless text is
// being edited, as in Arc. The command is run directly — whether ⌘Z reaches
// it is the menu's job, checked separately below.

const undo = (app: ElectronApplication) => inMain(app, (b) => b.runCommand('edit.undo'))

const tabUrls = async (app: ElectronApplication) => {
  const s = await state(app)
  const space = s.spaces.find((x) => x.id === s.activeSpaceId)!
  return space.tabIds.map((id) => s.tabs[id]!.url)
}

/** Run JS in the page of the active tab. */
const inActive = (app: ElectronApplication, script: string) =>
  inMain(
    app,
    (b, source: string) => {
      const active = b.tabs.model.activeTab()
      return b.tabs.liveRuntimes().find((r: { tabId: string }) => r.tabId === active.id).wc.executeJavaScript(source)
    },
    script
  )

/** Focus the active page and a text field in it, as a click would. */
const focusField = (app: ElectronApplication) =>
  inMain(app, (b) => {
    const active = b.tabs.model.activeTab()
    const wc = b.tabs.liveRuntimes().find((r: { tabId: string }) => r.tabId === active.id).wc
    wc.focus()
    return wc.executeJavaScript(`
      if (!document.getElementById('t')) {
        const input = document.createElement('input'); input.id = 't'; document.body.prepend(input)
      }
      document.getElementById('t').focus()
    `)
  })

/** Type into the focused page, through the same path real keys take. */
const type = (app: ElectronApplication, text: string) =>
  inMain(
    app,
    (b, t: string) => {
      const active = b.tabs.model.activeTab()
      const wc = b.tabs.liveRuntimes().find((r: { tabId: string }) => r.tabId === active.id).wc
      for (const ch of t) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      }
    },
    text
  )

async function twoTabs() {
  const { url, server } = await startServer()
  const launched = await launch()
  await rpc(launched.shell, 'tabs.create', { url: `${url}/page/a` })
  await waitForShown(launched.app, `${url}/page/a`)
  await rpc(launched.shell, 'tabs.create', { url: `${url}/page/b` })
  await waitForShown(launched.app, `${url}/page/b`)
  return { ...launched, url, server }
}

test('⌘Z right after closing a tab brings it back, in its place and with its history', async () => {
  const { app, userData, server, url } = await twoTabs()
  try {
    const before = await tabUrls(app)
    await inMain(app, (b) => b.runCommand('tab.close'))
    await expect.poll(() => tabUrls(app)).toEqual(before.filter((u) => u !== `${url}/page/b`))

    await undo(app)
    await expect.poll(() => tabUrls(app)).toEqual(before)
    const s = await state(app)
    expect(s.tabs[s.spaces.find((x) => x.id === s.activeSpaceId)!.activeTabId!]!.url).toBe(`${url}/page/b`)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('⌘Z while typing in a page undoes the text, and reopens nothing', async () => {
  const { app, userData, server } = await twoTabs()
  try {
    await focusField(app)
    await type(app, 'hello')
    await expect.poll(() => inActive(app, 'document.getElementById("t").value')).toBe('hello')
    const before = await tabUrls(app)

    await undo(app)
    await expect.poll(() => inActive(app, 'document.getElementById("t").value')).not.toBe('hello')
    expect(await tabUrls(app)).toEqual(before)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('after a close, the close wins until the user types; then the text does', async () => {
  const { app, userData, server, url } = await twoTabs()
  try {
    // Tab a has a field with text in it.
    await inMain(app, (b) => b.runCommand('tab.prev'))
    await focusField(app)
    await type(app, 'abc')
    await inMain(app, (b) => b.runCommand('tab.next'))

    // Close b: focus lands back on a, field and all. ⌘Z still means "bring b back".
    await inMain(app, (b) => b.runCommand('tab.close'))
    await focusField(app)
    await undo(app)
    await expect.poll(() => tabUrls(app)).toContain(`${url}/page/b`)

    // Close it again, then type in a: now ⌘Z belongs to the text.
    await inMain(app, (b) => b.runCommand('tab.close'))
    await focusField(app)
    await type(app, 'd')
    await expect.poll(() => inActive(app, 'document.getElementById("t").value')).toBe('abcd')
    await undo(app)
    await expect.poll(() => inActive(app, 'document.getElementById("t").value')).not.toBe('abcd')
    expect(await tabUrls(app)).not.toContain(`${url}/page/b`)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('⌘Z after closing the window brings the window back, and only that', async () => {
  const { app, userData, server, url } = await twoTabs()
  try {
    await inMain(app, (b) => b.runCommand('tab.close'))
    const afterClose = await tabUrls(app)
    await inMain(app, (b) => b.runCommand('window.close'))
    await expect.poll(() => inMain(app, (b) => b.window.win.isVisible())).toBe(false)

    await undo(app)
    await expect.poll(() => inMain(app, (b) => b.window.win.isVisible())).toBe(true)
    // The tab closed before the window stays closed: one undo, one step.
    expect(await tabUrls(app)).toEqual(afterClose)
    expect(afterClose).not.toContain(`${url}/page/b`)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('the everyday shortcuts are wired: ⌘Z, ⌘P, ⌘N, ⌘← and ⌘→', async () => {
  const { app, userData } = await launch()
  try {
    const bindings = await inMain(app, (_b, _a, electron) => {
      const out: Record<string, { visible: boolean }> = {}
      const walk = (items: Electron.MenuItem[]) => {
        for (const item of items) {
          if (item.accelerator) out[String(item.accelerator)] = { visible: item.visible }
          if (item.submenu) walk(item.submenu.items)
        }
      }
      walk(electron.Menu.getApplicationMenu()!.items)
      return out
    })
    for (const accelerator of ['Cmd+Z', 'Cmd+P', 'Cmd+N', 'Cmd+Left', 'Cmd+Right']) {
      expect(bindings, accelerator).toHaveProperty(accelerator)
    }
    expect(bindings['Cmd+Z']!.visible).toBe(true)
    expect(bindings['Cmd+P']!.visible).toBe(true)
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
