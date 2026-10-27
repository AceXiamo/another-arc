import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, ROOT, rpc, startServer, tempDir, waitForShown } from './helpers'

const PROBE = join(ROOT, 'tests/fixtures/extensions/user-scripts')

test('chrome.userScripts: the Allow User Scripts toggle, injection, messaging and restarts', async () => {
  test.setTimeout(180_000)
  const { url, server, reports } = await startServer()
  const userData = tempDir()
  let run = await launch(userData)
  const take = async (kind: string, extra: (r: any) => boolean = () => true) => {
    await expect.poll(() => reports.some((r) => r.kind === kind && extra(r)), { timeout: 20_000 }).toBe(true)
    const i = reports.findIndex((r) => r.kind === kind && extra(r))
    return reports.splice(i, 1)[0]
  }
  try {
    const ext = await inMain(run.app, (b, path: string) => b.extensions.install(path), PROBE)
    expect(ext.userScripts).toBe(false)
    // chrome.userScripts lives on chrome.scripting, which the manifest did not ask for.
    const installed = await inMain(run.app, (b, id: string) => b.extensions['records'].get(id).path, ext.id)
    expect(JSON.parse(readFileSync(join(installed, 'manifest.json'), 'utf8')).permissions).toContain('scripting')

    const control = (step: string) => `chrome-extension://${ext.id}/control.html?server=${encodeURIComponent(url)}&step=${step}`

    // Off: the API is absent in pages and in the worker (what managers test for).
    await rpc(run.shell, 'tabs.create', { url: control('state') })
    const off = await take('state')
    expect(off).toMatchObject({ page: 'undefined', sw: 'undefined' })
    // chrome.commands.getAll() reports the bound shortcut.
    expect(off.commands).toEqual([{ name: 'probe-command', description: 'Probe command', shortcut: '⇧⌘Y' }])

    // On: the extension reloads and gets the API.
    await rpc(run.shell, 'extensions.setUserScripts', ext.id, true)
    expect((await inMain(run.app, (b) => b.extensions.info()))[0].userScripts).toBe(true)
    await rpc(run.shell, 'tabs.navigate', (await inMain(run.app, (b) => b.tabs.model.activeTab().id)) as number, control('state'))
    expect(await take('state')).toMatchObject({ page: 'object', sw: 'object' })

    await rpc(run.shell, 'tabs.create', { url: control('register') })
    const registered = await take('registered')
    expect(registered).toMatchObject({
      ids: ['iso', 'main'],
      hasCode: true,
      visibleNative: 0,
      duplicate: "Duplicate script ID 'main'",
      worlds: [{ messaging: true }]
    })
    await rpc(run.shell, 'tabs.create', { url: control('swRegister') })
    expect(await take('sw-registered')).toMatchObject({ ok: true })

    // Isolated world at document_start, messages to onUserScriptMessage
    // (each listener once); the MAIN world script runs in the page's world.
    await rpc(run.shell, 'tabs.create', { url: `${url}/us-target` })
    await waitForShown(run.app, '/us-target')
    const iso = await take('us-message', (r) => r.msg?.kind === 'iso' && r.msg.frame === 'top')
    // The user script world, with the CSP from configureWorld: eval works there.
    expect(iso.msg).toMatchObject({ href: `${url}/us-target`, top: 'number', state: 'loading', eval: 42 })
    expect(iso.tab).toBe('number')
    expect(await take('main', (r) => r.href === `${url}/us-target`)).toMatchObject({ runtime: 'undefined', iso: 'undefined' })
    await take('us-message', (r) => r.msg?.kind === 'from-sw' && r.msg.href === `${url}/us-target`)
    expect(await take('dedupe')).toMatchObject({ calls: 1 })
    await new Promise((r) => setTimeout(r, 300))
    expect(reports.filter((r) => r.kind === 'dedupe')).toEqual([])
    // Subframes have no page preload: the script runs in the isolated world (no eval there).
    await inMain(run.app, (b) =>
      b.tabs.activeRuntime().wc.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<iframe src="/us-target-frame"></iframe>')`)
    )
    expect((await take('us-message', (r) => r.msg?.kind === 'iso' && r.msg.frame === 'sub')).msg).toMatchObject({
      href: `${url}/us-target-frame`,
      top: 'number',
      eval: 'blocked'
    })

    // execute(): one-off code in a tab.
    await rpc(run.shell, 'tabs.create', { url: control('execute') })
    expect(await take('executed')).toMatchObject({ result: 42 })

    // Globs: excluded page gets the MAIN script only.
    await rpc(run.shell, 'tabs.create', { url: `${url}/us-target-nope` })
    await take('main', (r) => r.href === `${url}/us-target-nope`)
    await new Promise((r) => setTimeout(r, 500))
    expect(reports.some((r) => r.kind === 'us-message' && r.msg?.kind === 'iso')).toBe(false)

    // The extension's shortcut fires commands.onCommand.
    const handled = await inMain(run.app, (b) =>
      b.extensions.handleKey({ type: 'keyDown', code: 'KeyY', meta: true, shift: true, control: false, alt: false })
    )
    expect(handled).toBe(true)
    expect(await take('command')).toMatchObject({ name: 'probe-command', tab: 'number' })
    // A new shortcut replaces it; the old one does nothing.
    expect(await rpc(run.shell, 'extensions.setShortcut', ext.id, 'probe-command', 'MacCtrl+Alt+K')).toBe('ok')
    expect(await rpc(run.shell, 'extensions.setShortcut', ext.id, 'probe-command', 'K')).toBe('invalid')
    // ⌘T is the browser's.
    expect(await rpc(run.shell, 'extensions.setShortcut', ext.id, 'probe-command', 'Command+T')).toBe('reserved')
    expect(
      await inMain(run.app, (b) => b.extensions.handleKey({ type: 'keyDown', code: 'KeyY', meta: true, shift: true, control: false, alt: false }))
    ).toBe(false)

    // Restart: Electron forgets dynamic scripts; they come back on start.
    reports.length = 0
    await quit(run.app)
    run = await launch(userData)
    expect((await inMain(run.app, (b) => b.extensions.info()))[0]).toMatchObject({ userScripts: true, commands: [{ shortcut: 'MacCtrl+Alt+K' }] })
    // Launch waits for them, like for content scripts: no sleeping here.
    await rpc(run.shell, 'tabs.create', { url: `${url}/us-target` })
    expect((await take('us-message', (r) => r.msg?.kind === 'iso' && r.msg.frame === 'top')).msg).toMatchObject({ eval: 42 })
    await take('main', (r) => r.href === `${url}/us-target`)

    // Unregister.
    await rpc(run.shell, 'tabs.create', { url: control('unregister') })
    expect(await take('unregistered')).toMatchObject({ ids: ['iso'] })

    // Off again: nothing is injected, the registry stays for next time.
    await rpc(run.shell, 'extensions.setUserScripts', ext.id, false)
    reports.length = 0
    await rpc(run.shell, 'tabs.create', { url: `${url}/us-target` })
    await waitForShown(run.app, '/us-target')
    await new Promise((r) => setTimeout(r, 1500))
    expect(reports.filter((r) => r.kind === 'us-message' || r.kind === 'main')).toEqual([])

    // Uninstall drops the registry.
    await inMain(run.app, (b, id: string) => b.extensions.uninstall(id), ext.id)
    expect(await inMain(run.app, (b, id: string) => b.extensions['userScripts'].count(id), ext.id)).toBe(0)
  } finally {
    await quit(run.app)
    server.close()
    removeDir(userData)
  }
})
