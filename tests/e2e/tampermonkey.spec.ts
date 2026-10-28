import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
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

const DOWNLOAD_SCRIPT = `// ==UserScript==
// @name         Arc Download Probe
// @namespace    arc.test
// @version      1.0
// @match        http://127.0.0.1/*
// @grant        GM_download
// ==/UserScript==
if (location.pathname === '/dl') {
  const mark = (v) => (document.documentElement.dataset.dl = v);
  GM_download({
    url: location.origin + '/media/photo.jpg',
    name: 'tmd/probe_photo.jpg',
    onload: () => mark('loaded'),
    onerror: (e) => mark('error ' + JSON.stringify(e)),
    ontimeout: () => mark('timeout')
  });
}
`

// Tampermonkey's default download mode uses chrome.downloads whenever it
// exists; the library's was a no-op, so GM_download never finished.
test('Tampermonkey GM_download saves through chrome.downloads', async () => {
  test.setTimeout(120_000)
  const photo = Buffer.from('arc-probe-photo-bytes')
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    if (u.pathname === '/media/photo.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': photo.length })
      return res.end(photo)
    }
    if (u.pathname === '/dl.user.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end(DOWNLOAD_SCRIPT)
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>${u.pathname}</title><h1>${u.pathname}</h1>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const userData = tempDir()
  const downloadDir = tempDir('arc-e2e-dl-')
  const run = await launch(userData)
  try {
    await rpc(run.shell, 'settings.update', { downloadDir })
    const ext = await inMain(run.app, (b, path: string) => b.extensions.install(path), TAMPERMONKEY)
    await rpc(run.shell, 'extensions.setUserScripts', ext.id, true)
    await expect.poll(() => inMain(run.app, (b, id: string) => b.extensions['userScripts'].count(id), ext.id), { timeout: 20_000 }).toBeGreaterThan(0)
    // "downloads" is optional; the user granted it once (as in the real profile).
    await inMain(run.app, (b, id: string) => b.extensions['granted'].get(id).permissions.push('downloads'), ext.id)

    await rpc(run.shell, 'tabs.create', { url: `${url}/dl.user.js` })
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

    await rpc(run.shell, 'tabs.create', { url: `${url}/dl` })
    await waitForShown(run.app, '/dl')
    await expect
      .poll(() => inMain(run.app, (b) => b.tabs.activeRuntime().wc.executeJavaScript('document.documentElement.dataset.dl ?? null')), {
        timeout: 20_000
      })
      .toBe('loaded')
    const saved = join(downloadDir, 'tmd', 'probe_photo.jpg')
    expect(existsSync(saved)).toBe(true)
    expect(readFileSync(saved).equals(photo)).toBe(true)
    // It is an ordinary download: in the list, credited to Tampermonkey.
    const list = await inMain(run.app, (b) => b.downloads.entries().map((e: any) => ({ status: e.state.status, initiator: e.initiator })))
    expect(list).toContainEqual({ status: 'completed', initiator: ext.id })
  } finally {
    await quit(run.app)
    server.close()
    removeDir(userData)
    removeDir(downloadDir)
  }
})
