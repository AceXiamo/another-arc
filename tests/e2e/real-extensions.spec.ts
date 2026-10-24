import { expect, test } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, rpc, startServer, waitForShown } from './helpers'

// Compatibility survey for real-world extensions. Opt-in: point
// ARC_REAL_EXT_DIR at a folder of unpacked extensions (one per sub-folder)
// and ARC_REAL_EXT_OUT at a folder for the report and popup screenshots.
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

        // Popup: click the action like a user would and inspect what renders.
        await rpc(shell, 'tabs.activate', survey)
        const action = manifest.manifest_version === 3 ? manifest.action : (manifest.browser_action ?? manifest.page_action)
        if (action?.default_popup) {
          const icon = shell.locator(`img[src*="extension-icon/${info.id}"]`)
          if ((await icon.count()) === 0) {
            row.popup = 'not-opened (no action button)'
          } else {
            await icon.first().click()
            const popup = await inMain(
              app,
              async (_b, arg: { id: string; out: string }, electron) => {
                const { webContents } = electron
                const fs = process.getBuiltinModule('node:fs')
                const p = process.getBuiltinModule('node:path')
                const deadline = Date.now() + 8000
                let wc: any
                while (Date.now() < deadline && !wc) {
                  wc = webContents
                    .getAllWebContents()
                    .find((c: any) => c.getType() === 'window' && c.getURL().startsWith(`chrome-extension://${arg.id}/`))
                  if (!wc) await new Promise((r) => setTimeout(r, 200))
                }
                if (!wc) return 'not-opened'
                ;(globalThis as any).__watchContents()
                await new Promise((r) => setTimeout(r, 2500))
                const size = await wc.executeJavaScript(
                  `({ text: (document.body?.innerText || '').trim().length, nodes: document.querySelectorAll('body *').length })`
                )
                const img = await wc.capturePage()
                fs.writeFileSync(p.join(arg.out, `popup-${arg.id}.png`), img.toPNG())
                const win = electron.BrowserWindow.fromWebContents(wc)
                const b = win?.getBounds()
                const shown = win?.isVisible() ? `${b?.width}x${b?.height}` : 'hidden'
                return `${size.nodes > 3 || size.text > 0 ? 'rendered' : 'empty'}(${shown})`
              },
              { id: info.id, out: OUT }
            )
            row.popup = popup
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
          }${r.errors.length ? ` | errors=${r.errors.length}` : ''}`
      )
      .join('\n')
  )
  expect(rows.length).toBeGreaterThan(0)
})
