import { expect, test } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, rpc, startServer, waitForShown } from './helpers'

// Compatibility survey for real-world extensions. Opt-in: point
// ARC_REAL_EXT_DIR at a folder of unpacked extensions (one per sub-folder)
// and ARC_REAL_EXT_OUT at a folder for the report and screenshots of what the
// action opens (popup-, panel- or tab-<id>.png). ARC_REAL_EXT_ONLY limits the
// run to a comma-separated list of sub-folders.
const SOURCE = process.env.ARC_REAL_EXT_DIR
const OUT = process.env.ARC_REAL_EXT_OUT ?? join(process.cwd(), 'test-reports', 'real-extensions')

interface Row {
  folder: string
  id?: string
  name?: string
  version?: string
  mv?: number
  install: 'ok' | string
  background: 'running' | 'not-running' | 'n/a'
  popup: 'rendered' | 'empty' | 'no-popup' | 'not-opened' | string
  /** Side panel opened through chrome.sidePanel.open(), when the click opened a tab. */
  panel?: string
  functional?: string
  errors: string[]
}

/** Functional checks for extensions where we know what success looks like. */
const FUNCTIONAL: Record<string, { path: string; check: string; expect: unknown; label: string }> = {
  // uBlock Origin: generic cosmetic filters hide `.adsbygoogle`.
  cjpalhdlnbpafiamejdnhcphjbkeiagm: {
    path: '/ads',
    check: `getComputedStyle(document.getElementById('g')).display`,
    expect: 'none',
    label: 'cosmetic filter hides .adsbygoogle'
  },
  // JSON Formatter replaces the raw <pre> with its own viewer.
  bcjindcccaagfpapjjmafapmmgkkhgoa: {
    path: '/data.json',
    check: `document.body.children.length > 1 || !document.querySelector('body > pre') || document.querySelector('body > pre').offsetParent === null`,
    expect: true,
    label: 'formats application/json'
  }
}

test.skip(!SOURCE, 'set ARC_REAL_EXT_DIR to run the real-extension survey')

test('real-world extension compatibility survey', async () => {
  test.setTimeout(30 * 60_000)
  mkdirSync(OUT, { recursive: true })
  const { url, server } = await startServer()
  const rows: Row[] = []
  try {
    const only = process.env.ARC_REAL_EXT_ONLY?.split(',').filter(Boolean)
    for (const folder of readdirSync(SOURCE!).sort()) {
      if (only && !only.includes(folder)) continue
      const dir = join(SOURCE!, folder)
      let manifest: Record<string, any> = {}
      try {
        manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, ''))
      } catch {
        continue
      }
      const row: Row = { folder, mv: manifest.manifest_version, install: 'ok', background: 'n/a', popup: 'no-popup', errors: [] }
      rows.push(row)
      const { app, shell, userData } = await launch()
      try {
        // Collect console errors from service workers / background pages.
        await inMain(app, (b, _arg, electron) => {
          const errors: string[] = []
          ;(globalThis as any).__extErrors = errors
          const ses = b.extensions['ses']
          ses.serviceWorkers.on('console-message', (_e: unknown, d: { level: number; message: string; sourceUrl: string }) => {
            if (d.level >= 3 || /error/i.test(String((d as any).level))) errors.push(`[sw] ${d.message}`.slice(0, 300))
          })
          const { webContents } = electron
          ;(globalThis as any).__watchContents = () => {
            for (const wc of webContents.getAllWebContents()) {
              if ((wc as any).__watched || !wc.getURL().startsWith('chrome-extension://')) continue
              ;(wc as any).__watched = true
              wc.on('console-message', (e: any) => {
                if (e.level === 'error') errors.push(`[${wc.getType()}] ${e.message}`.slice(0, 300))
              })
            }
          }
        })

        let info: { id: string; name: string; version: string; hasAction: boolean }
        try {
          info = await inMain(app, (b, path: string) => b.extensions.install(path), dir)
        } catch (error) {
          row.install = String((error as Error).message ?? error).replace(/^Error invoking remote method.*?: /, '').slice(0, 300)
          continue
        }
        Object.assign(row, { id: info.id, name: info.name, version: info.version })

        // Give the background a moment, then load a page so content scripts run.
        // Extensions may open their own welcome tab on install (onInstalled);
        // bring our page back to the front before checking anything.
        const survey = await rpc<string>(shell, 'tabs.create', { url: `${url}/page/survey` })
        await new Promise((r) => setTimeout(r, 800))
        await rpc(shell, 'tabs.activate', survey)
        await waitForShown(app, '/page/survey')
        await new Promise((r) => setTimeout(r, 2500))
        await inMain(app, () => (globalThis as any).__watchContents())

        row.background = await inMain(
          app,
          async (b, id: string, electron) => {
            const ses = b.extensions['ses']
            const ext = ses.extensions.getExtension(id)
            const mv = ext?.manifest?.manifest_version
            if (mv === 2) {
              return electron.webContents.getAllWebContents().some((wc: any) => wc.getType() === 'backgroundPage' && wc.getURL().startsWith(`chrome-extension://${id}`))
                ? 'running'
                : ext?.manifest?.background
                  ? 'not-running'
                  : 'n/a'
            }
            if (!ext?.manifest?.background?.service_worker) return 'n/a'
            const running = Object.values(ses.serviceWorkers.getAllRunning()) as Array<{ scope: string }>
            return running.some((w) => w.scope.startsWith(`chrome-extension://${id}`)) ? 'running' : 'not-running'
          },
          info.id
        )

        // Functional check, if we have one.
        const fn = FUNCTIONAL[info.id]
        if (fn) {
          const tab = await rpc<string>(shell, 'tabs.create', { url: url + fn.path })
          await rpc(shell, 'tabs.activate', tab)
          await waitForShown(app, fn.path)
          await new Promise((r) => setTimeout(r, 3000))
          const got = await inMain(app, (b, code: string) => b.window.currentPage.webContents.executeJavaScript(code), fn.check)
          row.functional = `${fn.label}: ${JSON.stringify(got) === JSON.stringify(fn.expect) ? 'PASS' : `FAIL (got ${JSON.stringify(got)})`}`
        }

        // Action: click it like a user would and inspect what opens: a popup
        // or side panel in an extension window, or (action.onClicked) a tab
        // of the extension's own.
        await rpc(shell, 'tabs.activate', survey)
        const action = manifest.manifest_version === 3 ? manifest.action : (manifest.browser_action ?? manifest.page_action)
        if (action) {
          const icon = shell.locator(`img[src*="extension-icon/${info.id}"]`)
          if ((await icon.count()) === 0) {
            row.popup = 'not-opened (no action button)'
          } else {
            const tabsBefore = await inMain(app, (b) => [...b.tabs.model.tabs.keys()] as string[])
            const activeBefore = await inMain(app, (b) => (b.tabs.model.activeTab()?.id ?? null) as string | null)
            await icon.first().click()
            row.popup = await inMain(
              app,
              async (b, arg: { id: string; out: string; tabsBefore: string[]; activeBefore: string | null }, electron) => {
                const fs = process.getBuiltinModule('node:fs')
                const p = process.getBuiltinModule('node:path')
                const prefix = `chrome-extension://${arg.id}/`
                const deadline = Date.now() + 10_000
                let win: any = null
                let tabId: string | undefined
                while (Date.now() < deadline && !win && !tabId) {
                  const w = b.extensions['windows'].get(arg.id)
                  if (w && !w.destroyed && w.win.isVisible()) win = w
                  // A new tab of the extension's own, or one it brought to the front.
                  tabId = [...b.tabs.model.tabs.values()].find(
                    (t: any) => !arg.tabsBefore.includes(t.id) && String(t.url).startsWith(prefix)
                  )?.id
                  const active = b.tabs.model.activeTab()
                  if (!tabId && active && active.id !== arg.activeBefore && String(active.url).startsWith(prefix)) tabId = active.id
                  if (!win && !tabId) await new Promise((r) => setTimeout(r, 200))
                }
                ;(globalThis as any).__watchContents()
                let closedItself = ''
                if (win) {
                  await new Promise((r) => setTimeout(r, 3000))
                  if (win.destroyed) {
                    // e.g. a wallet popup that hands over to its onboarding tab.
                    closedItself = `${win.surface} opened and closed itself; `
                    win = null
                    tabId = [...b.tabs.model.tabs.values()].find(
                      (t: any) => !arg.tabsBefore.includes(t.id) && String(t.url).startsWith(prefix)
                    )?.id
                  }
                }
                if (win) {
                  const wc = win.webContents
                  const size = await wc.executeJavaScript(
                    `({ text: (document.body?.innerText || '').trim().length, nodes: document.querySelectorAll('body *').length })`
                  )
                  fs.writeFileSync(p.join(arg.out, `${win.surface}-${arg.id}.png`), (await wc.capturePage()).toPNG())
                  const before = win.win.getBounds()
                  win.win.setPosition(before.x + 15, before.y + 15)
                  const after = win.win.getBounds()
                  const movable = win.win.isMovable() && after.x === before.x + 15 && after.y === before.y + 15
                  const [cw, ch] = win.win.getContentSize()
                  const page = wc.getURL().slice(prefix.length)
                  return `${win.surface} ${size.nodes > 3 || size.text > 0 ? 'rendered' : 'empty'}(${cw}x${ch}, ${page}${movable ? ', movable' : ', NOT movable'})`
                }
                if (tabId) {
                  await new Promise((r) => setTimeout(r, 6000))
                  const rt = b.tabs.runtime(tabId)
                  if (rt) fs.writeFileSync(p.join(arg.out, `tab-${arg.id}.png`), (await rt.wc.capturePage()).toPNG())
                  return `${closedItself}tab: ${String(b.tabs.model.getTab(tabId)?.url).slice(prefix.length)}`
                }
                return closedItself || 'nothing opened'
              },
              { id: info.id, out: OUT, tabsBefore, activeBefore }
            )

            // A side panel extension that opened a tab instead (e.g. a wallet's
            // onboarding): ask for the panel from that page, as the extension
            // itself would with chrome.sidePanel.open().
            if (manifest.side_panel?.default_path && row.popup.includes('tab: ')) {
              row.panel = await inMain(
                app,
                async (b, arg: { id: string; out: string }, electron) => {
                  const fs = process.getBuiltinModule('node:fs')
                  const p = process.getBuiltinModule('node:path')
                  const prefix = `chrome-extension://${arg.id}/`
                  const wc = electron.webContents.getAllWebContents().find((c: any) => !c.isDestroyed() && c.getURL().startsWith(prefix) && b.tabs.tabIdFor(c))
                  if (!wc) return 'no extension tab'
                  let api: string
                  try {
                    api = await wc.executeJavaScript(`typeof chrome.sidePanel?.open`)
                    await wc.executeJavaScript(`chrome.sidePanel.open({ windowId: -2 })`)
                  } catch (error) {
                    return `sidePanel.open failed: ${String((error as Error)?.message ?? error).slice(0, 120)}`
                  }
                  const deadline = Date.now() + 8000
                  let win: any = null
                  while (Date.now() < deadline && !win) {
                    const w = b.extensions['windows'].get(arg.id)
                    if (w && !w.destroyed && w.win.isVisible()) win = w
                    else await new Promise((r) => setTimeout(r, 200))
                  }
                  if (!win) return `sidePanel.open (${api}): no window`
                  // Wallet UIs boot a sandboxed SES realm first; give them time.
                  await new Promise((r) => setTimeout(r, 8000))
                  fs.writeFileSync(p.join(arg.out, `panel-${arg.id}.png`), (await win.webContents.capturePage()).toPNG())
                  const [cw, ch] = win.win.getContentSize()
                  return `panel via sidePanel.open: ${win.webContents.getURL().slice(prefix.length)} (${cw}x${ch}, movable=${win.win.isMovable()})`
                },
                { id: info.id, out: OUT }
              )
            }
          }
        }
        row.errors = [...new Set(await inMain(app, () => (globalThis as any).__extErrors as string[]))].slice(0, 8)
      } finally {
        await quit(app)
        removeDir(userData)
        writeFileSync(join(OUT, 'report.json'), JSON.stringify(rows, null, 2))
      }
    }
  } finally {
    server.close()
  }
  console.log(
    rows
      .map(
        (r) =>
          `${(r.name ?? r.folder).slice(0, 34).padEnd(34)} MV${r.mv} install=${r.install === 'ok' ? 'ok' : 'FAIL'} bg=${r.background} popup=${r.popup}${
            r.functional ? ` | ${r.functional}` : ''
          }${r.panel ? ` | ${r.panel}` : ''}${r.errors.length ? ` | errors=${r.errors.length}` : ''}`
      )
      .join('\n')
  )
  expect(rows.length).toBeGreaterThan(0)
})
