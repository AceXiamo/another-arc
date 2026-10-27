import { expect, test, type ElectronApplication } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, startServer, t, waitForShown } from './helpers'

// The whole sign-in chain in the running app, driven by real input
// (`sendInputEvent`, so the page sees trusted events): the page preload
// spots the user going into a field, main puts the dropdown over it, and the
// pick travels back down into the form.

const page = (app: ElectronApplication, script: string) =>
  inMain(app, (b, source: string) => b.tabs.liveRuntimes()[0].wc.executeJavaScript(source), script)

const fields = (app: ElectronApplication) =>
  page(app, 'document.getElementById("u").value + ":" + document.getElementById("p").value')

/** A real left click at the centre of an element in the page. */
async function click(app: ElectronApplication, id: string): Promise<void> {
  const box = await page(app, `JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`)
  await inMain(
    app,
    (b, r: { x: number; y: number; width: number; height: number }) => {
      const wc = b.tabs.liveRuntimes()[0].wc
      const at = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    },
    JSON.parse(box as string)
  )
}

const press = (app: ElectronApplication, keyCode: string) =>
  inMain(
    app,
    (b, k: string) => {
      const wc = b.tabs.liveRuntimes()[0].wc
      wc.sendInputEvent({ type: 'keyDown', keyCode: k })
      wc.sendInputEvent({ type: 'keyUp', keyCode: k })
    },
    keyCode
  )

const dropdown = (app: ElectronApplication) =>
  inMain(app, (b) => ({
    usernames: b.passwords.current().map((e: { username: string }) => e.username),
    visible: b.window?.getSurface('autofill')?.visible ?? false
  }))

/** Every time the dropdown is shown or hidden, from now on. */
const recordToggles = (app: ElectronApplication) =>
  inMain(app, (b) => {
    const original = b.setSurfaceVisible.bind(b)
    const log: boolean[] = []
    ;(globalThis as Record<string, unknown>).__toggles = log
    b.setSurfaceVisible = (id: string, v: boolean) => {
      if (id === 'autofill') log.push(v)
      return original(id, v)
    }
  })
const toggles = (app: ElectronApplication) =>
  inMain(app, () => (globalThis as unknown as { __toggles: boolean[] }).__toggles)

const settle = () => new Promise((r) => setTimeout(r, 800))

async function signInPage(names: string[]) {
  const { url, server } = await startServer()
  const launched = await launch()
  const { app, shell } = launched
  const origin = new URL(url).origin
  for (const name of names) await inMain(app, (b, a: [string, string]) => b.passwords.store.save(a[0], a[1], `pw-${a[1]}`), [origin, name])
  await rpc(shell, 'tabs.create', { url: `${url}/login` })
  await waitForShown(app, `${url}/login`)
  await inMain(app, (b) => b.tabs.liveRuntimes()[0].wc.focus())
  await recordToggles(app)
  return { ...launched, url, server, origin }
}

test('opens on a click and stays open, with the keyboard still in the field', async () => {
  const { app, userData, server } = await signInPage(['ace'])
  try {
    await click(app, 'p')
    await expect.poll(() => dropdown(app), { timeout: 5000 }).toEqual({ usernames: ['ace'], visible: true })
    await settle()
    // Shown once, never hidden and shown again: no flicker.
    expect(await toggles(app)).toEqual([true])
    // The dropdown never took the keyboard from the page.
    expect(await inMain(app, (b) => b.tabs.liveRuntimes()[0].wc.isFocused())).toBe(true)
    expect(await page(app, 'document.activeElement.id')).toBe('p')
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('a script focusing the field opens nothing; only the user does', async () => {
  const { app, userData, server } = await signInPage(['ace'])
  try {
    await page(app, 'document.getElementById("p").focus()')
    await settle()
    expect(await dropdown(app)).toEqual({ usernames: [], visible: false })
    expect(await toggles(app)).toEqual([])
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('a click on a row fills the form, and the dropdown does not come back', async () => {
  const { app, userData, server } = await signInPage(['ace'])
  try {
    await click(app, 'u')
    await expect.poll(() => dropdown(app), { timeout: 5000 }).toMatchObject({ visible: true })

    // Press the row in the dropdown itself, as a mouse would.
    await inMain(app, async (b) => {
      const wc = b.window.getSurface('autofill').view.webContents
      const r = JSON.parse(await wc.executeJavaScript('JSON.stringify(document.querySelector("button").getBoundingClientRect())'))
      const at = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    })

    await expect.poll(() => fields(app), { timeout: 5000 }).toBe('ace:pw-ace')
    await settle()
    // Focusing the password field after the fill is ours, so nothing reopens.
    expect(await toggles(app)).toEqual([true, false])
    expect(await inMain(app, (b) => b.tabs.liveRuntimes()[0].wc.isFocused())).toBe(true)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('the arrow keys pick a login and Enter fills it', async () => {
  const { app, userData, server } = await signInPage(['ace', 'bob'])
  try {
    await click(app, 'p')
    await expect.poll(() => dropdown(app), { timeout: 5000 }).toMatchObject({ visible: true })
    const order = (await dropdown(app)).usernames
    // Let the page hear that the dropdown is open before talking to it.
    await settle()

    const picked = () =>
      inMain(app, (b) =>
        b.window
          .getSurface('autofill')
          .view.webContents.executeJavaScript('[...document.querySelectorAll("[role=option]")].findIndex((o) => o.getAttribute("aria-selected") === "true")')
      )
    expect(await picked()).toBe(-1)
    await press(app, 'Down')
    await expect.poll(picked).toBe(0)
    await press(app, 'Down')
    await expect.poll(picked).toBe(1)
    await press(app, 'Up')
    await expect.poll(picked).toBe(0)
    await press(app, 'Down')
    await expect.poll(picked).toBe(1)
    await press(app, 'Enter')
    await expect.poll(() => fields(app), { timeout: 5000 }).toBe(`${order[1]}:pw-${order[1]}`)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('Escape closes it, a click on the field opens it again, and ↓ does too', async () => {
  const { app, userData, server } = await signInPage(['ace'])
  try {
    await click(app, 'p')
    await expect.poll(() => dropdown(app), { timeout: 5000 }).toMatchObject({ visible: true })

    await press(app, 'Escape')
    await expect.poll(() => dropdown(app)).toMatchObject({ visible: false })
    expect(await page(app, 'document.activeElement.id')).toBe('p')

    await click(app, 'p')
    await expect.poll(() => dropdown(app)).toMatchObject({ visible: true })

    await press(app, 'Escape')
    await expect.poll(() => dropdown(app)).toMatchObject({ visible: false })
    await press(app, 'Down')
    await expect.poll(() => dropdown(app)).toMatchObject({ visible: true })
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('"Saved passwords…" closes the dropdown and opens the passwords page', async () => {
  const { app, userData, server } = await signInPage(['ace'])
  try {
    await click(app, 'p')
    await expect.poll(() => dropdown(app), { timeout: 5000 }).toMatchObject({ visible: true })
    await inMain(app, async (b) => {
      const wc = b.window.getSurface('autofill').view.webContents
      const r = JSON.parse(
        await wc.executeJavaScript('JSON.stringify([...document.querySelectorAll("button")].at(-1).getBoundingClientRect())')
      )
      const at = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
    })
    await expect.poll(() => dropdown(app)).toMatchObject({ visible: false })
    // Internal pages are tabs the shell draws, so ask the model, not the live views.
    await expect
      .poll(() => inMain(app, (b) => b.tabs.model.getTab(b.tabs.model.activeSpace().activeTabId)?.url ?? ''))
      .toBe('browser://passwords')
    // Nothing was filled on the way.
    expect(await fields(app)).toBe(':')
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('offers to save a sign-in it has not seen, and keeps quiet about one it has', async () => {
  const { app, shell, userData, server, origin } = await signInPage([])
  try {
    await page(
      app,
      `document.getElementById('u').value = 'ace';
       document.getElementById('p').value = 'hunter2';
       document.getElementById('f').addEventListener('submit', (e) => e.preventDefault());
       document.getElementById('f').requestSubmit();`
    )
    // Main holds it until the prompt is answered; nothing is stored yet.
    await expect.poll(() => inMain(app, (b) => b.passwords.store.list().length), { timeout: 5000 }).toBe(0)
    // The prompt does not take the keyboard from the page either.
    await settle()
    expect(await inMain(app, (b) => b.tabs.liveRuntimes()[0].wc.isFocused())).toBe(true)

    await rpc(shell, 'passwords.resolveSave', true)
    const logins = await inMain(app, (b) => b.passwords.store.list())
    expect(logins).toHaveLength(1)
    expect(logins[0]).toMatchObject({ origin, username: 'ace' })

    // The same sign-in again raises nothing to answer.
    await page(app, "document.getElementById('f').requestSubmit()")
    await rpc(shell, 'passwords.resolveSave', true)
    expect(await inMain(app, (b) => b.passwords.store.list().length)).toBe(1)
  } finally {
    await quit(app)
    removeDir(userData)
    server.close()
  }
})

test('Settings sums the logins up; their own page lists, searches and leads back', async () => {
  const { app, shell, userData } = await launch()
  try {
    await inMain(app, (b) => {
      b.passwords.store.save('https://www.github.com', 'ada', 'pw-1')
      b.passwords.store.save('https://github.com', 'grace', 'pw-2')
      b.passwords.store.save('https://example.org', '', 'pw-3')
    })
    await rpc(shell, 'tabs.openInternal', 'settings')
    const open = shell.locator('[data-open-passwords]')
    // www.github.com and github.com are one site.
    await expect(open).toContainText(t('passwords.settings.summary', { count: 3, sites: 2 }))

    await open.click()
    await expect(shell.locator('[data-login]')).toHaveCount(3)
    await expect(shell.locator('[data-login]').first()).toContainText('example.org')
    await shell.getByPlaceholder(t('passwords.page.search')).fill('grace')
    await expect(shell.locator('[data-login]')).toHaveCount(1)
    await expect(shell.locator('[data-login]')).toContainText('github.com')
    await shell.getByPlaceholder(t('passwords.page.search')).fill('nothing-like-this')
    await expect(shell.getByText(t('passwords.page.noMatches'))).toBeVisible()

    await shell.locator('[data-page-back]').click()
    await expect(open).toBeVisible()
    expect(await inMain(app, (b) => b.tabs.model.activeTab()?.url)).toBe('browser://settings')
  } finally {
    await quit(app)
    removeDir(userData)
  }
})
