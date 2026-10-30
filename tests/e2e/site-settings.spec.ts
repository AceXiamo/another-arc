import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, t, waitForShown } from './helpers'

const KEY = 'clgm_web_app_settings_hk4e_cn'
const BEFORE = { fpsSetting: 60, compatibleModeSwitch: true }

/** Answer every https request in the profile from here, so the real origins load offline. */
function serveHttps(app: ElectronApplication): Promise<void> {
  return inMain(app, (browser) => {
    browser.profiles
      .defaultSession()
      .protocol.handle('https', () => new Response('<!doctype html><title>page</title>', { headers: { 'content-type': 'text/html' } }))
  })
}

function inPage<T>(app: ElectronApplication, code: string): Promise<T> {
  return inMain(app, (browser, source: string) => browser.window.currentPage.webContents.executeJavaScript(source), code) as Promise<T>
}

function readSettings(app: ElectronApplication): Promise<unknown> {
  return inPage<string | null>(app, `localStorage.getItem(${JSON.stringify(KEY)})`).then((s) => (s ? JSON.parse(s) : null))
}

async function openPanel(app: ElectronApplication, shell: Page): Promise<Page> {
  await shell.getByTitle(t('sidebar.address.siteControls')).click()
  await expect
    .poll(async () => {
      for (const page of app.windows()) if ((await page.title()) === 'sitePanel') return true
      return false
    })
    .toBe(true)
  for (const page of app.windows()) if ((await page.title()) === 'sitePanel') return page
  throw new Error('no site panel')
}

test('a site switch reaches the page before its scripts, and undoes itself', async () => {
  const { app, shell, userData } = await launch()
  try {
    await serveHttps(app)
    await rpc(shell, 'tabs.create', { url: 'https://ys.mihoyo.com/cloud/' })
    await waitForShown(app, 'https://ys.mihoyo.com/cloud/')
    await inPage(app, `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(BEFORE))})`)

    const panel = await openPanel(app, shell)
    const toggle = panel.getByRole('switch', { name: t('sidebar.site.cloudGameLowLatency') })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    // Nothing to reload until something changed.
    await expect(panel.getByRole('button', { name: t('sidebar.site.reloadToApply') })).toHaveCount(0)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await panel.getByRole('button', { name: t('sidebar.site.reloadToApply') }).click()
    await expect
      .poll(() => readSettings(app))
      .toEqual({ fpsSetting: 60, compatibleModeSwitch: false, hevcCodecSwitch: false, wrappedHevcSwitch: true })

    const again = await openPanel(app, shell)
    const on = again.getByRole('switch', { name: t('sidebar.site.cloudGameLowLatency') })
    await expect(on).toHaveAttribute('aria-checked', 'true')
    await on.click()
    await again.getByRole('button', { name: t('sidebar.site.reloadToApply') }).click()
    await expect.poll(() => readSettings(app)).toEqual(BEFORE)
  } finally {
    await quit(app)
    removeDir(userData)
  }
})

test('every other site gets the section without the switch, and is left alone', async () => {
  const { app, shell, userData } = await launch()
  try {
    await serveHttps(app)
    await rpc(shell, 'tabs.create', { url: 'https://example.com/' })
    await waitForShown(app, 'https://example.com/')

    const panel = await openPanel(app, shell)
    await expect(panel.getByText(t('sidebar.site.settings'))).toBeVisible()
    await expect(panel.getByText(t('sidebar.site.settingsEmpty'))).toBeVisible()
    await expect(panel.getByRole('switch')).toHaveCount(0)
    expect(await readSettings(app)).toBeNull()
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
