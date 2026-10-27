import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { removeDir, ROOT, tempDir } from './helpers'

// Background tabs must be hidden to Chromium, which stops their rAF and
// throttles their timers. Playwright cannot show that: it turns on DevTools
// focus emulation in every page it attaches to, and Chromium counts that as a
// visible capturer, so under `_electron.launch` no page is ever hidden. These
// tests launch the app on their own and drive main through the Node inspector.

interface BareApp {
  /** Like `inMain`: `fn` is serialized and runs in main with the Browser. */
  main<T, A = undefined>(fn: (browser: any, arg: A) => T | Promise<T>, arg?: A): Promise<T>
  close(): Promise<void>
}

async function launchBare(userData: string): Promise<BareApp> {
  const outDir = process.env.ARC_OUT_DIR ? resolve(ROOT, process.env.ARC_OUT_DIR) : null
  const electron = createRequire(import.meta.url)('electron') as string
  const child = spawn(electron, ['--inspect=0', outDir ? join(outDir, 'main', 'index.js') : ROOT], {
    env: { ...process.env, ARC_USER_DATA: userData, ARC_TEST: '1', ...(outDir ? { ARC_OUT_DIR: outDir } : {}) },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const url = await new Promise<string>((done, fail) => {
    let log = ''
    child.stderr!.on('data', (chunk) => {
      log += String(chunk)
      const match = /Debugger listening on (ws:\/\/\S+)/.exec(log)
      if (match) done(match[1]!)
    })
    child.once('exit', () => fail(new Error(`The app exited:\n${log}`)))
  })
  const socket = new WebSocket(url)
  await new Promise((done) => socket.addEventListener('open', done, { once: true }))
  const replies = new Map<number, (message: any) => void>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    replies.get(message.id)?.(message)
    replies.delete(message.id)
  })
  let nextId = 1
  const evaluate = (expression: string) => {
    const id = nextId++
    const params = { expression, awaitPromise: true, returnByValue: true }
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params }))
    return new Promise<any>((done) => replies.set(id, done))
  }
  const app: BareApp = {
    async main(fn, arg) {
      const { result } = await evaluate(`(${fn.toString()})(globalThis.__arc, ${JSON.stringify(arg ?? null)})`)
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value
    },
    async close() {
      const exited = new Promise((done) => (child.exitCode !== null ? done(null) : child.once('exit', done)))
      // An exiting process waits for its inspector client to go first.
      socket.close()
      // Electron quits normally on SIGTERM (before-quit, will-quit).
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((done) => setTimeout(done, 15_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }
  await expect
    .poll(() => app.main(() => (globalThis as any).__arc?.window?.win.isVisible() === true).catch(() => false), { timeout: 20_000 })
    .toBe(true)
  return app
}

/** rAF callbacks a page runs in half a second (a hidden page's timer fires late), and its visibility. */
const FRAMES = `new Promise((resolve) => {
  let frames = 0
  let done = false
  const tick = () => { if (!done) { frames++; requestAnimationFrame(tick) } }
  requestAnimationFrame(tick)
  setTimeout(() => { done = true; resolve({ frames, visibility: document.visibilityState }) }, 500)
})`

const HIDDEN = { frames: 0, visibility: 'hidden' }

const FIXTURE = `<!doctype html><title>Fixture</title>
<button id="count" style="margin:40px;width:120px;height:40px">Count</button>
<script>window.clicks = 0; count.onclick = () => clicks++</script>`

let app: BareApp
let userData: string
let server: Server
let site: string

function frames(tabId: string): Promise<{ frames: number; visibility: string }> {
  return app.main((b, a: { tabId: string; script: string }) => b.tabs.runtime(a.tabId).wc.executeJavaScript(a.script), {
    tabId,
    script: FRAMES
  })
}

async function drawing(tabId: string): Promise<boolean> {
  const f = await frames(tabId)
  return f.visibility === 'visible' && f.frames > 10
}

/** Open a tab from main and wait until it has loaded. */
function open(path: string, background = false): Promise<string> {
  return app.main(
    async (b, a: { url: string; background: boolean }) => {
      const tab = b.tabs.createTab({ url: a.url, background: a.background })
      const wc = b.tabs.runtime(tab.id).wc
      if (wc.isLoading()) await new Promise((done) => wc.once('did-stop-loading', done))
      return tab.id
    },
    { url: `${site}${path}`, background }
  )
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/fixture' ? FIXTURE : `<!doctype html><title>${req.url}</title>${req.url}`)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  userData = tempDir()
  app = await launchBare(userData)
})

test.afterAll(async () => {
  await app?.close()
  removeDir(userData)
  server.close()
})

test('background tabs are hidden and draw nothing; the shown tab draws', async () => {
  const first = await open('/first')
  const background = await open('/background', true)
  const second = await open('/second')

  await expect.poll(() => drawing(second)).toBe(true)
  // Opened in the background and never shown.
  await expect.poll(() => frames(background)).toEqual(HIDDEN)
  // Shown, then switched away from.
  await expect.poll(() => frames(first)).toEqual(HIDDEN)

  await app.main((b, id: string) => b.tabs.activateTab(id), first)
  await expect.poll(() => drawing(first)).toBe(true)
  await expect.poll(() => frames(second)).toEqual(HIDDEN)
})

test('an agent wakes a background tab while it works there, and it sleeps again after', async () => {
  const port = await new Promise<number>((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port
      probe.close(() => done(p))
    })
  })
  const info = await app.main(async (b, p: number) => {
    b.settings.update({ agentEnabled: true, agentPort: p })
    return b.agentInfo()
  }, port)
  expect(info.running).toBe(true)
  let session = ''
  const mcp = async (method: string, params: unknown = {}) => {
    const res = await fetch(info.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${info.token}`,
        ...(session ? { 'Mcp-Session-Id': session } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
    })
    session ||= res.headers.get('mcp-session-id') ?? ''
    const body = await res.json()
    if (body.error) throw new Error(body.error.message)
    return body.result
  }
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp('tools/call', { name, arguments: args })
    const text = result.content.find((c: { type: string }) => c.type === 'text')?.text ?? ''
    if (result.isError) throw new Error(text)
    return { text, result }
  }
  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })

  // A page that has never painted drops input and cannot be captured. (With
  // no tab on screen, a new tab is shown even when opened in the background.)
  await open('/front')
  const tabId = await open('/fixture', true)
  await expect.poll(() => frames(tabId)).toEqual(HIDDEN)

  const { text: snapshot } = await tool('snapshot', { tabId })
  const ref = /button "Count" \[(e\d+)\]/.exec(snapshot)![1]
  await tool('click', { tabId, ref })
  expect((await tool('evaluate', { tabId, script: 'clicks' })).text).toBe('1')
  const { result: shot } = await tool('screenshot', { tabId })
  expect(shot.content[0].type).toBe('image')
  expect(await drawing(tabId)).toBe(true)

  // Left alone, it is a hidden background tab again.
  await expect.poll(() => frames(tabId), { timeout: 10_000 }).toEqual(HIDDEN)
})
