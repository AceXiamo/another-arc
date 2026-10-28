import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { isLocale, type Locale, translator } from '../../src/shared/i18n'

export const ROOT = resolve(import.meta.dirname, '../..')

/** UI language the harness runs in (see `launch`). */
export const LOCALE: Locale = isLocale(process.env.ARC_TEST_LOCALE) ? process.env.ARC_TEST_LOCALE : 'zh-CN'
/** Translates in LOCALE, so selectors work whichever language a run uses. */
export const t = translator(LOCALE)

export interface Launched {
  app: ElectronApplication
  shell: Page
  userData: string
}

export function tempDir(prefix = 'arc-e2e-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/**
 * Launch the built app against an isolated profile directory. The app defaults
 * to English; the harness switches to `locale` (ARC_TEST_LOCALE, else zh-CN,
 * which older specs' literal selectors expect) unless it is null.
 */
export async function launch(
  userData = tempDir(),
  extraEnv: Record<string, string> = {},
  locale: Locale | null = LOCALE
): Promise<Launched> {
  // With ARC_OUT_DIR, launch that build's entry directly (parallel workers).
  const outDir = process.env.ARC_OUT_DIR ? resolve(ROOT, process.env.ARC_OUT_DIR) : null
  if (outDir) extraEnv = { ARC_OUT_DIR: outDir, ...extraEnv }
  const app = await electron.launch({
    args: [outDir ? join(outDir, 'main', 'index.js') : ROOT],
    env: { ...process.env, ARC_USER_DATA: userData, ARC_TEST: '1', ...extraEnv } as Record<string, string>
  })
  const shell = await findShell(app)
  await shell.waitForFunction(() => document.querySelector('aside') !== null)
  if (locale) {
    await rpc(shell, 'settings.update', { language: locale })
    await shell.waitForFunction((l) => document.documentElement.lang === l, locale)
  }
  return { app, shell, userData }
}

async function findShell(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const page = app.windows().find((p) => p.url().startsWith('app://shell'))
    if (page) return page
    await app.waitForEvent('window', { timeout: 2000 }).catch(() => undefined)
  }
  throw new Error('Shell window did not appear')
}

/** Quit cleanly (runs the same before-quit / will-quit path as Cmd+Q). */
export async function quit(app: ElectronApplication): Promise<void> {
  await app
    .evaluate(({ app: electronApp }) => {
      setTimeout(() => electronApp.quit(), 0)
    })
    .catch(() => undefined)
  await app.waitForEvent('close', { timeout: 15_000 }).catch(() => undefined)
}

/** Call a ShellRpc method from inside the shell, exactly as the UI does. */
export async function rpc<T = unknown>(shell: Page, method: string, ...args: unknown[]): Promise<T> {
  return shell.evaluate(
    ([m, a]) => (window as unknown as { arc: { invoke: (m: string, ...a: unknown[]) => Promise<unknown> } }).arc.invoke(m, ...a),
    [method, args] as const
  ) as Promise<T>
}

/**
 * Evaluate inside the main process with access to the Browser instance and
 * the electron module. The function is serialized, so it must be
 * self-contained (use `process.getBuiltinModule` for Node modules).
 */
export async function inMain<T, A = undefined>(
  app: ElectronApplication,
  fn: (browser: any, arg: A, electron: typeof import('electron')) => T | Promise<T>,
  arg?: A
): Promise<T> {
  return app.evaluate(
    (electronModule, [source, a]) => {
      const browser = (globalThis as { __arc?: unknown }).__arc
      return new Function('browser', 'arg', 'electron', `return (${source})(browser, arg, electron)`)(
        browser,
        a,
        electronModule
      )
    },
    [fn.toString(), arg] as const
  ) as Promise<T>
}

export interface BrowserSnapshot {
  activeSpaceId: string
  spaces: Array<{
    id: string
    name: string
    tabIds: string[]
    pinnedTabIds: string[]
    savedIds: string[]
    activeTabId: string | null
  }>
  tabs: Record<
    string,
    {
      url: string
      title: string
      live: boolean
      pinned: boolean
      spaceId: string
      folderId: string | null
      savedUrl: string
      savedTitle: string
    }
  >
  folders: Record<string, { name: string; parentId: string | null; collapsed: boolean; childIds: string[]; spaceId: string }>
  shownUrl: string | null
}

export function state(app: ElectronApplication): Promise<BrowserSnapshot> {
  return inMain(app, (b) => {
    const m = b.tabs.model
    const tabs: Record<string, unknown> = {}
    for (const t of m.tabs.values()) {
      const { url, title, live, pinned, spaceId, folderId, savedUrl, savedTitle } = t
      tabs[t.id] = { url, title, live, pinned, spaceId, folderId, savedUrl, savedTitle }
    }
    const folders: Record<string, unknown> = {}
    for (const f of m.folders.values()) {
      folders[f.id] = { name: f.name, parentId: f.parentId, collapsed: f.collapsed, childIds: [...f.childIds], spaceId: f.spaceId }
    }
    const page = b.window.currentPage
    return {
      activeSpaceId: m.activeSpaceId,
      spaces: m.spaceOrder.map((id: string) => {
        const s = m.getSpace(id)
        return {
          id,
          name: s.name,
          tabIds: [...s.tabIds],
          pinnedTabIds: [...s.pinnedTabIds],
          savedIds: [...s.savedIds],
          activeTabId: s.activeTabId
        }
      }),
      tabs,
      folders,
      shownUrl: page ? page.webContents.getURL() : null
    }
  }) as Promise<BrowserSnapshot>
}

/** Wait until the shown page has finished loading `url` (prefix match). */
export async function waitForShown(app: ElectronApplication, urlPrefix: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => (await state(app)).shownUrl ?? '', { timeout })
    .toContain(urlPrefix)
}

/**
 * Composite screenshot of the window: shell + page view (+ surfaces) in their
 * real z-order, rendered in an offscreen window. macOS screen capture needs a
 * permission CI does not have; this needs none.
 */
export async function screenshot(app: ElectronApplication, path: string): Promise<void> {
  await inMain(
    app,
    async (b, out: string, { BrowserWindow }) => {
      const fs = process.getBuiltinModule('node:fs')
      const os = process.getBuiltinModule('node:os')
      const p = process.getBuiltinModule('node:path')
      const w = b.window
      const size = w.win.getContentBounds()
      const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'arc-shot-'))
      const layers: string[] = []
      const children = w.win.contentView.children
      let i = 0
      for (const view of children) {
        if (!view.webContents) continue
        const r = view.getBounds()
        const img = await view.webContents.capturePage()
        const file = p.join(dir, `${i++}.png`)
        fs.writeFileSync(file, img.toPNG())
        const radius = view === w.currentPage ? 10 : 0
        layers.push(
          `<img src="file://${file}" style="position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border-radius:${radius}px">`
        )
      }
      const html = p.join(dir, 'index.html')
      fs.writeFileSync(html, `<body style="margin:0;background:#888;overflow:hidden">${layers.join('')}</body>`)
      const off = new BrowserWindow({ show: false, width: size.width, height: size.height, webPreferences: { offscreen: true } })
      await off.loadFile(html)
      await new Promise((r) => setTimeout(r, 150))
      const shot = await off.webContents.capturePage()
      fs.writeFileSync(out, shot.toPNG())
      off.destroy()
      fs.rmSync(dir, { recursive: true, force: true })
    },
    path
  )
}

/** Small HTTP server with deterministic test pages. */
export async function startServer(): Promise<{ url: string; server: Server; reports: any[] }> {
  const reports: any[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/report') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          reports.push(JSON.parse(body))
        } catch {
          reports.push({ kind: 'invalid', body })
        }
        res.writeHead(204, { 'access-control-allow-origin': '*' })
        res.end()
      })
      return
    }
    const page = (title: string, body = '') => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><title>${title}</title><body style="font:16px system-ui;padding:24px">${body || title}</body>`)
    }
    switch (url.pathname) {
      case '/login':
        return page(
          'Sign in',
          '<form id="f"><input id="u" name="user" type="text" autocomplete="username">' +
            '<input id="p" name="pw" type="password" autocomplete="current-password">' +
            '<button type="submit">Sign in</button></form>'
        )
      case '/login-captcha':
        // Nothing hints which field is which, a honeypot hides between them,
        // and a captcha box follows the password.
        return page(
          'Sign in',
          '<form id="f"><input id="u" type="text" autocomplete="off">' +
            '<input id="h" type="text" style="display:none">' +
            '<input id="p" type="password" autocomplete="off">' +
            '<input id="c" type="text" autocomplete="off">' +
            '<button type="submit">Sign in</button></form>'
        )
      case '/favicon.ico':
        res.writeHead(200, { 'content-type': 'image/svg+xml' })
        res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#e33"/></svg>')
        return
      case '/download':
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.txt"'
        })
        res.end('hello download')
        return
      case '/beforeunload':
        return page(
          'Unsaved',
          `<input id=i><script>addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = '' })</script>`
        )
      case '/opener':
        return page('Opener', `<a id=a href="/page/child" target="_blank">open child</a>`)
      case '/probe':
        return page('Probe', 'API probe target')
      case '/blocked-by-dnr':
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('not blocked')
        return
      case '/data.json':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ hello: 'world', items: [1, 2, 3], nested: { ok: true } }))
        return
      case '/ads':
        return page(
          'Ads',
          `<div class="adsbygoogle" id="g">google ad slot</div><div class="ad-banner" id="b">banner</div><p id="c">content</p>`
        )
      case '/find':
        return page('Find', 'alpha beta alpha gamma alpha')
      case '/keys':
        return page(
          'Keys',
          `<script>window.__keys=[];addEventListener('keydown',e=>{window.__keys.push((e.metaKey?'Meta+':'')+e.key);if(e.key==='f'&&e.metaKey)e.preventDefault()})</script>`
        )
      default: {
        const name = url.pathname.split('/').pop() || 'home'
        return page(`Page ${name}`, `<h1>Page ${name}</h1><p>${'lorem ipsum '.repeat(40)}</p>`)
      }
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server, reports }
}
