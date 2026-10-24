import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, rpc, screenshot, state } from './helpers'

const SHOTS = process.env.ARC_SHOT_DIR

/** Top-level application menu labels plus the File menu's items. */
function menuLabels(app: Parameters<typeof inMain>[0]) {
  return inMain(app, (_b, _a, { Menu }) => {
    const items = Menu.getApplicationMenu()?.items ?? []
    return {
      top: items.map((i) => i.label),
      file: (items[1]?.submenu?.items ?? []).map((i) => i.label).filter(Boolean)
    }
  })
}

test('defaults to English and switches language live, persisting across restarts', async () => {
  let { app, shell, userData } = await launch(undefined, {}, null)
  try {
    // First run: English everywhere.
    await expect(shell.locator('html')).toHaveAttribute('lang', 'en')
    expect((await state(app)).spaces[0]!.name).toBe('Personal')
    expect((await menuLabels(app)).top).toContain('File')
    expect((await menuLabels(app)).file).toContain('New Tab')
    await expect(shell.locator('aside').getByText('Personal', { exact: true })).toBeVisible()

    // Switch from the Settings page.
    await rpc(shell, 'tabs.openInternal', 'settings')
    const picker = shell.locator('select').filter({ has: shell.locator('option[value="zh-CN"]') })
    await expect(picker).toHaveValue('en')
    if (SHOTS) await screenshot(app, join(SHOTS, 'i18n-settings-en.png'))
    await picker.selectOption('zh-CN')

    await expect(shell.locator('html')).toHaveAttribute('lang', 'zh-CN')
    await expect(shell.getByText('语言', { exact: true })).toBeVisible()
    await expect.poll(async () => (await menuLabels(app)).top).toContain('文件')
    expect((await menuLabels(app)).file).toContain('新建标签页')
    // The untouched default space name follows the language; a chosen one would not.
    await expect.poll(async () => (await state(app)).spaces[0]!.name).toBe('个人')
    await expect(shell.locator('aside').getByText('个人', { exact: true })).toBeVisible()
    if (SHOTS) await screenshot(app, join(SHOTS, 'i18n-settings-zh.png'))
  } finally {
    await quit(app)
  }

  // The choice is persisted.
  ;({ app, shell } = await launch(userData, {}, null))
  try {
    await expect(shell.locator('html')).toHaveAttribute('lang', 'zh-CN')
    expect((await menuLabels(app)).top).toContain('文件')

    // A user-chosen space name is left alone when switching back.
    const spaceId = (await state(app)).spaces[0]!.id
    await rpc(shell, 'spaces.update', spaceId, { name: '工作' })
    await rpc(shell, 'settings.update', { language: 'en' })
    await expect(shell.locator('html')).toHaveAttribute('lang', 'en')
    await expect.poll(async () => (await menuLabels(app)).top).toContain('File')
    expect((await state(app)).spaces[0]!.name).toBe('工作')
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
