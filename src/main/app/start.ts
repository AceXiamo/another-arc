import { app } from 'electron'
import { Browser } from './browser'

const OPENABLE = /^(https?|file):/i

/** Boot the browser; returns a function that opens externally supplied URLs. */
export async function startBrowser(queuedUrls: string[]): Promise<(url: string) => void> {
  const browser = new Browser()

  app.on('web-contents-created', (_event, wc) => {
    wc.on('will-attach-webview', (e) => e.preventDefault())
    // Default for contents we do not manage explicitly (extension popups,
    // option pages opened in windows, surfaces): new windows become tabs.
    // Tabs and the shell install their own handler right after creation.
    wc.setWindowOpenHandler((details) => {
      if (/^(https?|chrome-extension):/.test(details.url)) {
        browser.tabs.createTab({ url: details.url, background: details.disposition === 'background-tab' })
      }
      return { action: 'deny' }
    })
  })

  app.on('certificate-error', (event, _wc, url, error, _certificate, callback) =>
    browser.handleCertificateError(event, url, error, callback)
  )

  app.on('second-instance', (_event, argv) => {
    browser.showWindow()
    for (const arg of argv) if (OPENABLE.test(arg)) browser.openExternalUrl(arg)
  })
  app.on('activate', () => browser.showWindow())
  app.on('open-file', (event, path) => {
    event.preventDefault()
    browser.openExternalUrl(`file://${path}`)
  })
  // Cmd+Q: capture state while every WebContents is still alive…
  app.on('before-quit', () => browser.markQuitting())
  // …and close the database once everything is gone.
  app.on('will-quit', () => browser.shutdown())
  app.on('window-all-closed', () => {
    // macOS convention: the app stays alive without windows.
  })

  // Integration tests reach into the running browser through this handle.
  if (process.env.ARC_TEST === '1') (globalThis as { __arc?: Browser }).__arc = browser

  for (const url of queuedUrls) browser.openExternalUrl(url)
  await browser.start()
  const perfReport = process.env.ARC_PERF_REPORT
  if (perfReport) void writePerfReport(browser, perfReport)
  return (url) => browser.openExternalUrl(url)
}

/** ARC_PERF_REPORT=<file>: record startup timeline and memory, then quit. */
async function writePerfReport(browser: Browser, file: string): Promise<void> {
  const open = process.env.ARC_PERF_OPEN
  if (open) browser.tabs.createTab({ url: open })
  await new Promise((r) => setTimeout(r, 4000))
  const byType: Record<string, number> = {}
  let total = 0
  for (const m of app.getAppMetrics()) {
    const mb = m.memory.workingSetSize / 1024
    byType[m.type] = Math.round((byType[m.type] ?? 0) + mb)
    total += mb
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    file,
    JSON.stringify({ marks: browser.startupMarks(), memoryMB: { total: Math.round(total), ...byType }, liveTabs: browser.tabs.liveRuntimes().length }, null, 2)
  )
  app.quit()
}
