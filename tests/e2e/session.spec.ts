import { expect, test } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, startServer, state, t, tempDir, waitForShown } from './helpers'

test('spaces, tabs, settings and layout survive a restart', async () => {
  const { url, server } = await startServer()
  const userData = tempDir()
  try {
    // --- first run -----------------------------------------------------------
    let run = await launch(userData)
    const home = (await state(run.app)).activeSpaceId
    const work = await rpc<string>(run.shell, 'spaces.create', { name: 'Work', icon: 'work', color: '#3b82f6' })
    const w1 = await rpc<string>(run.shell, 'tabs.create', { url: `${url}/page/w1` })
    await waitForShown(run.app, '/page/w1')
    await rpc(run.shell, 'tabs.navigate', w1, `${url}/page/w2`)
    await waitForShown(run.app, '/page/w2')
    await rpc(run.shell, 'tabs.create', { url: `${url}/page/pinned`, pinned: true, background: true })

    await rpc(run.shell, 'spaces.activate', home)
    for (const n of ['h1', 'h2']) await rpc(run.shell, 'tabs.create', { url: `${url}/page/${n}` })
    await waitForShown(run.app, '/page/h2')
    await rpc(run.shell, 'spaces.activate', work)
    await waitForShown(run.app, '/page/w2')
    await rpc(run.shell, 'settings.update', { searchEngine: 'duckduckgo', discardAfterMinutes: 15 })
    await rpc(run.shell, 'window.setSidebar', { width: 300 })
    const before = await state(run.app)
    await quit(run.app)

    // --- second run ----------------------------------------------------------
    run = await launch(userData)
    const after = await state(run.app)
    expect(after.spaces.map((s) => s.name)).toEqual(before.spaces.map((s) => s.name))
    expect(after.spaces.map((s) => s.tabIds)).toEqual(before.spaces.map((s) => s.tabIds))
    expect(after.spaces.map((s) => s.pinnedTabIds)).toEqual(before.spaces.map((s) => s.pinnedTabIds))
    expect(after.activeSpaceId).toBe(work)
    for (const id of Object.keys(before.tabs)) {
      expect(after.tabs[id]?.url).toBe(before.tabs[id]?.url)
      expect(after.tabs[id]?.title).toBe(before.tabs[id]?.title)
    }

    // Lazy restore: only the visible tab gets a WebContents.
    await waitForShown(run.app, '/page/w2')
    expect(await inMain(run.app, (b) => b.tabs.liveRuntimes().length)).toBe(1)
    // …and it comes back with its back/forward stack.
    await expect
      .poll(() => inMain(run.app, (b, id: string) => b.tabs.runtime(id)?.wc.navigationHistory.canGoBack(), w1))
      .toBe(true)
    await rpc(run.shell, 'tabs.goBack', w1)
    await waitForShown(run.app, '/page/w1')

    const settings = await inMain(run.app, (b) => b.settings.get())
    expect(settings.searchEngine).toBe('duckduckgo')
    expect(settings.discardAfterMinutes).toBe(15)
    expect(await inMain(run.app, (b) => b.window.getLayout().sidebarWidth)).toBe(300)
    await quit(run.app)
  } finally {
    server.close()
    removeDir(userData)
  }
})

test('a tab woken after a restart shows its page under ⌘T, not a blank card', async () => {
  const { url, server } = await startServer()
  const userData = tempDir()
  let run = await launch(userData)
  try {
    const asleep = await rpc<string>(run.shell, 'tabs.create', { url: `${url}/page/asleep` })
    await waitForShown(run.app, '/page/asleep')
    await rpc(run.shell, 'tabs.create', { url: `${url}/page/front` })
    await waitForShown(run.app, '/page/front')
    await quit(run.app)

    // Restored asleep, then woken by selecting it.
    run = await launch(userData)
    await waitForShown(run.app, '/page/front')
    await rpc(run.shell, 'tabs.activate', asleep)
    await waitForShown(run.app, '/page/asleep')

    // ⌘T raises the shell over the page; with the tab live, the shell draws
    // nothing on the card and the page shows through.
    await inMain(run.app, (b) => b.runCommand('tab.new'))
    await expect(run.shell.getByPlaceholder(t('palette.input.searchPlaceholder'))).toBeVisible()
    await expect(run.shell.locator('[data-card-content]')).toHaveCount(0)
  } finally {
    await quit(run.app)
    server.close()
    removeDir(userData)
  }
})
