import { expect, test } from '@playwright/test'
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

const page = (name: string) => `${server.url}/page/${name}`

test('three spaces with ten tabs each switch independently', async () => {
  const { app, shell } = ctx
  const spaceIds: string[] = [(await state(app)).activeSpaceId]
  spaceIds.push(await rpc<string>(shell, 'spaces.create', { name: 'Work', icon: 'work', color: '#3b82f6' }))
  spaceIds.push(await rpc<string>(shell, 'spaces.create', { name: 'Play', icon: 'game', color: '#22c55e' }))

  for (const [s, spaceId] of spaceIds.entries()) {
    for (let i = 0; i < 10; i++) {
      await rpc(shell, 'tabs.create', { url: page(`s${s}-${i}`), spaceId, background: i < 9 })
    }
  }
  const st = await state(app)
  expect(st.spaces.map((s) => s.tabIds.length)).toEqual([10, 10, 10])

  // Each space remembers its own active tab across switches.
  for (const [s, spaceId] of spaceIds.entries()) {
    await rpc(shell, 'spaces.activate', spaceId)
    await waitForShown(app, `/page/s${s}-9`)
  }
  await rpc(shell, 'spaces.activate', spaceIds[0])
  await waitForShown(app, '/page/s0-9')
  // The sidebar only shows the active space.
  await expect(shell.locator('[data-tab-section="tabs"] [data-tab-id]')).toHaveCount(10)
})

test('reorder, pin and move tabs across spaces', async () => {
  const { app, shell } = ctx
  const home = (await state(app)).activeSpaceId
  for (const n of ['a', 'b', 'c']) await rpc(shell, 'tabs.create', { url: page(n) })
  const work = await rpc<string>(shell, 'spaces.create', { name: 'Work', icon: 'work', color: '#3b82f6' })
  await rpc(shell, 'spaces.activate', home)
  let st = await state(app)
  const [a, b, c] = st.spaces[0]!.tabIds as [string, string, string]

  await rpc(shell, 'tabs.move', a, { spaceId: home, pinned: false, index: 2 })
  st = await state(app)
  expect(st.spaces[0]!.tabIds).toEqual([b, c, a])

  await rpc(shell, 'tabs.move', c, { spaceId: home, pinned: true, index: 0 })
  st = await state(app)
  expect(st.spaces[0]!.pinnedTabIds).toEqual([c])
  expect(st.tabs[c]!.pinned).toBe(true)
  await expect(shell.locator('[data-tab-section="pinned"] [data-tab-id]')).toHaveCount(1)

  await rpc(shell, 'tabs.move', b, { spaceId: work, pinned: false, index: 0 })
  st = await state(app)
  expect(st.spaces[1]!.tabIds).toEqual([b])
  expect(st.tabs[b]!.spaceId).toBe(work)
  expect(st.spaces[0]!.tabIds).toEqual([a])
})

test('close, reopen and duplicate keep history', async () => {
  const { app, shell } = ctx
  const id = await rpc<string>(shell, 'tabs.create', { url: page('first') })
  await waitForShown(app, '/page/first')
  await rpc(shell, 'tabs.navigate', id, page('second'))
  await waitForShown(app, '/page/second')

  await rpc(shell, 'tabs.duplicate', id)
  let st = await state(app)
  expect(st.spaces[0]!.tabIds).toHaveLength(2)
  const dup = st.spaces[0]!.tabIds[1]!
  await expect.poll(async () => (await state(app)).tabs[dup]?.url).toContain('/page/second')
  await expect
    .poll(() => inMain(app, (b, tabId: string) => b.tabs.runtime(tabId)?.wc.navigationHistory.canGoBack(), dup))
    .toBe(true)

  await rpc(shell, 'tabs.close', dup)
  await rpc(shell, 'tabs.close', id)
  st = await state(app)
  expect(st.spaces[0]!.tabIds).toHaveLength(0)
  expect(st.shownUrl).toBeNull()

  await rpc(shell, 'tabs.reopenClosed')
  await waitForShown(app, '/page/second')
  const reopened = (await state(app)).spaces[0]!.tabIds[0]!
  await expect
    .poll(() => inMain(app, (b, tabId: string) => b.tabs.runtime(tabId)?.wc.navigationHistory.canGoBack(), reopened))
    .toBe(true)
  // Closed tabs release their WebContents.
  const liveCount = await inMain(app, (b) => b.tabs.liveRuntimes().length)
  expect(liveCount).toBe(1)
})

test('window.open creates an adjacent tab that keeps its opener', async () => {
  const { app, shell } = ctx
  const opener = await rpc<string>(shell, 'tabs.create', { url: page('opener') })
  await waitForShown(app, '/page/opener')
  await inMain(
    app,
    (b, tabId: string) => b.tabs.runtime(tabId).wc.executeJavaScript(`window.open('/page/child'); 1`, true),
    opener
  )
  await waitForShown(app, '/page/child')
  const st = await state(app)
  expect(st.spaces[0]!.tabIds).toHaveLength(2)
  expect(st.spaces[0]!.tabIds[0]).toBe(opener)
  const child = st.spaces[0]!.tabIds[1]!
  const hasOpener = await inMain(
    app,
    (b, tabId: string) => b.tabs.runtime(tabId).wc.executeJavaScript('window.opener !== null'),
    child
  )
  expect(hasOpener).toBe(true)
})

test('background tabs can be discarded and restored with history', async () => {
  const { app, shell } = ctx
  const first = await rpc<string>(shell, 'tabs.create', { url: page('one') })
  await waitForShown(app, '/page/one')
  await rpc(shell, 'tabs.navigate', first, page('two'))
  await waitForShown(app, '/page/two')
  await rpc(shell, 'tabs.create', { url: page('other') })
  await waitForShown(app, '/page/other')

  const discarded = await inMain(app, (b, tabId: string) => b.tabs.discardTab(tabId), first)
  expect(discarded).toBe(true)
  await expect.poll(() => inMain(app, (b) => b.tabs.liveRuntimes().length)).toBe(1)
  expect((await state(app)).tabs[first]!.live).toBe(false)

  await rpc(shell, 'tabs.activate', first)
  await waitForShown(app, '/page/two')
  expect((await state(app)).tabs[first]!.live).toBe(true)
  await expect
    .poll(() => inMain(app, (b, tabId: string) => b.tabs.runtime(tabId)?.wc.navigationHistory.canGoBack(), first))
    .toBe(true)
  await rpc(shell, 'tabs.goBack', first)
  await waitForShown(app, '/page/one')
})

test('deleting a space closes its tabs', async () => {
  const { app, shell } = ctx
  const work = await rpc<string>(shell, 'spaces.create', { name: 'Tmp', icon: 'lab', color: '#ef4444' })
  await rpc(shell, 'tabs.create', { url: page('tmp') })
  await waitForShown(app, '/page/tmp')
  // Skip the native confirmation dialog.
  await inMain(app, (b) => {
    b.confirm = async () => true
  })
  await rpc(shell, 'spaces.delete', work)
  const st = await state(app)
  expect(st.spaces).toHaveLength(1)
  expect(Object.keys(st.tabs)).toHaveLength(0)
  await expect.poll(() => inMain(app, (b) => b.tabs.liveRuntimes().length)).toBe(0)
})
