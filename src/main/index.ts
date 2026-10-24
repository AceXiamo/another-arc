// Bootstrap entry. Kept tiny on purpose: it enables Node's on-disk compile
// cache first, then loads the rest of the main process as a separate chunk so
// that chunk is served from the cache on every launch after the first.
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { app } from 'electron'
import { configureUserData } from './app/environment'
import { installErrorHandlers } from './app/errors'
import { mark } from './app/perf'
import { registerPrivilegedSchemes } from './app/protocols'

mark('main-entry')
configureUserData()
installErrorHandlers()
try {
  enableCompileCache(join(app.getPath('userData'), 'CompileCache'))
} catch {
  // Older runtimes: no compile cache, no problem.
}
registerPrivilegedSchemes()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // URLs macOS hands us before the browser is up (default browser, `open`).
  const queued: string[] = []
  let deliver: ((url: string) => void) | null = null
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (deliver) deliver(url)
    else queued.push(url)
  })

  void app.whenReady().then(async () => {
    mark('app-ready')
    const { startBrowser } = await import('./app/start')
    deliver = await startBrowser(queued)
  })
}
