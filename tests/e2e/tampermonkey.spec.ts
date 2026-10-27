import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inMain, launch, quit, removeDir, rpc, tempDir, waitForShown } from './helpers'

// Real Tampermonkey (MV3) on chrome.userScripts. Opt-in: point
// ARC_TAMPERMONKEY_DIR at an unpacked copy (e.g. a Chromium profile's
// Extensions/dhdgffkkebhmkfjojejmpbldmpobfkfo/<version> folder).
const TAMPERMONKEY = process.env.ARC_TAMPERMONKEY_DIR

const SCRIPT = `// ==UserScript==
// @name         Arc Probe
// @namespace    arc.test
// @version      1.0
// @match        http://127.0.0.1/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==
GM_setValue('n', (GM_getValue('n', 0) || 0) + 1);
document.documentElement.dataset.tm = 'ran-' + GM_getValue('n', 0);
GM_xmlhttpRequest({ method: 'GET', url: location.origin + '/hit?from=' + location.pathname });
`

test.skip(!TAMPERMONKEY, 'set ARC_TAMPERMONKEY_DIR to run Tampermonkey')

test('Tampermonkey installs and runs a user script (default "UserScripts API" mode)', async () => {
  test.setTimeout(120_000)
  const hits: string[] = []
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (u.pathname === '/hit') {
      hits.push(u.searchParams.get('from') ?? '')
      res.writeHead(204, { 'access-control-allow-origin': '*' })
      return res.end()
    }
    if (u.pathname === '/probe.user.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end(SCRIPT)
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>${u.pathname}</title><h1>${u.pathname}</h1>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const userData = tempDir()
  const run = await launch(userData)
  try {
    const ext = await inMain(run.app, (b, path: string) => b.extensions.install(path), TAMPERMONKEY)
    expect(ext.userScripts).toBe(false)
    await rpc(run.shell, 'extensions.setUserScripts', ext.id, true)
    // Ready once it has registered its own content scripts.
    await expect.poll(() => inMain(run.app, (b, id: string) => b.extensions['userScripts'].count(id), ext.id), { timeout: 20_000 }).toBeGreaterThan(0)

    // Opening a .user.js shows Tampermonkey's install page; press Install.
    await rpc(run.shell, 'tabs.create', { url: `${url}/probe.user.js` })
    const installed = await inMain(run.app, async (b) => {
      for (let i = 0; i < 100; i++) {
        const ask = b.tabs.liveRuntimes().find((rt: any) => rt.wc.getURL().includes('/ask.html'))
        if (!ask) {
          await new Promise((r) => setTimeout(r, 200))
          continue
        }
        if (ask.wc.isDestroyed()) return true
        const clicked = await ask.wc
          .executeJavaScript(
            `(() => { const b = [...document.querySelectorAll('input[type=button],button')].find((x) => x.offsetParent && /^(Install|安装)$/i.test((x.value || x.textContent).trim())); b?.click(); return !!b })()`,
            true
          )
          .catch(() => true)
        if (clicked) return true
        await new Promise((r) => setTimeout(r, 200))
      }
      return false
    })
    expect(installed).toBe(true)

    // The script runs (GM storage carries over between pages) and its
    // GM_xmlhttpRequest goes out.
    for (const [path, mark] of [
      ['/a', 'ran-1'],
      ['/b', 'ran-2']
    ] as const) {
      await rpc(run.shell, 'tabs.create', { url: `${url}${path}` })
      await waitForShown(run.app, path)
      await expect
        .poll(() => inMain(run.app, (b) => b.tabs.activeRuntime().wc.executeJavaScript('document.documentElement.dataset.tm ?? null')), {
          timeout: 15_000
        })
        .toBe(mark)
    }
    await expect.poll(() => hits, { timeout: 10_000 }).toEqual(expect.arrayContaining(['/a', '/b']))
    expect(await inMain(run.app, (b, id: string) => b.extensions.errorsOf(id), ext.id)).toEqual([])
  } finally {
    await quit(run.app)
    server.close()
    removeDir(userData)
  }
})
