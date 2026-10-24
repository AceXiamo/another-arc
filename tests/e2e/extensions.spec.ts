import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, ROOT, rpc, startServer, tempDir, waitForShown } from './helpers'

const PROBE = join(ROOT, 'tests/fixtures/extensions/api-probe')

/** APIs a typical extension cannot live without; these must pass. */
const REQUIRED = [
  'runtime:getManifest',
  'runtime:onInstalled',
  'runtime:content→sw sendMessage',
  'tabs:sw→content sendMessage',
  'tabs:connect (port)',
  'tabs:query(active)',
  'tabs:get',
  'tabs:create',
  'tabs:onCreated',
  'tabs:onUpdated(complete)',
  'tabs:update(url)',
  'tabs:update(active)+onActivated',
  'tabs:remove+onRemoved',
  'scripting:executeScript(func)',
  'scripting:insertCSS',
  'storage:local',
  'storage:onChanged',
  'storage:session',
  'action:setBadgeText/getBadgeText',
  'action:setTitle/getTitle',
  'webNavigation:onCommitted',
  'webNavigation:onCompleted',
  'contextMenus:create',
  'cookies:set/get',
  'fetch:cross-origin from SW (host permission)'
]

test('API probe: service worker, content script, popup, options and lifecycle', async () => {
  test.setTimeout(180_000)
  const { url, server, reports } = await startServer()
  const userData = tempDir()
  let run = await launch(userData)
  try {
    const ext = await inMain(run.app, (b, path: string) => b.extensions.install(path), PROBE)
    expect(ext.name).toBe('API Probe')
    expect(ext.enabled).toBe(true)
    expect(ext.manifestVersion).toBe(3)

    // Content script + service worker checks.
    await rpc(run.shell, 'tabs.create', { url: `${url}/probe` })
    await waitForShown(run.app, '/probe')
    await expect.poll(() => reports.some((r) => r.kind === 'checks'), { timeout: 90_000 }).toBe(true)
    const results: Array<{ api: string; name: string; ok: boolean; detail: string }> = reports.find(
      (r) => r.kind === 'checks'
    ).results

    const dir = join(ROOT, 'test-reports')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'extension-api-matrix.json'), JSON.stringify(results, null, 2))
    console.log(
      results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.api}.${r.name}${r.detail ? `  (${r.detail})` : ''}`).join('\n')
    )
    const failedRequired = REQUIRED.filter((key) => !results.find((r) => `${r.api}:${r.name}` === key)?.ok)
    expect(failedRequired).toEqual([])

    // The extension's action shows up in the sidebar; clicking opens its popup.
    const actionIcon = run.shell.locator(`img[src*="extension-icon/${ext.id}"]`)
    await expect(actionIcon).toBeVisible()
    await actionIcon.click()
    await expect.poll(() => reports.some((r) => r.kind === 'surface' && r.surface === 'popup'), { timeout: 15_000 }).toBe(true)
    expect(reports.find((r) => r.surface === 'popup').activeUrl).toContain('/probe')
    // The popup is actually on screen and sized to its content.
    const popupBounds = await inMain(run.app, (_b, _a, electron) => {
      const win = electron.BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/popup.html'))
      return win && win.isVisible() ? win.getBounds() : null
    })
    expect(popupBounds?.width).toBeGreaterThan(200)
    expect(popupBounds?.height).toBeGreaterThan(40)

    // Options page opens as a tab and can read extension storage.
    await rpc(run.shell, 'extensions.openOptions', ext.id)
    await expect.poll(() => reports.some((r) => r.kind === 'surface' && r.surface === 'options'), { timeout: 15_000 }).toBe(true)
    expect(reports.find((r) => r.surface === 'options').storageValue).toBe(42)

    // Disable → unloaded; enable → loaded again.
    await rpc(run.shell, 'extensions.setEnabled', ext.id, false)
    expect(await inMain(run.app, (b, id: string) => Boolean(b.extensions['ses'].extensions.getExtension(id)), ext.id)).toBe(false)
    await expect(actionIcon).toHaveCount(0)
    await rpc(run.shell, 'extensions.setEnabled', ext.id, true)
    expect(await inMain(run.app, (b, id: string) => Boolean(b.extensions['ses'].extensions.getExtension(id)), ext.id)).toBe(true)

    // Restart: enabled extensions come back with their id (and data) intact.
    await quit(run.app)
    run = await launch(userData)
    const after = await inMain(run.app, (b) => b.extensions.info())
    expect(after.map((e: { id: string }) => e.id)).toEqual([ext.id])
    expect(await inMain(run.app, (b, id: string) => Boolean(b.extensions['ses'].extensions.getExtension(id)), ext.id)).toBe(true)
    // Extension storage survived the restart.
    const stored = await inMain(
      run.app,
      async (b, id: string, electron) => {
        const win = new electron.BrowserWindow({ show: false, webPreferences: { session: b.extensions['ses'] } })
        await win.loadURL(`chrome-extension://${id}/options.html`)
        const value = await win.webContents.executeJavaScript(`chrome.storage.local.get('probe:value').then(r => r['probe:value'])`)
        win.destroy()
        return value
      },
      ext.id
    )
    expect(stored).toBe(42)

    // Uninstall removes the managed copy.
    const installDir = await inMain(run.app, (b, id: string) => b.extensions['records'].get(id).path, ext.id)
    await inMain(run.app, (b, id: string) => b.extensions.uninstall(id), ext.id)
    expect(await inMain(run.app, (b) => b.extensions.info().length)).toBe(0)
    expect(existsSync(installDir)).toBe(false)
  } finally {
    await quit(run.app)
    server.close()
    removeDir(userData)
  }
})

test('extensions add no preload overhead until one is installed', async () => {
  const { app, userData } = await launch()
  try {
    const preloads = await inMain(app, (b) => b.extensions['ses'].getPreloadScripts().length)
    expect(preloads).toBe(0)
    expect(await inMain(app, (b) => b.extensions.loaded)).toBe(false)
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
