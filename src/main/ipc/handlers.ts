import { app, clipboard, ClipboardItem, dialog, Menu, nativeImage, ShareMenu, systemPreferences, type MenuItemConstructorOptions } from 'electron'
import { isSpaceIconId } from '@shared/defaults'
import { AGENT_SNIPPETS } from '@shared/agent'
import { IMPORT_BROWSERS } from '@shared/ext-import'
import type { Translate } from '@shared/i18n'
import { outPath } from '../app/environment'
import { describeError } from '../app/i18n'
import { SURFACES } from '@shared/layout'
import { isSavedTab } from '@shared/tabs'
import { SPACE_APPEARANCES, THEME_LIMITS } from '@shared/theme'
import { summarizeSidebar } from '../import/arc-sidebar'
import { importArcSidebarWithDialogs, loadArcSidebar } from '../import/sidebar-import'
import { INTERNAL_PAGES, isInternalUrl, SEARCH_ENGINES, type InternalPage } from '@shared/url'
import type { SearchEngineId } from '@shared/types'
import type { Browser } from '../app/browser'
import type { RpcRouter } from './router'
import { tuple, v, type Validator } from './validate'

const id = v.id()
const color = (value: unknown, path: string) => {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid color at ${path}`)
  return value
}
const point = v.object({ x: v.number(), y: v.number() })
// Shape only: numbers are clamped and merged by sanitizeSpaceTheme in TabManager.
const spaceTheme = v.object({
  gradient: v.optional(v.array(color, THEME_LIMITS.gradientStops)),
  angle: v.optional(v.number()),
  intensity: v.optional(v.number()),
  noise: v.optional(v.number()),
  appearance: v.optional(v.oneOf(SPACE_APPEARANCES))
})
const spaceInput = v.object({
  name: v.string({ max: 200 }),
  icon: v.string({ max: 32 }),
  color,
  theme: v.optional(spaceTheme)
})
const partialSpaceInput = v.object({
  name: v.optional(v.string({ max: 200 })),
  icon: v.optional(v.string({ max: 32 })),
  color: v.optional(color),
  theme: v.optional(spaceTheme)
})
const internalPage = v.oneOf(Object.keys(INTERNAL_PAGES) as InternalPage[])
const surfaceId = v.oneOf(Object.keys(SURFACES) as Array<keyof typeof SURFACES>)

const menuIcons = new Map<string, Electron.NativeImage>()

/** 16pt menu image for a space icon id (undefined for legacy text icons). */
function spaceMenuIcon(icon: string): Electron.NativeImage | undefined {
  if (!isSpaceIconId(icon)) return undefined
  let image = menuIcons.get(icon)
  if (!image) {
    image = nativeImage.createFromPath(outPath('renderer', 'space-icons', `${icon}.png`)).resize({ width: 16, height: 16 })
    // Template images are tinted by macOS to match the menu (light/dark/highlight).
    image.setTemplateImage(true)
    menuIcons.set(icon, image)
  }
  return image
}

/** Binds every ShellRpc method to the browser services. */
export function registerHandlers(router: RpcRouter, b: Browser): void {
  const { tabs } = b
  /** Always the current UI language (it can change at runtime). */
  const t: Translate = (key, params) => b.t(key, params)
  const popupAt = (template: MenuItemConstructorOptions[], at: { x: number; y: number }) => {
    const window = b.window?.win
    Menu.buildFromTemplate(template).popup({ ...(window ? { window } : {}), x: Math.round(at.x), y: Math.round(at.y) })
  }

  // -- shell ------------------------------------------------------------------
  router.handle('shell.snapshot', tuple(), () => b.snapshot())
  router.handle('shell.ready', tuple(), () => b.onShellReady())

  // -- tabs -------------------------------------------------------------------
  router.handle(
    'tabs.create',
    tuple(
      v.object({
        url: v.optional(v.string({ max: 1 << 16 })),
        spaceId: v.optional(id),
        background: v.optional(v.boolean()),
        pinned: v.optional(v.boolean()),
        index: v.optional(v.number({ int: true, min: 0 }))
      })
    ),
    (_ctx, opts) => {
      if (opts.url !== undefined) return tabs.openInput(opts.url, opts)?.id ?? ''
      return tabs.createTab(opts).id
    }
  )
  router.handle('tabs.activate', tuple(id), (_c, tabId) => tabs.activateTab(tabId))
  router.handle('tabs.close', tuple(id), (_c, tabId) => tabs.closeTab(tabId))
  router.handle('tabs.navigate', tuple(id, v.string({ max: 1 << 16 })), (_c, tabId, input) => tabs.navigate(tabId, input))
  router.handle('tabs.reload', tuple(id, v.boolean()), (_c, tabId, hard) => tabs.reload(tabId, hard))
  router.handle('tabs.stop', tuple(id), (_c, tabId) => tabs.stop(tabId))
  router.handle('tabs.goBack', tuple(id), (_c, tabId) => tabs.goBack(tabId))
  router.handle('tabs.goForward', tuple(id), (_c, tabId) => tabs.goForward(tabId))
  router.handle(
    'tabs.move',
    tuple(
      id,
      v.object({
        spaceId: id,
        pinned: v.boolean(),
        folderId: v.optional(v.nullable(id)),
        saved: v.optional(v.boolean()),
        index: v.number({ int: true, min: 0, max: 100_000 })
      })
    ),
    (_c, tabId, target) => tabs.moveTab(tabId, target)
  )
  router.handle('tabs.duplicate', tuple(id), (_c, tabId) => tabs.duplicateTab(tabId))
  router.handle('tabs.setMuted', tuple(id, v.boolean()), (_c, tabId, muted) => tabs.setMuted(tabId, muted))
  router.handle('tabs.reopenClosed', tuple(), () => tabs.reopenClosedTab())
  router.handle('tabs.copyUrl', tuple(id), (_c, tabId) => tabs.copyUrl(tabId))
  router.handle('tabs.share', tuple(id, point), (_c, tabId, at) => {
    const tab = tabs.model.getTab(tabId)
    if (!tab || isInternalUrl(tab.url)) return
    const window = b.window?.win
    new ShareMenu({ urls: [tab.url] }).popup({ ...(window ? { window } : {}), x: Math.round(at.x), y: Math.round(at.y) })
  })
  router.handle('tabs.copyScreenshot', tuple(id), async (_c, tabId) => {
    const wc = tabs.runtime(tabId)?.wc
    if (!wc || wc.isDestroyed()) return false
    const png = (await wc.capturePage()).toPNG()
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    return true
  })
  router.handle('tabs.siteMenu', tuple(id, point), (_c, tabId, at) => {
    const tab = tabs.model.getTab(tabId)
    if (!tab) return
    const live = tabs.runtime(tabId) !== undefined
    popupAt(
      [
        { label: t('siteMenu.copyUrl'), enabled: !isInternalUrl(tab.url), click: () => tabs.copyUrl(tabId) },
        { label: t('siteMenu.print'), enabled: live, click: () => tabs.print(tabId) },
        { label: t('siteMenu.devtools'), enabled: live, click: () => tabs.toggleDevTools(tabId) },
        { type: 'separator' },
        { label: t('siteMenu.siteSettings'), click: () => b.openInternal('settings') }
      ],
      at
    )
  })
  router.handle('tabs.allowCertificate', tuple(id), (_c, tabId) => b.allowCertificate(tabId))
  router.handle('tabs.openInternal', tuple(internalPage), (_c, page) => b.openInternal(page))

  // -- default browser ----------------------------------------------------------
  const isDefaultBrowser = () => app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https')
  router.handle('defaultBrowser.get', tuple(), isDefaultBrowser)
  router.handle('defaultBrowser.set', tuple(), () => {
    // macOS asks the user to confirm ("Use Another Arc or keep …?") and only
    // then switches, so the answer here may still be false; the page asks again.
    app.setAsDefaultProtocolClient('http')
    app.setAsDefaultProtocolClient('https')
    return isDefaultBrowser()
  })
  router.handle('tabs.contextMenu', tuple(id, point), (_c, tabId, at) => {
    const tab = tabs.model.getTab(tabId)
    if (!tab) return
    const rt = tabs.runtime(tabId)
    const otherSpaces = tabs.model.spaceOrder
      .filter((s) => s !== tab.spaceId)
      .map((s) => tabs.model.getSpace(s)!)
    const folderTargets: MenuItemConstructorOptions[] = [
      ...folderChoices(tab.spaceId)
        .filter((f) => f.id !== tab.folderId)
        .map((f) => ({ label: f.label, click: () => tabs.saveToFolder(tabId, f.id) })),
      { type: 'separator' },
      { label: t('sidebarMenu.newFolder'), click: () => newFolder({ spaceId: tab.spaceId, tabIds: [tabId] }) }
    ]
    const saved = isSavedTab(tab)
    const folderItems: MenuItemConstructorOptions[] = saved
      ? [
          ...(tab.url !== tab.savedUrl
            ? [
                { label: t('tabMenu.backToSaved'), click: () => tabs.backToSaved(tabId) },
                { label: t('tabMenu.updateSaved'), click: () => tabs.updateSaved(tabId) }
              ]
            : []),
          { label: t('tabMenu.moveToFolder'), submenu: folderTargets },
          ...(tab.folderId ? [{ label: t('tabMenu.removeFromFolder'), click: () => tabs.removeFromFolder(tabId) }] : [])
        ]
      : [{ label: t('tabMenu.addToFolder'), submenu: folderTargets }]
    const closeItems: MenuItemConstructorOptions[] = saved
      ? [
          ...(rt ? [{ label: t('tabMenu.unload'), click: () => tabs.closeTab(tabId) }] : []),
          { label: t('tabMenu.deleteSaved'), click: () => tabs.deleteTab(tabId) }
        ]
      : [
          { label: t('tabMenu.close'), click: () => tabs.closeTab(tabId) },
          { label: t('tabMenu.closeBelow'), click: () => tabs.closeTabsBelow(tabId) },
          { label: t('tabMenu.closeOthers'), click: () => tabs.closeOtherTabs(tabId) }
        ]
    popupAt(
      [
        // A favorite only leaves through "Remove from Favorites".
        ...(tab.pinned
          ? []
          : [
              {
                label: t(saved ? 'tabMenu.unsave' : 'tabMenu.save'),
                accelerator: 'Command+D',
                registerAccelerator: false,
                click: () => tabs.toggleSaved(tabId)
              }
            ]),
        { label: t(tab.pinned ? 'tabMenu.unpin' : 'tabMenu.pin'), click: () => tabs.togglePinned(tabId) },
        { label: t('tabMenu.duplicate'), click: () => tabs.duplicateTab(tabId) },
        { label: t('tabMenu.copyUrl'), click: () => tabs.copyUrl(tabId) },
        { type: 'separator' },
        { label: t('tabMenu.reload'), click: () => tabs.reload(tabId) },
        {
          label: t(tab.muted ? 'tabMenu.unmute' : 'tabMenu.mute'),
          click: () => tabs.setMuted(tabId, !tab.muted)
        },
        ...(rt ? [{ label: t('tabMenu.discard'), click: () => tabs.discardTab(tabId) }] : []),
        {
          label: t('tabMenu.moveToSpace'),
          enabled: otherSpaces.length > 0,
          submenu: otherSpaces.map((s) => ({
            label: s.name,
            icon: spaceMenuIcon(s.icon),
            click: () => tabs.moveTabToSpace(tabId, s.id)
          }))
        },
        { type: 'separator' },
        ...folderItems,
        { type: 'separator' },
        ...closeItems
      ],
      at
    )
  })

  // -- folders ----------------------------------------------------------------
  /** Folders of a space, depth first, indented by nesting (for native menus). */
  const folderChoices = (spaceId: string) => {
    const out: Array<{ id: string; label: string }> = []
    const walk = (ids: readonly string[], depth: number) => {
      for (const childId of ids) {
        const folder = tabs.model.getFolder(childId)
        if (!folder) continue
        out.push({ id: folder.id, label: `${' '.repeat(depth)}${folder.name}` })
        walk(folder.childIds, depth + 1)
      }
    }
    walk(tabs.model.getSpace(spaceId)?.savedIds ?? [], 0)
    return out
  }
  /** Create a folder from a native menu, then let the shell show its rename field. */
  const newFolder = (opts: { spaceId?: string; parentId?: string; tabIds?: string[] }) => {
    const parent = opts.parentId ? tabs.model.getFolder(opts.parentId) : undefined
    const space = tabs.model.getSpace(parent?.spaceId ?? opts.spaceId ?? tabs.model.activeSpaceId)
    const index = parent ? parent.childIds.length : (space?.savedIds.length ?? 0)
    const folderId = tabs.createFolder({ ...opts, spaceId: space?.id, index })
    if (!folderId) return
    if (parent) tabs.setFolderCollapsed(parent.id, false)
    b.shell.command({ type: 'folder.rename', folderId })
  }
  const deleteFolder = async (folderId: string) => {
    const folder = tabs.model.getFolder(folderId)
    if (!folder) return
    const count = tabs.model.folderSubtree(folderId).tabs.length
    const ok =
      count === 0 ||
      (await b.confirm(t('dialog.deleteFolder.title', { name: folder.name }), t('dialog.deleteFolder.detail', { count })))
    if (ok) tabs.deleteFolder(folderId)
  }

  router.handle(
    'folders.create',
    tuple(
      v.object({
        spaceId: v.optional(id),
        parentId: v.optional(v.nullable(id)),
        index: v.optional(v.number({ int: true, min: 0, max: 100_000 })),
        name: v.optional(v.string({ max: 200 })),
        tabIds: v.optional(v.array(id, 500))
      })
    ),
    (_c, opts) => tabs.createFolder(opts) ?? ''
  )
  router.handle('folders.rename', tuple(id, v.string({ max: 200 })), (_c, folderId, name) => tabs.renameFolder(folderId, name))
  router.handle('folders.setCollapsed', tuple(id, v.boolean()), (_c, folderId, collapsed) =>
    tabs.setFolderCollapsed(folderId, collapsed)
  )
  router.handle(
    'folders.move',
    tuple(id, v.object({ parentId: v.nullable(id), index: v.number({ int: true, min: 0, max: 100_000 }) })),
    (_c, folderId, target) => tabs.moveFolder(folderId, target)
  )
  router.handle('folders.delete', tuple(id), (_c, folderId) => deleteFolder(folderId))
  router.handle('folders.contextMenu', tuple(id, point), (_c, folderId, at) => {
    const folder = tabs.model.getFolder(folderId)
    if (!folder) return
    popupAt(
      [
        { label: t('folderMenu.rename'), click: () => b.shell.command({ type: 'folder.rename', folderId }) },
        { label: t('folderMenu.newFolder'), click: () => newFolder({ parentId: folderId }) },
        { type: 'separator' },
        { label: t('folderMenu.delete'), click: () => void deleteFolder(folderId) }
      ],
      at
    )
  })
  router.handle('sidebar.contextMenu', tuple(id, point), (_c, spaceId, at) => {
    if (!tabs.model.getSpace(spaceId)) return
    popupAt(
      [
        { label: t('sidebarMenu.newFolder'), click: () => newFolder({ spaceId }) },
        { type: 'separator' },
        { label: t('spaceMenu.edit'), click: () => b.shell.command({ type: 'space.edit', spaceId }) },
        { label: t('theme.menu.edit'), click: () => b.shell.command({ type: 'space.edit', spaceId, theme: true }) },
        { label: t('sidebarMenu.newSpace'), click: () => b.shell.command({ type: 'space.edit', spaceId: 'new' }) }
      ],
      at
    )
  })

  // -- spaces -----------------------------------------------------------------
  router.handle('spaces.create', tuple(spaceInput), (_c, input) => {
    const spaceId = tabs.createSpace(input)
    tabs.activateSpace(spaceId)
    return spaceId
  })
  router.handle('spaces.update', tuple(id, partialSpaceInput), (_c, spaceId, input) => tabs.updateSpace(spaceId, input))
  router.handle('spaces.delete', tuple(id), async (_c, spaceId) => {
    const space = tabs.model.getSpace(spaceId)
    if (!space || tabs.model.spaces.size <= 1) return
    const count = tabs.model.allTabIds(spaceId).length
    const ok =
      count === 0 ||
      (await b.confirm(t('dialog.deleteSpace.title', { name: space.name }), t('dialog.deleteSpace.detail', { count })))
    if (ok) tabs.deleteSpace(spaceId)
  })
  router.handle('spaces.activate', tuple(id), (_c, spaceId) => tabs.activateSpace(spaceId))
  router.handle('spaces.reorder', tuple(v.array(id, 200)), (_c, order) => tabs.model.reorderSpaces(order))
  router.handle('spaces.contextMenu', tuple(id, point), (_c, spaceId, at) => {
    const space = tabs.model.getSpace(spaceId)
    if (!space) return
    popupAt(
      [
        { label: t('spaceMenu.edit'), click: () => b.shell.command({ type: 'space.edit', spaceId }) },
        { label: t('theme.menu.edit'), click: () => b.shell.command({ type: 'space.edit', spaceId, theme: true }) },
        { type: 'separator' },
        {
          label: t('spaceMenu.delete'),
          enabled: tabs.model.spaces.size > 1,
          click: () => {
            const count = tabs.model.allTabIds(spaceId).length
            void b
              .confirm(t('dialog.deleteSpace.title', { name: space.name }), t('dialog.deleteSpace.detail', { count }))
              .then((ok) => ok && tabs.deleteSpace(spaceId))
          }
        }
      ],
      at
    )
  })

  // -- window -----------------------------------------------------------------
  router.handle(
    'window.setSidebar',
    tuple(v.object({ width: v.optional(v.number({ min: 0, max: 4000 })), collapsed: v.optional(v.boolean()) })),
    (_c, opts) => b.setSidebar(opts)
  )
  router.handle('window.setOverlay', tuple(v.boolean()), (_c, open) => b.setOverlay(open))
  router.handle('window.focusPage', tuple(), () => b.window?.focusPage())
  router.handle('window.drag', tuple(v.oneOf(['start', 'end'] as const)), (_c, phase) =>
    phase === 'start' ? b.window?.beginDrag() : b.window?.endDrag()
  )
  router.handle('window.titleBarDoubleClick', tuple(), () => b.window?.titleBarDoubleClick())
  router.handle(
    'sitePanel.place',
    tuple(
      v.object({
        x: v.number({ min: -10_000, max: 100_000 }),
        y: v.number({ min: -10_000, max: 100_000 }),
        width: v.number({ min: 1, max: 2000 }),
        height: v.number({ min: 1, max: 4000 })
      })
    ),
    (_c, bounds) => b.placeSitePanel(bounds)
  )
  router.handle('surface.setVisible', tuple(surfaceId, v.boolean()), (_c, surface, visible) =>
    b.setSurfaceVisible(surface, visible)
  )

  // -- history ----------------------------------------------------------------
  router.handle('history.suggest', tuple(v.string({ max: 2048 }), v.number({ int: true, min: 1, max: 50 })), (_c, q, limit) =>
    b.history.suggest(q, limit)
  )
  router.handle(
    'history.list',
    tuple(v.string({ max: 2048 }), v.number({ min: 0 }), v.number({ int: true, min: 1, max: 500 })),
    (_c, q, before, limit) => b.history.list(q, before, limit)
  )
  router.handle('history.delete', tuple(v.array(v.number({ int: true, min: 0 }), 5000)), (_c, ids) =>
    b.history.deleteVisits(ids)
  )
  router.handle('history.clear', tuple(), async () => {
    if (await b.confirm(t('dialog.clearHistory.title'), t('dialog.clearHistory.detail'))) b.history.clear()
  })

  // -- settings ---------------------------------------------------------------
  router.handle('settings.update', tuple(v.record()), (_c, patch) => {
    b.settings.update(patch)
  })
  router.handle('settings.pickDownloadDir', tuple(), async () => {
    const win = b.window?.win
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] }
    const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const dir = res.canceled ? null : (res.filePaths[0] ?? null)
    if (dir) b.settings.update({ downloadDir: dir })
    return dir
  })
  router.handle('settings.searchEngines', tuple(), () =>
    (Object.entries(SEARCH_ENGINES) as Array<[SearchEngineId, { name: string; template: string }]>).map(([engineId, e]) => ({
      id: engineId,
      name: e.name,
      template: e.template
    }))
  )

  // -- extensions -------------------------------------------------------------
  const extId = v.string({ min: 1, max: 64 })
  router.handle('extensions.install', tuple(), async () => {
    try {
      return await b.extensions.installFromDialog(b.window?.win ?? null)
    } catch (error) {
      await dialog.showMessageBox({ type: 'error', message: t('dialog.installFailed'), detail: describeError(error, t) })
      return null
    }
  })
  router.handle('extensions.setEnabled', tuple(extId, v.boolean()), (_c, extensionId, enabled) =>
    b.extensions.setEnabled(extensionId, enabled)
  )
  router.handle('extensions.setPinned', tuple(extId, v.boolean()), (_c, extensionId, pinned) =>
    b.extensions.setPinned(extensionId, pinned)
  )
  router.handle('extensions.uninstall', tuple(extId), async (_c, extensionId) => {
    const ext = b.extensions.info().find((e) => e.id === extensionId)
    if (ext && (await b.confirm(t('dialog.uninstall.title', { name: ext.name }), t('dialog.uninstall.detail')))) {
      await b.extensions.uninstall(extensionId)
    }
  })
  router.handle('extensions.update', tuple(extId), async (_c, extensionId) => {
    try {
      await b.extensions.update(extensionId)
    } catch (error) {
      await dialog.showMessageBox({ type: 'error', message: t('dialog.updateFailed'), detail: describeError(error, t) })
    }
  })
  router.handle('extensions.openOptions', tuple(extId), (_c, extensionId) => b.extensions.openOptions(extensionId))
  router.handle('extensions.reload', tuple(extId), (_c, extensionId) => b.extensions.reload(extensionId))
  router.handle('extensions.setUserScripts', tuple(extId, v.boolean()), (_c, extensionId, allowed) =>
    b.extensions.setUserScriptsAllowed(extensionId, allowed)
  )
  router.handle('extensions.setFileAccess', tuple(extId, v.boolean()), (_c, extensionId, allowed) =>
    b.extensions.setFileAccess(extensionId, allowed)
  )
  router.handle('extensions.setShortcut', tuple(extId, v.string({ min: 1, max: 128 }), v.string({ max: 64 })), (_c, extensionId, command, shortcut) =>
    b.extensions.setShortcut(extensionId, command, shortcut)
  )
  router.handle('downloads.flightLayer', tuple(v.boolean()), (_c, visible) => b.setFlightLayerVisible(visible))
  router.handle('extensions.recordShortcut', tuple(v.boolean()), (_c, recording) => b.setShortcutRecording(recording))
  router.handle('extensions.details', tuple(extId), (_c, extensionId) => b.extensions.details(extensionId))
  router.handle('extensions.clearErrors', tuple(extId), (_c, extensionId) => b.extensions.clearErrors(extensionId))
  router.handle('extensions.reveal', tuple(extId), (_c, extensionId) => b.extensions.reveal(extensionId))
  router.handle('extensions.contextMenu', tuple(extId, point), (_c, extensionId, at) => {
    const ext = b.extensions.info().find((e) => e.id === extensionId)
    if (!ext) return
    popupAt(
      [
        { label: ext.name, enabled: false },
        { type: 'separator' },
        ...(ext.optionsUrl ? [{ label: t('extMenu.options'), click: () => b.extensions.openOptions(extensionId) }] : []),
        { label: t(ext.pinned ? 'extMenu.unpin' : 'extMenu.pin'), click: () => b.extensions.setPinned(extensionId, !ext.pinned) },
        { label: t('extMenu.manage'), click: () => b.openInternal('extensions') }
      ],
      at
    )
  })
  // Import from another browser's profile (see import/browsers.ts).
  const importBrowser = v.oneOf(IMPORT_BROWSERS)
  /** Browser id → profile directory; entries that are not plain names are dropped. */
  const chosenProfiles: Validator<Record<string, string>> = (value, path) => {
    const out: Record<string, string> = {}
    for (const [browser, dir] of Object.entries(v.record()(value, path))) {
      if (typeof dir === 'string' && dir.length > 0 && dir.length <= 64 && !dir.includes('/')) out[browser] = dir
    }
    return out
  }
  router.handle('extensions.importSources', tuple(), () => b.extensions.importSummaries())
  router.handle('extensions.importFromBrowser', tuple(importBrowser), async (_c, source) => {
    // Per-extension failures are reported in the result dialog; anything
    // unexpected is only logged.
    await b.extensions.importFromDialog(source, b.window?.win ?? null).catch((error) => console.error('[ext-import]', error))
  })
  // Arc's sidebar: spaces, folders, pinned tabs and favorites (see import/arc-sidebar-import.ts).
  router.handle('import.arcSidebarSummary', tuple(), async () => {
    const sidebar = await loadArcSidebar()
    return sidebar ? summarizeSidebar(sidebar) : null
  })
  router.handle('import.browsers', tuple(v.optional(chosenProfiles)), (_c, chosen) => b.importableBrowsers(chosen))
  router.handle('import.run', tuple(importBrowser, v.optional(v.string({ max: 64 }))), (_c, browser, profileDir) =>
    b.importFrom(browser, profileDir)
  )
  router.handle('import.best', tuple(), () => b.importFromBestBrowser())
  router.handle('import.arcSidebar', tuple(), async () => {
    await importArcSidebarWithDialogs(tabs, b.favicons, b.window?.win ?? null, t).catch((error) =>
      console.error('[arc-import]', error)
    )
  })

  // -- saved logins -----------------------------------------------------------
  const pw = b.passwords
  router.handle('passwords.list', tuple(), () => pw.store.list())
  router.handle('passwords.available', tuple(), () => pw.store.available)
  router.handle('passwords.fill', tuple(v.id()), (_c, id) => pw.fill(id))
  router.handle('passwords.dismiss', tuple(), () => pw.close())
  router.handle('passwords.manage', tuple(), () => {
    pw.close()
    b.openInternal('passwords')
  })
  router.handle('passwords.resolveSave', tuple(v.boolean()), (_c, accept) => pw.resolveSave(accept))
  router.handle('passwords.remove', tuple(v.id()), (_c, id) => pw.store.remove(id))
  router.handle('passwords.copy', tuple(v.id()), (_c, id) => {
    const password = pw.store.password(id)
    if (password === null) return false
    clipboard.writeText(password)
    return true
  })
  router.handle('passwords.reveal', tuple(v.id()), async (_c, id) => {
    // The one place a saved password reaches the shell, and only after the
    // Mac has confirmed who is sitting at it.
    if (!systemPreferences.canPromptTouchID()) return null
    try {
      await systemPreferences.promptTouchID(t('passwords.save.reason'))
    } catch {
      return null
    }
    return pw.store.password(id)
  })

  // -- downloads --------------------------------------------------------------
  const dl = b.downloads
  router.handle('downloads.open', tuple(id), (_c, d) => dl.open(d))
  router.handle('downloads.reveal', tuple(id), (_c, d) => dl.reveal(d))
  router.handle('downloads.cancel', tuple(id), (_c, d) => dl.cancel(d))
  router.handle('downloads.pause', tuple(id), (_c, d) => dl.pause(d))
  router.handle('downloads.resume', tuple(id), (_c, d) => dl.resume(d))
  router.handle('downloads.remove', tuple(id), (_c, d) => dl.remove(d))
  router.handle('downloads.clear', tuple(), () => dl.clearFinished())
  router.handle('downloads.retry', tuple(id), (_c, d) => dl.retry(d, b.profiles.defaultSession()))
  router.handle('downloads.drag', tuple(id), (c, d) => dl.drag(d, c.sender))
  router.handle('downloads.openFolder', tuple(), () => dl.openFolder())

  // -- find / zoom / devtools ---------------------------------------------------
  router.handle('find.update', tuple(id, v.string({ max: 1000 }), v.boolean(), v.boolean()), (_c, tabId, text, forward, next) =>
    tabs.find(tabId, text, forward, next)
  )
  router.handle('find.stop', tuple(id), (_c, tabId) => tabs.stopFind(tabId))
  router.handle('zoom.adjust', tuple(id, v.oneOf([-1, 0, 1] as const)), (_c, tabId, delta) => tabs.adjustZoom(tabId, delta))
  router.handle('devtools.toggle', tuple(id), (_c, tabId) => tabs.toggleDevTools(tabId))

  // -- permissions --------------------------------------------------------------
  router.handle(
    'permissions.respond',
    tuple(id, v.oneOf(['allow', 'deny'] as const), v.boolean()),
    (_c, promptId, decision, remember) => b.permissions.respond(promptId, decision, remember)
  )
  router.handle('permissions.list', tuple(), () => b.permissions.list())

  // -- page dialogs (alert / confirm / prompt) -----------------------------------
  router.handle(
    'pageDialogs.respond',
    tuple(id, v.boolean(), v.string({ max: 100_000 }), v.boolean()),
    (_c, dialogId, accept, text, suppress) => b.dialogs.respond(dialogId, accept, text, suppress)
  )

  // -- agents (MCP) -------------------------------------------------------------
  router.handle('agent.info', tuple(), () => b.agentInfo())
  router.handle('agent.copy', tuple(v.oneOf(AGENT_SNIPPETS)), (_c, what) => b.copyAgentSnippet(what))
  router.handle('agent.regenerateToken', tuple(), () => b.regenerateAgentToken())
  router.handle('permissions.reset', tuple(v.string({ max: 2048 }), v.string({ max: 64 })), (_c, origin, permission) =>
    b.permissions.reset(origin, permission)
  )
  router.handle(
    'permissions.set',
    tuple(v.string({ max: 2048 }), v.string({ max: 64 }), v.oneOf(['allow', 'deny'] as const)),
    (_c, origin, permission, decision) => b.permissions.set(origin, permission, decision)
  )
}
