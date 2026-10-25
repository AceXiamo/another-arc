import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from '../fixtures/arc-sidebar'
import { inMain, launch, quit, removeDir, rpc, state, t, tempDir } from './helpers'

// Importing Arc's sidebar (StorableSidebar.json next to a fake "User Data"
// folder): spaces, nested folders, pinned tabs and favorites, without dialogs
// (showMessageBox is replaced in main and confirms).

test('imports the Arc sidebar into spaces, folders and favorites, and is safe to repeat', async () => {
  const arc = tempDir('arc-sidebar-')
  const root = join(arc, 'User Data')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(arc, 'StorableSidebar.json'), JSON.stringify(fixture()))
  const { app, shell, userData } = await launch(undefined, { ARC_IMPORT_ROOT: root })
  try {
    expect(await rpc(shell, 'import.arcSidebarSummary')).toEqual({ spaces: 2, folders: 2, tabs: 6, favorites: 1 })

    // Confirm every dialog; remember what was shown.
    await inMain(app, (_b, _a, electron) => {
      const shown: Array<{ message: string; detail?: string }> = []
      ;(globalThis as Record<string, unknown>).__dialogs = shown
      electron.dialog.showMessageBox = (async (...args: unknown[]) => {
        shown.push((args.length > 1 ? args[1] : args[0]) as { message: string })
        return { response: 0, checkboxChecked: false }
      }) as typeof electron.dialog.showMessageBox
    })
    const dialogs = () => inMain(app, () => (globalThis as unknown as { __dialogs: Array<{ message: string }> }).__dialogs)

    const before = await state(app)
    await rpc(shell, 'import.arcSidebar')
    expect((await dialogs()).map((d) => d.message)).toEqual([t('arcImport.confirm.message'), t('arcImport.result.message')])

    const s = await state(app)
    // Arc's unnamed space lands in the first space; "Work" is created.
    expect(s.spaces.map((x) => x.name)).toEqual([before.spaces[0]!.name, 'Work'])
    const [personal, work] = s.spaces
    const title = (id: string) => s.tabs[id]?.title ?? s.folders[id]?.name
    expect(personal!.savedIds.map(title)).toEqual(['Reading', 'Renamed One', 'saved s1', 'saved s2'])
    const reading = s.folders[personal!.savedIds[0]!]!
    expect(reading.collapsed).toBe(true)
    expect(reading.childIds.map(title)).toEqual(['saved t2', 'Papers'])
    const papers = s.folders[reading.childIds[1]!]!
    expect(papers.childIds.map((id) => s.tabs[id]!.savedUrl)).toEqual(['https://three.test/a?b=c'])
    expect(work!.savedIds.map((id) => s.tabs[id]!.url)).toEqual(['https://work.test/'])
    // Favorites become pinned tiles of the first space.
    expect(personal!.pinnedTabIds.map((id) => s.tabs[id]!.url)).toEqual(['https://fav.test/'])
    // Nothing loads and nothing gets selected.
    expect(Object.values(s.tabs).some((tab) => tab.live)).toBe(false)
    expect(personal!.activeTabId).toBeNull()
    expect(work!.activeTabId).toBeNull()
    // The shell renders the imported tree.
    await expect(shell.locator(`[data-tree-row="folder"][data-id="${personal!.savedIds[0]}"]`)).toBeVisible()

    // Again: everything is already here.
    await rpc(shell, 'import.arcSidebar')
    const again = await state(app)
    expect(Object.keys(again.tabs).length).toBe(Object.keys(s.tabs).length)
    expect(Object.keys(again.folders).length).toBe(Object.keys(s.folders).length)
    expect(again.spaces.length).toBe(2)
  } finally {
    await quit(app)
    removeDir(userData)
    removeDir(arc)
  }
})

test('offers the import once on a fresh profile', async () => {
  const arc = tempDir('arc-offer-')
  const root = join(arc, 'User Data')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(arc, 'StorableSidebar.json'), JSON.stringify(fixture()))
  const userData = tempDir()
  const stubDialogs = (app: Parameters<typeof inMain>[0], response: number) =>
    inMain(
      app,
      (_b, answer: number, electron) => {
        const shown: string[] = []
        ;(globalThis as Record<string, unknown>).__dialogs = shown
        electron.dialog.showMessageBox = (async (...args: unknown[]) => {
          shown.push(((args.length > 1 ? args[1] : args[0]) as { message: string }).message)
          return { response: answer, checkboxChecked: false }
        }) as typeof electron.dialog.showMessageBox
      },
      response
    )
  const shown = (app: Parameters<typeof inMain>[0]) => inMain(app, () => (globalThis as unknown as { __dialogs: string[] }).__dialogs)
  try {
    // "Not Now": nothing imported, and it is not asked again.
    let run = await launch(userData, { ARC_IMPORT_ROOT: root })
    await stubDialogs(run.app, 1)
    await inMain(run.app, (b) => b.offerArcImport())
    expect(await shown(run.app)).toEqual([t('browserImport.all.message', { browser: 'Arc' })])
    expect((await state(run.app)).spaces[0]!.savedIds).toEqual([])
    await inMain(run.app, (b) => b.offerArcImport())
    expect(await shown(run.app)).toHaveLength(1)
    await quit(run.app)

    // Still not asked after a restart (the choice is persisted)…
    run = await launch(userData, { ARC_IMPORT_ROOT: root })
    await stubDialogs(run.app, 0)
    await inMain(run.app, (b) => b.offerArcImport())
    expect(await shown(run.app)).toEqual([])
    // …but File → Import from Browser still works, sidebar and all.
    await rpc(run.shell, 'import.run', 'arc')
    expect(await shown(run.app)).toEqual([
      t('browserImport.all.message', { browser: 'Arc' }),
      t('browserImport.result.message', { browser: 'Arc' })
    ])
    const s = await state(run.app)
    expect(s.spaces.map((x) => x.name)).toContain('Work')
    expect(Object.keys(s.folders)).toHaveLength(2)
    await quit(run.app)
  } finally {
    removeDir(userData)
    removeDir(arc)
  }
})

test('the offer imports everything when accepted on a fresh profile', async () => {
  const arc = tempDir('arc-offer-yes-')
  const root = join(arc, 'User Data')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(arc, 'StorableSidebar.json'), JSON.stringify(fixture()))
  const { app, userData } = await launch(undefined, { ARC_IMPORT_ROOT: root })
  try {
    await inMain(app, (_b, _a, electron) => {
      electron.dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
    })
    await inMain(app, (b) => b.offerArcImport())
    const s = await state(app)
    expect(s.spaces[0]!.savedIds.length).toBe(4)
    expect(s.spaces[0]!.pinnedTabIds.length).toBe(1)
  } finally {
    await quit(app)
    removeDir(userData)
    removeDir(arc)
  }
})

test('Settings lists each browser with what it would bring over, and imports it', async () => {
  const arc = tempDir('arc-settings-')
  const root = join(arc, 'User Data')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(arc, 'StorableSidebar.json'), JSON.stringify(fixture()))
  const { app, shell, userData } = await launch(undefined, { ARC_IMPORT_ROOT: root })
  try {
    await rpc(shell, 'tabs.openInternal', 'settings')
    await expect(shell.getByRole('heading', { name: t('browserImport.settings.section') })).toBeVisible()
    // One row per installed browser; ARC_IMPORT_ROOT leaves only Arc.
    await expect(shell.getByText('Arc', { exact: true })).toBeVisible()
    await expect(shell.getByText(t('browserImport.settings.bookmarks', { tabs: 6, folders: 2 }))).toBeVisible()

    await inMain(app, (_b, _a, electron) => {
      electron.dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
    })
    await shell.getByRole('button', { name: t('browserImport.settings.import') }).click()
    await expect
      .poll(async () => (await state(app)).spaces[0]!.savedIds.length, { timeout: 5000 })
      .toBe(4)
  } finally {
    await quit(app)
    removeDir(userData)
    removeDir(arc)
  }
})
