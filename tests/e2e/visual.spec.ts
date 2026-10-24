import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { join } from 'node:path'
import {
  inMain,
  launch,
  LOCALE,
  quit,
  removeDir,
  ROOT,
  rpc,
  screenshot,
  startServer,
  t,
  waitForShown
} from './helpers'

// Captures key UI states for manual review when ARC_SHOT_DIR is set; always
// asserts that each state actually renders.
const SHOTS = process.env.ARC_SHOT_DIR
const PROBE = join(ROOT, 'tests/fixtures/extensions/api-probe')

const shot = async (app: ElectronApplication, name: string) => {
  if (!SHOTS) return
  const shell = app.windows().find((p) => p.url().startsWith('app://shell'))
  await shell?.waitForFunction(() => [...document.images].every((img) => img.complete))
  // Let enter animations (≤200 ms) finish and the frame reach the compositor.
  await shell?.evaluate(
    () => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => r())), 220))
  )
  await screenshot(app, join(SHOTS, `${name}.png`))
}

const setTheme = (shell: Page, theme: 'light' | 'dark' | 'system') => rpc(shell, 'settings.update', { theme })

test('renders palette, find bar, pages and spaces', async () => {
  test.setTimeout(150_000)
  const { url, server } = await startServer()
  const { app, shell, userData } = await launch()
  try {
    await setTheme(shell, 'light')
    await shot(app, 'v-empty')

    for (const name of ['alpha', 'beta', 'gamma', 'delta']) await rpc(shell, 'tabs.create', { url: `${url}/page/${name}` })
    await rpc(shell, 'tabs.create', { url: `${url}/find` })
    await waitForShown(app, '/find')
    const spaceId = (await inMain(app, (b) => b.tabs.model.activeSpaceId)) as string
    const ids = (await shell.locator('[data-tab-section="tabs"] [data-tab-id]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-tab-id')!)
    )) as string[]
    // Two pinned tiles, one asleep tab, one tab playing audio.
    await rpc(shell, 'tabs.move', ids[0], { spaceId, pinned: true, index: 0 })
    await rpc(shell, 'tabs.move', ids[1], { spaceId, pinned: true, index: 1 })
    await expect(shell.locator('[data-tab-section="pinned"] [data-tab-id]')).toHaveCount(2)
    await inMain(app, (b, id: string) => b.tabs.discardTab(id), ids[2])
    await inMain(
      app,
      (b, id: string) => {
        b.shell.tab(id, { audible: true })
        b.shell.flush()
      },
      ids[3]
    )

    // Sidebar with a permission prompt and a toast.
    const findTab = (await inMain(app, (b) => b.tabs.model.activeTab().id)) as string
    await inMain(
      app,
      (b, { tabId, message }: { tabId: string; message: string }) => {
        b.shell.permissionPrompts([
          { id: 'visual-prompt', tabId, origin: 'https://meet.example.com', permission: 'media', details: ['camera', 'microphone'] }
        ])
        b.shell.command({ type: 'toast', message })
      },
      { tabId: findTab, message: t('toast.urlCopied') }
    )
    await expect(shell.getByText(t('sidebar.permission.remember'))).toBeVisible()
    await shell.locator(`[data-tab-id="${ids[3]}"]`).hover()
    await shot(app, 'v-sidebar-light')
    await setTheme(shell, 'dark')
    await shot(app, 'v-sidebar-dark')
    await setTheme(shell, 'light')
    await inMain(app, (b) => {
      b.shell.permissionPrompts([])
      b.shell.flush()
    })
    await shell.mouse.move(700, 400)

    // Command palette (⌘T path through main).
    await inMain(app, (b) => b.runCommand('tab.new'))
    await expect(shell.locator(`input[placeholder="${t('palette.input.searchPlaceholder')}"]`)).toBeFocused()
    await shell.keyboard.type('page')
    await expect(shell.locator('[data-index]').first()).toBeVisible()
    await shot(app, 'v-palette')
    await setTheme(shell, 'dark')
    await shot(app, 'v-palette-dark')
    await setTheme(shell, 'light')
    await shell.keyboard.press('Escape')
    await expect(shell.locator(`input[placeholder="${t('palette.input.searchPlaceholder')}"]`)).toHaveCount(0)

    // Find bar on its floating surface.
    await inMain(app, (b) => b.runCommand('find.open'))
    await expect.poll(() => inMain(app, (b) => b.window.getSurface('find')?.visible === true)).toBe(true)
    await rpc(shell, 'find.update', findTab, 'alpha', true, false)
    await expect.poll(() => inMain(app, (b) => b.tabs.model && b.shell)).toBeTruthy()
    await shot(app, 'v-find')
    await inMain(app, (b) => b.shell.command({ type: 'find.close' }))

    // Error and crash placeholders.
    await rpc(shell, 'tabs.create', { url: 'http://127.0.0.1:1/' })
    await expect(shell.getByRole('heading', { name: t('status.net.title') })).toBeVisible({ timeout: 15_000 })
    await shot(app, 'v-error')
    const crashTab = (await rpc<string>(shell, 'tabs.create', { url: `${url}/page/crash` })) as string
    await waitForShown(app, '/page/crash')
    await inMain(app, (b, id: string) => b.tabs.runtime(id)?.wc.forcefullyCrashRenderer(), crashTab)
    await expect(shell.getByRole('heading', { name: t('status.crash.title') })).toBeVisible({ timeout: 15_000 })
    await setTheme(shell, 'dark')
    await shot(app, 'v-crash-dark')
    await setTheme(shell, 'light')

    // A second space in another color, dark theme.
    await rpc(shell, 'spaces.create', { name: LOCALE === 'zh-CN' ? '工作' : 'Work', icon: 'work', color: '#14b8a6' })
    await setTheme(shell, 'dark')
    await shot(app, 'v-empty-dark')
    await rpc(shell, 'tabs.create', { url: `${url}/page/work` })
    await waitForShown(app, '/page/work')
    await shot(app, 'v-dark-space')
    await setTheme(shell, 'light')

    await rpc(shell, 'tabs.openInternal', 'settings')
    await expect(shell.getByRole('heading', { name: t('page.settings') })).toBeVisible()
    await shot(app, 'v-settings')
    await setTheme(shell, 'dark')
    await expect(shell.getByRole('heading', { name: t('page.settings') })).toBeVisible()
    await shot(app, 'v-settings-dark')
    await setTheme(shell, 'light')

    const ext = (await inMain(app, (b, path: string) => b.extensions.install(path), PROBE)) as { id: string }
    await rpc(shell, 'extensions.setPinned', ext.id, true)
    await rpc(shell, 'tabs.openInternal', 'extensions')
    await expect(shell.getByRole('heading', { name: t('page.extensions') })).toBeVisible()
    await expect(shell.locator(`img[src*="extension-icon/${ext.id}"]`)).toBeVisible()
    // The action stays clickable through its img even when the icon falls back.
    await shell.locator(`img[src*="extension-icon/${ext.id}"]`).click({ trial: true, timeout: 5000 })
    await shot(app, 'v-extensions')
    await setTheme(shell, 'dark')
    await shot(app, 'v-extensions-dark')
    await setTheme(shell, 'light')

    await rpc(shell, 'tabs.openInternal', 'history')
    await expect(shell.getByRole('heading', { name: t('page.history') })).toBeVisible()
    await shot(app, 'v-history')

    await inMain(app, (b) => {
      const now = Date.now()
      const base = { url: 'https://example.com/f', savePath: '/tmp/x', endedAt: null }
      b.shell.download('visual-1', { ...base, id: 'visual-1', filename: 'archive-2026.zip', status: 'progressing', paused: false, receivedBytes: 42_000_000, totalBytes: 96_000_000, startedAt: now }, true)
      b.shell.download('visual-2', { ...base, id: 'visual-2', filename: 'report.pdf', status: 'completed', paused: false, receivedBytes: 1_830_000, totalBytes: 1_830_000, startedAt: now - 1000, endedAt: now }, true)
      b.shell.download('visual-3', { ...base, id: 'visual-3', filename: 'installer.dmg', status: 'cancelled', paused: false, receivedBytes: 0, totalBytes: 0, startedAt: now - 2000 }, true)
      b.shell.flush()
    })
    await rpc(shell, 'tabs.openInternal', 'downloads')
    await expect(shell.getByRole('heading', { name: t('page.downloads') })).toBeVisible()
    await shot(app, 'v-downloads')

    await inMain(app, (b) => b.shell.command({ type: 'space.edit', spaceId: b.tabs.model.activeSpaceId }))
    await expect(shell.getByText(t('sidebar.spaceEditor.titleEdit'))).toBeVisible()
    await shot(app, 'v-space-editor')
    await setTheme(shell, 'dark')
    await shot(app, 'v-space-editor-dark')
    await setTheme(shell, 'light')
    await shell.keyboard.press('Escape')

    await rpc(shell, 'window.setSidebar', { collapsed: true })
    await shot(app, 'v-collapsed')
  } finally {
    await quit(app)
    server.close()
    removeDir(userData)
  }
})
