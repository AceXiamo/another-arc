import { expect, test, type ElectronApplication } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, startServer, state, waitForShown, type Launched } from './helpers'

let server: Awaited<ReturnType<typeof startServer>>
let ctx: Launched

test.beforeAll(async () => {
  server = await startServer()
})
test.afterAll(() => server.server.close())
test.beforeEach(async () => {
  ctx = await launch()
})
test.afterEach(async () => {
  await quit(ctx.app)
  removeDir(ctx.userData)
})

type Key = { code: string; key: string; meta?: boolean; shift?: boolean; control?: boolean; alt?: boolean }

/**
 * Send a key press through Electron's native input path (`sendInputEvent`),
 * the same pipeline a physical keyboard takes past `before-input-event`.
 * (CDP-injected keys bypass that hook, so they cannot be used here.)
 */
async function press(app: ElectronApplication, k: Key): Promise<void> {
  await inMain(
    app,
    async (b, key: Key) => {
      const wc = b.window.currentPage?.webContents ?? b.window.shellContents
      const modifiers: string[] = []
      if (key.meta) modifiers.push('meta')
      if (key.shift) modifiers.push('shift')
      if (key.control) modifiers.push('control')
      if (key.alt) modifiers.push('alt')
      wc.sendInputEvent({ type: 'keyDown', keyCode: key.key, modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode: key.key, modifiers })
      await new Promise((r) => setTimeout(r, 50))
    },
    k
  )
}

const cmd = (code: string, key: string, extra: Partial<Key> = {}): Key => ({ code, key, meta: true, ...extra })

test('reserved shortcuts beat the page', async () => {
  const { app, shell } = ctx
  for (const n of ['a', 'b', 'c']) await rpc(shell, 'tabs.create', { url: `${server.url}/page/${n}` })
  await rpc(shell, 'tabs.navigate', (await state(app)).spaces[0]!.tabIds[2]!, `${server.url}/keys`)
  await waitForShown(app, '/keys')

  // ⌘1 / ⌘9 / Ctrl+Tab
  await press(app, cmd('Digit1', '1'))
  await waitForShown(app, '/page/a')
  await press(app, cmd('Digit9', '9'))
  await waitForShown(app, '/keys')
  await press(app, { code: 'Tab', key: 'Tab', control: true })
  await waitForShown(app, '/page/a')
  await press(app, { code: 'Tab', key: 'Tab', control: true, shift: true })
  await waitForShown(app, '/keys')
  // The page never saw any of them.
  const seen = await inMain(app, (b) => b.window.currentPage.webContents.executeJavaScript('window.__keys.length'))
  expect(seen).toBe(0)

  // ⌘W closes, ⌘⇧T reopens.
  await press(app, cmd('KeyW', 'w'))
  await expect.poll(async () => (await state(app)).spaces[0]!.tabIds.length).toBe(2)
  await press(app, cmd('KeyT', 't', { shift: true }))
  await expect.poll(async () => (await state(app)).spaces[0]!.tabIds.length).toBe(3)

  // ⌘T opens the palette in the shell, focused.
  await press(app, cmd('KeyT', 't'))
  const input = shell.locator('input[placeholder="搜索或输入网址"]')
  await expect(input).toBeFocused()
  expect(await inMain(app, (b) => b.window.isOverlayOpen)).toBe(true)
  await shell.keyboard.type(`${server.url}/page/typed`)
  await shell.keyboard.press('Enter')
  await waitForShown(app, '/page/typed')
  expect(await inMain(app, (b) => b.window.isOverlayOpen)).toBe(false)

  // ⌘L edits the current URL.
  await press(app, cmd('KeyL', 'l'))
  const edit = shell.locator('input[placeholder="输入网址或搜索"]')
  await expect(edit).toBeFocused()
  await expect(edit).toHaveValue(/\/page\/typed/)
  await shell.keyboard.press('Escape')
  await expect(edit).toHaveCount(0)
})

test('space shortcuts cycle spaces', async () => {
  const { app, shell } = ctx
  const first = (await state(app)).activeSpaceId
  const second = await rpc<string>(shell, 'spaces.create', { name: 'Two', icon: 'star', color: '#3b82f6' })
  await rpc(shell, 'tabs.create', { url: `${server.url}/page/two` })
  await waitForShown(app, '/page/two')
  await press(app, cmd('BracketLeft', '[', { shift: true }))
  await expect.poll(async () => (await state(app)).activeSpaceId).toBe(first)
  await press(app, cmd('BracketRight', ']', { shift: true }))
  await expect.poll(async () => (await state(app)).activeSpaceId).toBe(second)
})

test('pages may claim non-reserved shortcuts such as ⌘F', async () => {
  const { app, shell } = ctx
  await rpc(shell, 'tabs.create', { url: `${server.url}/keys` })
  await waitForShown(app, '/keys')
  await press(app, cmd('KeyF', 'f'))
  const seen = await inMain(app, (b) => b.window.currentPage.webContents.executeJavaScript('window.__keys'))
  expect(seen).toContain('Meta+f')
})
