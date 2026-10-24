import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * A browser must never put up Electron's "JavaScript error in the main
 * process" dialog. Uncaught errors are logged to <userData>/logs/main.log
 * (and stderr) instead; the app keeps running.
 */
export function installErrorHandlers(): void {
  let logFile: string | null = null
  const write = (kind: string, error: unknown) => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.error(`[${kind}]`, text)
    try {
      if (!logFile) {
        const dir = join(app.getPath('userData'), 'logs')
        mkdirSync(dir, { recursive: true })
        logFile = join(dir, 'main.log')
      }
      appendFileSync(logFile, `${new Date().toISOString()} ${kind} ${text}\n`)
    } catch {
      // Logging must never throw.
    }
  }
  process.on('uncaughtException', (error) => write('uncaughtException', error))
  process.on('unhandledRejection', (reason) => write('unhandledRejection', reason))
}
