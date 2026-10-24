import { app } from 'electron'
import { join } from 'node:path'

/** True when running from `electron-vite dev`. */
export const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)

/** Renderer dev server URL (dev only). */
export const rendererDevUrl = process.env.ELECTRON_RENDERER_URL ?? null

/**
 * Keep development and test profiles away from the real one. `ARC_USER_DATA`
 * lets integration tests point each run at a throwaway directory.
 */
export function configureUserData(): void {
  const override = process.env.ARC_USER_DATA
  if (override) {
    app.setPath('userData', override)
  } else if (!app.isPackaged) {
    app.setPath('userData', join(app.getPath('appData'), `${app.getName()} Dev`))
  }
  // Chromium's own caches stay under userData so one folder holds everything.
  app.setPath('sessionData', app.getPath('userData'))
}

export function userDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

/**
 * Directory holding the compiled main/preload/renderer output. `ARC_OUT_DIR`
 * (absolute) points a test run at an alternate build.
 */
export function outPath(...parts: string[]): string {
  return join(process.env.ARC_OUT_DIR ?? join(app.getAppPath(), 'out'), ...parts)
}
