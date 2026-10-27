import { expect, test, type ElectronApplication } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, startServer, t, waitForShown } from './helpers'

// alert() / confirm() / prompt() in tabs: drawn by the shell as a sheet on the
// page card and answered there. Playwright answers every dialog it sees with
// "cancel" unless the test listens for them, so each test listens and leaves
// them to the app.

/** Run script in the tab showing `urlPrefix`, with a user gesture. */
const inTab = <T = unknown>(app: ElectronApplication, urlPrefix: string, script: string) =>
  inMain(
    app,
    (b, [prefix, source]: [string, string]) => {
      const rt = b.tabs.liveRuntimes().find((r: { wc: Electron.WebContents }) => r.wc.getURL().startsWith(prefix))
      return rt.wc.executeJavaScript(source, true)
    },
    [urlPrefix, script]
  ) as Promise<T>

/** Ask from the page without waiting: the answer lands in window.__answers. */
const ask = (app: ElectronApplication, urlPrefix: string, call: string) =>
  inTab(app, urlPrefix, `setTimeout(() => (window.__answers ??= []).push(${call})); 0`)

const answers = (app: ElectronApplication, urlPrefix: string) => inTab<unknown[]>(app, urlPrefix, 'window.__answers ?? []')

const overlayOpen = (app: ElectronApplication) => inMain(app, (b) => b.window.isOverlayOpen as boolean)
const openDialogs = (app: ElectronApplication) => inMain(app, (b) => b.dialogs.list().length as number)

async function start() {
  const { url, server } = await startServer()
  const launched = await launch()
  launched.app.context().on('dialog', () => undefined)
  await rpc(launched.shell, 'tabs.create', { url: `${url}/page/a` })
  await waitForShown(launched.app, `${url}/page/a`)
  return { ...launched, url, server }
}

test('confirm() returns what the user picks in the sheet over its tab', async () => {
  const { app, shell, userData, server, url } = await start()
  const page = `${url}/page/a`
  try {
    await ask(app, page, `confirm('Delete everything?')`)
    const sheet = shell.getByRole('alertdialog')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText(t('pageDialog.says', { host: new URL(url).host }))
    await expect(sheet).toContainText('Delete everything?')
    // The shell is raised over the page (dimmed, still visible), sidebar usable.
    expect(await overlayOpen(app)).toBe(true)
    // First dialog from this site: nothing to block yet.
    await expect(sheet.getByRole('checkbox')).toHaveCount(0)

    await sheet.getByRole('button', { name: t('pageDialog.ok') }).click()
    await expect(sheet).toHaveCount(0)
    await expect.poll(() => answers(app, page)).toEqual([true])
    await expect.poll(() => overlayOpen(app)).toBe(false)

    await ask(app, page, `confirm('Really?')`)
    await expect(sheet).toContainText('Really?')
    await sheet.getByRole('button', { name: t('common.cancel') }).click()
    await expect.poll(() => answers(app, page)).toEqual([true, false])

    // Keyboard: Enter is OK, Escape is Cancel.
    await ask(app, page, `confirm('Keys?')`)
    await expect(sheet).toContainText('Keys?')
    await shell.keyboard.press('Enter')
    await expect.poll(() => answers(app, page)).toEqual([true, false, true])
    await ask(app, page, `confirm('Keys again?')`)
    await expect(sheet).toContainText('Keys again?')
    await shell.keyboard.press('Escape')
    await expect.poll(() => answers(app, page)).toEqual([true, false, true, false])
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('alert() and prompt() are answered in the sheet', async () => {
  const { app, shell, userData, server, url } = await start()
  const page = `${url}/page/a`
  try {
    const sheet = shell.getByRole('alertdialog')
    await ask(app, page, `(alert('Saved'), 'after alert')`)
    await expect(sheet).toContainText('Saved')
    await expect(sheet.getByRole('button')).toHaveCount(1)
    await sheet.getByRole('button', { name: t('pageDialog.ok') }).click()
    await expect.poll(() => answers(app, page)).toEqual(['after alert'])

    await ask(app, page, `prompt('Your name?', 'Ada')`)
    const field = sheet.getByRole('textbox')
    await expect(field).toHaveValue('Ada')
    await field.fill('Grace')
    await field.press('Enter')
    await expect.poll(() => answers(app, page)).toEqual(['after alert', 'Grace'])

    await ask(app, page, `prompt('Again?', 'x')`)
    await expect(sheet).toContainText('Again?')
    await sheet.getByRole('button', { name: t('common.cancel') }).click()
    await expect.poll(() => answers(app, page)).toEqual(['after alert', 'Grace', null])
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('a site that keeps asking can be silenced (safeDialogs)', async () => {
  const { app, shell, userData, server, url } = await start()
  const page = `${url}/page/a`
  try {
    const sheet = shell.getByRole('alertdialog')
    await ask(app, page, `confirm('one')`)
    await sheet.getByRole('button', { name: t('pageDialog.ok') }).click()
    await expect.poll(() => answers(app, page)).toEqual([true])

    await ask(app, page, `confirm('two')`)
    await expect(sheet).toContainText('two')
    await sheet.getByRole('checkbox', { name: t('pageDialog.suppress') }).check()
    await sheet.getByRole('button', { name: t('pageDialog.ok') }).click()
    await expect.poll(() => answers(app, page)).toEqual([true, true])

    // Blocked: answered "cancel" at once, nothing shown.
    expect(await inTab(app, page, `confirm('three')`)).toBe(false)
    expect(await openDialogs(app)).toBe(0)
    await expect(sheet).toHaveCount(0)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('only the tab on screen may ask; leaving it cancels its dialog', async () => {
  const { app, shell, userData, server, url } = await start()
  const a = `${url}/page/a`
  const b = `${url}/page/b`
  try {
    const tabA = await inMain(app, (br) => br.tabs.model.activeTab().id as string)
    await rpc(shell, 'tabs.create', { url: b })
    await waitForShown(app, b)

    // A is in the background: no sheet over B, A gets "cancel" right away.
    expect(await inTab(app, a, `confirm('from the background')`)).toBe(false)
    expect(await openDialogs(app)).toBe(0)

    await ask(app, b, `confirm('from B')`)
    const sheet = shell.getByRole('alertdialog')
    await expect(sheet).toContainText('from B')
    await rpc(shell, 'tabs.activate', tabA)
    await waitForShown(app, a)
    await expect(sheet).toHaveCount(0)
    await expect.poll(() => answers(app, b)).toEqual([false])
    expect(await overlayOpen(app)).toBe(false)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})
