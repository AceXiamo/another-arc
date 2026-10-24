import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { join } from 'node:path'
import { inMain, launch, quit, removeDir, rpc, screenshot, startServer, state, t, waitForShown, type Launched } from './helpers'

// Sidebar folders, driven through the shell UI: inline rename, pointer drags,
// collapse, folder tabs and the blank-area context menu. Main-process
// semantics live in folders.spec.ts. With ARC_SHOT_DIR set, the last test
// also writes screenshots of the tree (run with ARC_TEST_LOCALE=en for English).

const SHOTS = process.env.ARC_SHOT_DIR

let server: Awaited<ReturnType<typeof startServer>>
let ctx: Launched

test.beforeAll(async () => {
  server = await startServer()
})
test.afterAll(() => server.server.close())
test.beforeEach(async () => {
  ctx = await launch()
})
test.afterEach(async () => {
  await quit(ctx.app)
  removeDir(ctx.userData)
})

const page = (name: string) => `${server.url}/page/${name}`
const folderRow = (shell: Page, id: string) => shell.locator(`[data-tree-row="folder"][data-id="${id}"]`)
const treeTab = (shell: Page, id: string) => shell.locator(`[data-tree-row="tab"][data-id="${id}"]`)
const todayTab = (shell: Page, id: string) => shell.locator(`[data-tab-section="tabs"] [data-tab-id="${id}"]`)
const renameInput = (shell: Page) => shell.getByLabel(t('sidebar.folders.renameLabel'))

/** Two animation frames (with a timeout fallback in case the window is throttled). */
const frames = (shell: Page) =>
  shell.evaluate(
    () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
        setTimeout(r, 150)
      })
  )

/**
 * Real pointer drag from `source` to a point on `dest`. The destination is
 * measured after the drag starts, since starting a tab drag reveals the
 * pinned drop zone and shifts the list.
 */
async function drag(
  shell: Page,
  source: Locator,
  dest: Locator,
  at: 'center' | 'top' | 'bottom' = 'center',
  release = true
): Promise<void> {
  const a = (await source.boundingBox())!
  const sx = a.x + Math.min(40, a.width / 2)
  const sy = a.y + a.height / 2
  await shell.mouse.move(sx, sy)
  await shell.mouse.down()
  await shell.mouse.move(sx, sy + 8, { steps: 3 })
  await frames(shell)
  const b = (await dest.boundingBox())!
  const y = at === 'center' ? b.y + b.height / 2 : at === 'top' ? b.y + 3 : b.y + b.height - 3
  await shell.mouse.move(b.x + b.width / 2, y, { steps: 10 })
  await frames(shell)
  if (release) await shell.mouse.up()
}

/** Record native menus instead of showing them (Menu.popup blocks on macOS). */
async function stubMenus(app: ElectronApplication): Promise<void> {
  await inMain(app, (_b, _a, { Menu }) => {
    const g = globalThis as unknown as { __popups: Array<{ labels: string[]; menu: unknown }> }
    g.__popups = []
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.__popups.push({ labels: this.items.map((i) => i.label), menu: this })
    }
  })
}

const popups = (app: ElectronApplication) =>
  inMain(app, () => (globalThis as unknown as { __popups: Array<{ labels: string[] }> }).__popups.map((p) => p.labels))

test('creates a folder, renames it inline, collapses and expands it', async () => {
  const { app, shell } = ctx
  await rpc(shell, 'tabs.create', { url: page('one') })
  const folderId = await rpc<string>(shell, 'folders.create', { name: 'Reading' })
  const row = folderRow(shell, folderId)
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(row).toContainText('Reading')
  // An open, empty folder shows its hint; the divider separates it from today's tabs.
  await expect(shell.getByText(t('sidebar.folders.empty'))).toBeVisible()

  // Double-click: the name becomes a focused input with everything selected.
  await row.dblclick()
  const input = renameInput(shell)
  await expect(input).toBeFocused()
  expect(await input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd, el.value.length])).toEqual([0, 7, 7])
  await shell.keyboard.type('Research')
  await shell.keyboard.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(row).toContainText('Research')
  await expect.poll(async () => (await state(app)).folders[folderId]?.name).toBe('Research')
  // The double-click's own clicks did not leave the folder toggled.
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  expect((await state(app)).folders[folderId]!.collapsed).toBe(false)

  // Escape cancels.
  await row.dblclick()
  await expect(renameInput(shell)).toBeFocused()
  await shell.keyboard.type('Nope')
  await shell.keyboard.press('Escape')
  await expect(renameInput(shell)).toHaveCount(0)
  await expect(row).toContainText('Research')
  expect((await state(app)).folders[folderId]!.name).toBe('Research')

  // Click toggles collapsed (optimistically, then in main).
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await expect(shell.getByText(t('sidebar.folders.empty'))).toHaveCount(0)
  await expect.poll(async () => (await state(app)).folders[folderId]?.collapsed).toBe(true)
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await state(app)).folders[folderId]?.collapsed).toBe(false)

  // The keyboard works too.
  await row.focus()
  await shell.keyboard.press('Enter')
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await shell.keyboard.press('ArrowRight')
  await expect(row).toHaveAttribute('aria-expanded', 'true')
})

test('drags tabs into folders, nests folders and keeps closed folder tabs', async () => {
  const { app, shell } = ctx
  const a = await rpc<string>(shell, 'tabs.create', { url: page('a') })
  const b = await rpc<string>(shell, 'tabs.create', { url: page('b') })
  await waitForShown(app, '/page/b')
  const outer = await rpc<string>(shell, 'folders.create', { name: 'Outer', index: 0 })
  const inner = await rpc<string>(shell, 'folders.create', { name: 'Inner', index: 1 })

  // A today tab dropped on a folder row lands in that folder.
  await drag(shell, todayTab(shell, a), folderRow(shell, outer))
  await expect(treeTab(shell, a)).toBeVisible()
  await expect(todayTab(shell, a)).toHaveCount(0)
  let s = await state(app)
  expect(s.tabs[a]).toMatchObject({ folderId: outer, pinned: false })
  expect(s.folders[outer]!.childIds).toEqual([a])
  expect(s.spaces[0]!.tabIds).toEqual([b])

  // A folder dropped on another folder's row nests inside it (appended).
  await drag(shell, folderRow(shell, inner), folderRow(shell, outer))
  await expect(folderRow(shell, inner)).toHaveAttribute('data-parent', outer)
  s = await state(app)
  expect(s.folders[inner]!.parentId).toBe(outer)
  expect(s.folders[outer]!.childIds).toEqual([a, inner])
  expect(s.spaces[0]!.savedIds).toEqual([outer])

  // The second today tab goes into the nested folder; then move it before `a`
  // by dropping on the upper half of a's row.
  await drag(shell, todayTab(shell, b), folderRow(shell, inner))
  await expect.poll(async () => (await state(app)).folders[inner]?.childIds).toEqual([b])
  await drag(shell, treeTab(shell, b), treeTab(shell, a), 'top')
  await expect.poll(async () => (await state(app)).folders[outer]?.childIds).toEqual([b, a, inner])
  expect((await state(app)).folders[inner]!.childIds).toEqual([])

  // A folder never drops into itself or its descendants.
  await drag(shell, folderRow(shell, outer), folderRow(shell, inner))
  s = await state(app)
  expect(s.folders[outer]!.parentId).toBeNull()
  expect(s.folders[inner]!.parentId).toBe(outer)

  // A folder tab dragged back into today's list leaves the folder.
  await drag(shell, treeTab(shell, b), shell.locator('[data-tab-section="tabs"]'), 'bottom')
  await expect(todayTab(shell, b)).toBeVisible()
  await expect.poll(async () => (await state(app)).tabs[b]?.folderId).toBeNull()

  // Collapsing hides the children; expanding brings them back.
  await folderRow(shell, outer).click()
  await expect(treeTab(shell, a)).toHaveCount(0)
  await expect(folderRow(shell, inner)).toHaveCount(0)
  await folderRow(shell, outer).click()
  await expect(treeTab(shell, a)).toBeVisible()
  await expect(folderRow(shell, inner)).toBeVisible()

  // Closing a live folder tab unloads it but keeps its row; the button only exists while live.
  await rpc(shell, 'tabs.activate', a)
  await waitForShown(app, '/page/a')
  await expect.poll(async () => (await state(app)).tabs[a]?.live).toBe(true)
  const close = treeTab(shell, a).getByRole('button', { name: t('sidebar.folders.unloadTab') })
  await treeTab(shell, a).hover()
  await close.click()
  await expect.poll(async () => (await state(app)).tabs[a]?.live).toBe(false)
  await expect(treeTab(shell, a)).toBeVisible()
  await expect(close).toHaveCount(0)
  expect((await state(app)).folders[outer]!.childIds).toContain(a)

  // Middle-click unloads the same way.
  await rpc(shell, 'tabs.activate', a)
  await expect.poll(async () => (await state(app)).tabs[a]?.live).toBe(true)
  await treeTab(shell, a).click({ button: 'middle' })
  await expect.poll(async () => (await state(app)).tabs[a]?.live).toBe(false)
  await expect(treeTab(shell, a)).toBeVisible()
})

test('saves tabs at the top level of the saved list and moves them around by drag', async () => {
  const { app, shell } = ctx
  const a = await rpc<string>(shell, 'tabs.create', { url: page('top-a') })
  const b = await rpc<string>(shell, 'tabs.create', { url: page('top-b') })
  await waitForShown(app, '/page/top-b')
  const folder = await rpc<string>(shell, 'folders.create', { name: 'Folder' })

  // Upper quarter of a top-level folder row: a top-level saved tab before it.
  await drag(shell, todayTab(shell, a), folderRow(shell, folder), 'top')
  await expect(treeTab(shell, a)).toHaveAttribute('data-parent', '')
  await expect(todayTab(shell, a)).toHaveCount(0)
  let s = await state(app)
  expect(s.spaces[0]!.savedIds).toEqual([a, folder])
  expect(s.tabs[a]).toMatchObject({ folderId: null, pinned: false, savedUrl: page('top-a') })

  // Lower half of a top-level tab row: right after it.
  await drag(shell, todayTab(shell, b), treeTab(shell, a), 'bottom')
  await expect.poll(async () => (await state(app)).spaces[0]!.savedIds).toEqual([a, b, folder])
  expect((await state(app)).tabs[b]!.savedUrl).toBe(page('top-b'))

  // A live top-level saved tab closes into an unloaded row that stays put.
  await rpc(shell, 'tabs.activate', b)
  await expect.poll(async () => (await state(app)).tabs[b]?.live).toBe(true)
  const close = treeTab(shell, b).getByRole('button', { name: t('sidebar.folders.unloadTab') })
  await treeTab(shell, b).hover()
  await close.click()
  await expect.poll(async () => (await state(app)).tabs[b]?.live).toBe(false)
  await expect(treeTab(shell, b)).toBeVisible()
  await expect(close).toHaveCount(0)
  expect((await state(app)).spaces[0]!.savedIds).toEqual([a, b, folder])

  // From the top level into a folder: still saved, same bookmark.
  await drag(shell, treeTab(shell, a), folderRow(shell, folder))
  await expect(treeTab(shell, a)).toHaveAttribute('data-parent', folder)
  s = await state(app)
  expect(s.spaces[0]!.savedIds).toEqual([b, folder])
  expect(s.folders[folder]!.childIds).toEqual([a])
  expect(s.tabs[a]).toMatchObject({ folderId: folder, savedUrl: page('top-a') })

  // Back to today's list: no longer saved.
  await drag(shell, treeTab(shell, b), shell.locator('[data-tab-section="tabs"]'), 'bottom')
  await expect(todayTab(shell, b)).toBeVisible()
  await expect.poll(async () => (await state(app)).tabs[b]?.savedUrl).toBe('')
  s = await state(app)
  expect(s.spaces[0]!.savedIds).toEqual([folder])
  expect(s.tabs[b]!.folderId).toBeNull()
  expect(s.spaces[0]!.tabIds).toContain(b)
})

test('right-click on blank sidebar space opens the sidebar menu, rows keep their own', async () => {
  const { app, shell } = ctx
  const tab = await rpc<string>(shell, 'tabs.create', { url: page('menu') })
  const folderId = await rpc<string>(shell, 'folders.create', { name: 'Saved' })
  await stubMenus(app)

  // Rows open their own menu and do not bubble to the sidebar.
  await todayTab(shell, tab).click({ button: 'right' })
  await folderRow(shell, folderId).click({ button: 'right' })
  let menus = await popups(app)
  expect(menus).toHaveLength(2)
  expect(menus[0]).toContain(t('tabMenu.pin'))
  expect(menus[1]).toContain(t('folderMenu.rename'))

  // Empty space under today's tabs.
  const section = (await shell.locator('[data-tab-section="tabs"]').boundingBox())!
  await shell.mouse.click(section.x + section.width / 2, section.y + section.height - 6, { button: 'right' })
  menus = await popups(app)
  expect(menus).toHaveLength(3)
  expect(menus[2]).toContain(t('sidebarMenu.newFolder'))

  // Its "New Folder" appends a folder and opens the inline rename field.
  await inMain(
    app,
    (_b, label: string) => {
      const g = globalThis as unknown as { __popups: Array<{ menu: Electron.Menu }> }
      g.__popups.at(-1)!.menu.items.find((i) => i.label === label)!.click()
    },
    t('sidebarMenu.newFolder')
  )
  await expect(renameInput(shell)).toBeFocused()
  await shell.keyboard.type('Inbox')
  await shell.keyboard.press('Enter')
  await expect.poll(async () => Object.values((await state(app)).folders).map((f) => f.name)).toEqual(['Saved', 'Inbox'])
})

test('a collapsed folder keeps showing the active tab saved inside it', async () => {
  const { app, shell } = ctx
  const spaceId = (await state(app)).activeSpaceId
  const outer = await rpc<string>(shell, 'folders.create', { spaceId, name: 'Outer' })
  const inner = await rpc<string>(shell, 'folders.create', { parentId: outer, name: 'Inner' })
  const saved = await rpc<string>(shell, 'tabs.create', { url: page('saved') })
  const other = await rpc<string>(shell, 'tabs.create', { url: page('other'), background: true })
  await waitForShown(app, '/page/saved')
  await rpc(shell, 'tabs.move', saved, { spaceId, pinned: false, folderId: inner, index: 0 })
  await rpc(shell, 'folders.setCollapsed', outer, true)

  // Active: still listed under the collapsed folder (once), and cycling starts from it.
  await expect(treeTab(shell, saved)).toHaveCount(1)
  await expect(folderRow(shell, inner)).toHaveCount(0)
  expect(await inMain(app, (b, sid: string) => b.tabs.model.visibleTabIds(sid), spaceId)).toEqual([saved, other])

  // Once another tab is active it hides with the rest of the folder.
  await rpc(shell, 'tabs.activate', other)
  await expect(treeTab(shell, saved)).toHaveCount(0)
})

test('renders the folder tree', async () => {
  test.setTimeout(150_000)
  const { app, shell } = ctx
  const shot = async (name: string) => {
    if (!SHOTS) return
    await shell.waitForFunction(() => [...document.images].every((img) => img.complete))
    await shell.evaluate(() => new Promise<void>((r) => setTimeout(() => requestAnimationFrame(() => r()), 220)))
    await screenshot(app, join(SHOTS, `${name}.png`))
  }
  const both = async (name: string) => {
    await rpc(shell, 'settings.update', { theme: 'light' })
    await shot(`${name}-light`)
    await rpc(shell, 'settings.update', { theme: 'dark' })
    await shot(`${name}-dark`)
    await rpc(shell, 'settings.update', { theme: 'light' })
  }

  const spaceId = (await state(app)).activeSpaceId
  const tabs: string[] = []
  for (const name of ['Design review notes', 'Quarterly planning document', 'Inbox', 'Flight check-in', 'Reading list', 'Long article about browser engines and rendering pipelines', 'Weather', 'Mail', 'Calendar', 'Music'])
    tabs.push(await rpc<string>(shell, 'tabs.create', { url: `${page(name.toLowerCase().replaceAll(' ', '-'))}`, background: true }))
  await rpc(shell, 'tabs.activate', tabs[6])
  await waitForShown(app, '/page/weather')

  const reading = await rpc<string>(shell, 'folders.create', { name: 'Reading', index: 0 })
  const papers = await rpc<string>(shell, 'folders.create', { name: 'Papers and long reads to finish', parentId: reading, index: 0 })
  const work = await rpc<string>(shell, 'folders.create', { name: 'Work', index: 1 })
  const ideas = await rpc<string>(shell, 'folders.create', { name: 'Ideas', index: 2 })
  const save = (tabId: string, folderId: string, index: number) =>
    rpc(shell, 'tabs.move', tabId, { spaceId, pinned: false, folderId, index })
  await save(tabs[4]!, reading, 1)
  await save(tabs[5]!, papers, 0)
  await save(tabs[0]!, work, 0)
  await save(tabs[1]!, work, 1)
  // Top-level saved tabs between the folders (Arc's pinned tabs).
  const pin = (tabId: string, index: number) => rpc(shell, 'tabs.move', tabId, { spaceId, pinned: false, saved: true, index })
  await pin(tabs[7]!, 0)
  await pin(tabs[8]!, 2)
  await pin(tabs[9]!, 5)
  await expect.poll(async () => (await state(app)).spaces[0]!.savedIds).toEqual([tabs[7], reading, tabs[8], work, ideas, tabs[9]])
  await rpc(shell, 'tabs.close', tabs[9])
  await rpc(shell, 'folders.setCollapsed', work, true)
  await expect(folderRow(shell, work)).toHaveAttribute('aria-expanded', 'false')
  await expect(folderRow(shell, papers)).toBeVisible()
  await expect(shell.getByText(t('sidebar.folders.empty'))).toBeVisible()
  // One live folder tab, one closed (asleep) one.
  await rpc(shell, 'tabs.activate', tabs[4])
  await waitForShown(app, '/page/reading-list')
  await expect.poll(async () => (await state(app)).tabs[tabs[4]!]?.live).toBe(true)
  await rpc(shell, 'tabs.close', tabs[5])
  await expect.poll(async () => (await state(app)).tabs[tabs[5]!]?.live).toBe(false)
  await rpc(shell, 'tabs.activate', tabs[6])
  await waitForShown(app, '/page/weather')
  await shell.mouse.move(700, 400)

  await both('folders-tree')
  // Nothing in the tree overflows its row horizontally.
  const overflow = () =>
    shell.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-sidebar-scroll] *')].some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && !el.classList.contains('truncate'))
    )
  const widest = () =>
    shell.evaluate(() => {
      const box = document.querySelector('[data-sidebar-scroll]')!.getBoundingClientRect()
      return [...document.querySelectorAll('[data-tree-row]')].every((r) => r.getBoundingClientRect().right <= box.right + 0.5)
    })
  expect(await widest()).toBe(true)

  await rpc(shell, 'window.setSidebar', { width: 200 })
  await expect.poll(() => shell.evaluate(() => document.querySelector('aside')!.getBoundingClientRect().width)).toBe(200)
  expect(await widest()).toBe(true)
  expect(await overflow()).toBe(false)
  await both('folders-tree-min')

  // Inline rename at the minimum width.
  await folderRow(shell, papers).dblclick()
  await expect(renameInput(shell)).toBeFocused()
  await both('folders-rename-min')
  await shell.keyboard.press('Escape')
  await rpc(shell, 'window.setSidebar', { width: 260 })
  await expect.poll(() => shell.evaluate(() => document.querySelector('aside')!.getBoundingClientRect().width)).toBe(260)

  // Drag in progress: a today tab over a folder row (append), then between children.
  await drag(shell, todayTab(shell, tabs[3]!), folderRow(shell, reading), 'center', false)
  await expect(folderRow(shell, reading)).toHaveClass(/accent-soft/)
  await both('folders-drag-into')
  const target = (await treeTab(shell, tabs[4]!).boundingBox())!
  await shell.mouse.move(target.x + target.width / 2, target.y + 4, { steps: 4 })
  await frames(shell)
  await both('folders-drag-between')
  await shell.mouse.up()
  await expect.poll(async () => (await state(app)).folders[reading]?.childIds).toEqual([papers, tabs[3], tabs[4]])

  // A folder being dragged into another.
  await drag(shell, folderRow(shell, ideas), folderRow(shell, work), 'center', false)
  await both('folders-drag-folder')
  await shell.mouse.up()
  await expect.poll(async () => (await state(app)).folders[ideas]?.parentId).toBe(work)
})
