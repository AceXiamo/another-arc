import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { launch, quit, removeDir, rpc, screenshot, startServer, state, waitForShown } from './helpers'

const SHOTS = process.env.ARC_SHOT_DIR

test('boots, opens a tab and renders the sidebar', async () => {
  const { url, server } = await startServer()
  const { app, shell, userData } = await launch()
  try {
    const initial = await state(app)
    expect(initial.spaces).toHaveLength(1)
    if (SHOTS) await screenshot(app, join(SHOTS, 'smoke-empty.png'))

    await rpc(shell, 'tabs.create', { url: `${url}/page/one` })
    await waitForShown(app, '/page/one')
    await expect(shell.locator('[data-tab-id]')).toHaveCount(1)
    await expect(shell.locator('[data-tab-id]').first()).toContainText('Page one')
    if (SHOTS) await screenshot(app, join(SHOTS, 'smoke-tab.png'))
  } finally {
    await quit(app)
    server.close()
    removeDir(userData)
  }
})
