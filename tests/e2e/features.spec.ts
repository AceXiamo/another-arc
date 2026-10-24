import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, rpc, startServer, state, tempDir, waitForShown, type Launched } from './helpers'

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

const activeTabId = async () => {
  const st = await state(ctx.app)
  return st.spaces.find((s) => s.id === st.activeSpaceId)!.activeTabId!
}

test('downloads land in the configured folder and are tracked', async () => {
  const { app, shell } = ctx
  const dir = tempDir('arc-dl-')
  try {
    await rpc(shell, 'settings.update', { downloadDir: dir })
    await rpc(shell, 'tabs.create', { url: `${server.url}/page/start` })
    await waitForShown(app, '/page/start')
    await inMain(app, (b, url: string) => b.window.currentPage.webContents.downloadURL(url), `${server.url}/download`)
    await expect
      .poll(() => inMain(app, (b) => Object.values(b.downloads.list()).map((d: any) => d.status)))
      .toEqual(['completed'])
    expect(readFileSync(join(dir, 'report.txt'), 'utf8')).toBe('hello download')
    // A second download with the same name gets a unique path.
    await inMain(app, (b, url: string) => b.window.currentPage.webContents.downloadURL(url), `${server.url}/download`)
    await expect.poll(() => existsSync(join(dir, 'report (1).txt'))).toBe(true)
    await expect(shell.locator('button[title^="下载"]')).toBeVisible()
  } finally {
    removeDir(dir)
  }
})

test('find in page reports matches', async () => {
  const { app, shell } = ctx
  await rpc(shell, 'tabs.create', { url: `${server.url}/find` })
  await waitForShown(app, '/find')
  const result = await inMain(app, (b) => {
    const tab = b.tabs.model.activeTab()
    const wc = b.tabs.runtime(tab.id).wc
    return new Promise((resolve) => {
      wc.on('found-in-page', (_e: unknown, r: { finalUpdate: boolean; matches: number }) => r.finalUpdate && resolve(r.matches))
      b.tabs.find(tab.id, 'alpha', true, false)
    })
  })
  expect(result).toBe(3)
})

test('history powers omnibox suggestions', async () => {
  const { app, shell } = ctx
  const id = await rpc<string>(shell, 'tabs.create', { url: `${server.url}/page/alphabet` })
  await waitForShown(app, '/page/alphabet')
  await rpc(shell, 'tabs.navigate', id, `${server.url}/page/zebra`)
  await waitForShown(app, '/page/zebra')
  const hits = await rpc<Array<{ url: string; title: string }>>(shell, 'history.suggest', 'alpha', 8)
  expect(hits.map((h) => h.url)).toContain(`${server.url}/page/alphabet`)
  expect(hits[0]!.title).toBe('Page alphabet')
  const short = await rpc<Array<{ url: string }>>(shell, 'history.suggest', 'ze', 8)
  expect(short.some((h) => h.url.endsWith('/zebra'))).toBe(true)
  const list = await rpc<Array<{ url: string }>>(shell, 'history.list', '', Date.now() + 1000, 50)
  expect(list.length).toBe(2)
})

test('site permissions prompt once and are remembered per origin', async () => {
  const { app, shell } = ctx
  await rpc(shell, 'tabs.create', { url: `${server.url}/page/perm` })
  await waitForShown(app, '/page/perm')
  const ask = () =>
    inMain(app, (b) => b.window.currentPage.webContents.executeJavaScript('Notification.requestPermission()', true))
  const first = ask()
  await expect.poll(() => inMain(app, (b) => b.permissions.prompts().length)).toBe(1)
  await expect(shell.getByText('向你发送通知')).toBeVisible()
  const prompt = (await inMain(app, (b) => b.permissions.prompts()[0])) as { id: string; origin: string }
  expect(prompt.origin).toBe(server.url)
  await rpc(shell, 'permissions.respond', prompt.id, 'allow', true)
  expect(await first).toBe('granted')
  // Remembered: no second prompt.
  expect(await ask()).toBe('granted')
  const saved = await rpc<Array<{ origin: string; permission: string; decision: string }>>(shell, 'permissions.list')
  expect(saved).toEqual([expect.objectContaining({ origin: server.url, permission: 'notifications', decision: 'allow' })])
})

test('a crashed tab shows the crash page and reloads', async () => {
  const { app, shell } = ctx
  await rpc(shell, 'tabs.create', { url: `${server.url}/page/crashy` })
  await waitForShown(app, '/page/crashy')
  const id = await activeTabId()
  await inMain(app, (b) => b.window.currentPage.webContents.forcefullyCrashRenderer())
  await expect.poll(async () => (await inMain(app, (b, t: string) => b.tabs.model.getTab(t).crashed, id))).toBe(true)
  await expect(shell.getByText('页面崩溃了')).toBeVisible()
  expect((await state(app)).shownUrl).toBeNull()
  await rpc(shell, 'tabs.reload', id, false)
  await waitForShown(app, '/page/crashy')
  expect(await inMain(app, (b, t: string) => b.tabs.model.getTab(t).crashed, id)).toBe(false)
})

test('closing a page with unsaved changes asks first', async () => {
  const { app, shell } = ctx
  const id = await rpc<string>(shell, 'tabs.create', { url: `${server.url}/beforeunload` })
  await waitForShown(app, '/beforeunload')
  // beforeunload only counts after a user gesture on the page.
  await inMain(app, (b) => b.window.currentPage.webContents.executeJavaScript(`document.getElementById('i').focus(); 1`, true))
  await inMain(app, (b) => {
    b.tabs['delegate'].confirmLeave = async () => false
  })
  await rpc(shell, 'tabs.close', id)
  // User chose to stay: the tab comes back with the same page.
  await expect.poll(async () => Boolean((await state(app)).tabs[id])).toBe(true)
  await waitForShown(app, '/beforeunload')
  await inMain(app, (b) => {
    b.tabs['delegate'].confirmLeave = async () => true
  })
  await rpc(shell, 'tabs.close', id)
  await expect.poll(async () => Boolean((await state(app)).tabs[id])).toBe(false)
  await expect.poll(() => inMain(app, (b) => b.tabs.liveRuntimes().length)).toBe(0)
})

test('certificate errors block the page until the user proceeds', async () => {
  const { app, shell } = ctx
  const dir = tempDir('arc-tls-')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')
  ], { stdio: 'ignore' })
  const https = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>Self signed</title>ok')
  })
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', r))
  const url = `https://127.0.0.1:${(https.address() as AddressInfo).port}/`
  try {
    const id = await rpc<string>(shell, 'tabs.create', { url })
    await expect.poll(async () => (await inMain(app, (b, t: string) => b.tabs.model.getTab(t).error?.kind, id))).toBe('certificate')
    await expect(shell.getByText('你的连接不是私密连接')).toBeVisible()
    expect((await state(app)).shownUrl).toBeNull()
    await rpc(shell, 'tabs.allowCertificate', id)
    await waitForShown(app, url)
    await expect.poll(async () => (await state(app)).tabs[id]?.title).toBe('Self signed')
  } finally {
    https.close()
    removeDir(dir)
  }
})

test('zoom is remembered per site', async () => {
  const { app, shell } = ctx
  const id = await rpc<string>(shell, 'tabs.create', { url: `${server.url}/page/zoom1` })
  await waitForShown(app, '/page/zoom1')
  await rpc(shell, 'zoom.adjust', id, 1)
  await expect.poll(async () => inMain(app, (b, t: string) => b.tabs.model.getTab(t).zoomFactor, id)).toBe(1.1)
  const other = await rpc<string>(shell, 'tabs.create', { url: `${server.url}/page/zoom2` })
  await waitForShown(app, '/page/zoom2')
  await expect.poll(async () => inMain(app, (b, t: string) => b.tabs.runtime(t).wc.getZoomFactor(), other)).toBeCloseTo(1.1)
  await rpc(shell, 'zoom.adjust', other, 0)
  await expect.poll(async () => inMain(app, (b, t: string) => b.tabs.runtime(t).wc.getZoomFactor(), other)).toBeCloseTo(1)
})
