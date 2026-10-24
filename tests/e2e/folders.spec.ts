import { expect, test } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, startServer, state, t, tempDir, waitForShown } from './helpers'

// Main-process semantics of sidebar folders (saved tabs). The UI side is
// covered by folders-ui.spec.ts.

test('folder tabs are bookmarks: closing unloads and resets, deleting removes', async () => {
  const { url, server } = await startServer()
  const { app, shell, userData } = await launch()
  try {
    const spaceId = (await state(app)).activeSpaceId
    const open = await rpc<string>(shell, 'tabs.create', { url: `${url}/page/open` })
    await waitForShown(app, '/page/open')
    const saved = await rpc<string>(shell, 'tabs.create', { url: `${url}/page/saved` })
    await waitForShown(app, '/page/saved')

    const folderId = await rpc<string>(shell, 'folders.create', { spaceId, name: '  Reading  ', tabIds: [saved] })
    let s = await state(app)
    expect(s.folders[folderId]).toMatchObject({ name: 'Reading', parentId: null, childIds: [saved] })
    expect(s.spaces[0]!.savedIds).toEqual([folderId])
    expect(s.spaces[0]!.tabIds).toEqual([open])
    expect(s.tabs[saved]).toMatchObject({ folderId, savedUrl: `${url}/page/saved`, pinned: false })

    // Navigate away, then close: back to the saved page, unloaded, still in the folder.
    await rpc(shell, 'tabs.navigate', saved, `${url}/page/elsewhere`)
    await waitForShown(app, '/page/elsewhere')
    await rpc(shell, 'tabs.close', saved)
    await waitForShown(app, '/page/open')
    s = await state(app)
    expect(s.tabs[saved]).toMatchObject({ url: `${url}/page/saved`, live: false, folderId })
    expect(s.spaces[0]!.activeTabId).toBe(open)

    // Clicking it again loads the saved page.
    await rpc(shell, 'tabs.activate', saved)
    await waitForShown(app, '/page/saved')

    // Reopen-closed after a delete puts it back in its folder.
    await inMain(app, (b, id: string) => b.tabs.deleteTab(id), saved)
    s = await state(app)
    expect(s.tabs[saved]).toBeUndefined()
    expect(s.folders[folderId]!.childIds).toEqual([])
    await rpc(shell, 'tabs.reopenClosed')
    s = await state(app)
    const back = s.folders[folderId]!.childIds[0]!
    expect(s.tabs[back]).toMatchObject({ folderId, savedUrl: `${url}/page/saved` })

    // Deleting a non-empty folder asks first; declining keeps it.
    await inMain(app, (b) => {
      b.confirm = async () => false
    })
    await rpc(shell, 'folders.delete', folderId)
    expect((await state(app)).folders[folderId]).toBeDefined()
    await inMain(app, (b) => {
      b.confirm = async () => true
    })
    await rpc(shell, 'folders.delete', folderId)
    s = await state(app)
    expect(s.folders[folderId]).toBeUndefined()
    expect(s.tabs[back]).toBeUndefined()
    expect(s.spaces[0]!.savedIds).toEqual([])
  } finally {
    await quit(app)
    server.close()
    removeDir(userData)
  }
})

test('folders, nesting, collapse state and folder tabs survive a restart', async () => {
  const { url, server } = await startServer()
  const userData = tempDir()
  try {
    let run = await launch(userData)
    const spaceId = (await state(run.app)).activeSpaceId
    const work = await rpc<string>(run.shell, 'folders.create', { spaceId, name: 'Work' })
    const docs = await rpc<string>(run.shell, 'folders.create', { parentId: work, name: 'Docs' })
    const misc = await rpc<string>(run.shell, 'folders.create', { spaceId, name: 'Misc', index: 1 })
    const a = await rpc<string>(run.shell, 'tabs.create', { url: `${url}/page/a` })
    const bTab = await rpc<string>(run.shell, 'tabs.create', { url: `${url}/page/b` })
    const c = await rpc<string>(run.shell, 'tabs.create', { url: `${url}/page/c` })
    await waitForShown(run.app, '/page/c')
    // Mixed children: Work = [a, Docs]; Docs = [b]; Misc stays empty.
    await rpc(run.shell, 'tabs.move', a, { spaceId, pinned: false, folderId: work, index: 0 })
    await rpc(run.shell, 'tabs.move', bTab, { spaceId, pinned: false, folderId: docs, index: 0 })
    await rpc(run.shell, 'folders.setCollapsed', docs, true)
    await rpc(run.shell, 'folders.rename', misc, '')

    let s = await state(run.app)
    expect(s.spaces[0]!.savedIds).toEqual([work, misc])
    expect(s.folders[work]!.childIds).toEqual([a, docs])
    expect(s.folders[misc]!.name).toBe(t('folder.defaultName'))
    // Cycling skips the tab hidden in the collapsed folder.
    expect(await inMain(run.app, (b, sid: string) => b.tabs.model.visibleTabIds(sid), spaceId)).toEqual([a, c])

    // A folder cannot move into its own subtree.
    await rpc(run.shell, 'folders.move', work, { parentId: docs, index: 0 })
    expect((await state(run.app)).folders[work]!.parentId).toBeNull()
    const before = await state(run.app)
    await quit(run.app)

    run = await launch(userData)
    s = await state(run.app)
    expect(s.spaces[0]!.savedIds).toEqual(before.spaces[0]!.savedIds)
    expect(s.spaces[0]!.tabIds).toEqual([c])
    for (const id of [work, docs, misc]) expect(s.folders[id]).toEqual(before.folders[id])
    for (const id of [a, bTab]) {
      expect(s.tabs[id]).toMatchObject({ folderId: before.tabs[id]!.folderId, savedUrl: before.tabs[id]!.savedUrl })
    }
    // The shell boots with the folders in its snapshot.
    const snapshot = await rpc<{ folders: Record<string, { childIds: string[] }> }>(run.shell, 'shell.snapshot')
    expect(snapshot.folders[work]!.childIds).toEqual([a, docs])
    await quit(run.app)
  } finally {
    server.close()
    removeDir(userData)
  }
})
