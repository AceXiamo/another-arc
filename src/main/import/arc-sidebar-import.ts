import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dialog, type BaseWindow } from 'electron'
import { SPACE_COLORS } from '@shared/defaults'
import type { Translate } from '@shared/i18n'
import type { FolderId, SpaceId, TabId } from '@shared/types'
import { importRoots } from '../extensions/browser-import'
import type { FaviconCache, Icon } from '../history/favicon-cache'
import type { TabManager } from '../tabs/tab-manager'
import { arcSidebarPath, readArcSidebar, summarizeArcSidebar, type ArcNode, type ArcSidebar } from './arc-sidebar'

// Puts Arc's sidebar into this browser's model:
// - each Arc space with pinned items maps to the space with the same name here
//   (created when missing); Arc's unnamed default space maps to the first space;
// - pinned tabs and folders (nested) become the saved list, appended in Arc's
//   order; folders with the same name at the same level are merged, and a URL
//   already saved in the same place is not added twice — importing again is safe;
// - favorites become favorite tiles of the profile's first imported space.
// New folders start collapsed and nothing is loaded: bookmarks stay unloaded
// until opened. Icons come from Arc's favicon database, then the network.
// Today tabs, notes and easels are not imported.

export interface ArcImportResult {
  spacesCreated: number
  folders: number
  tabs: number
  favorites: number
  /** Items that were already here. */
  duplicates: number
  /** Every tab added (for the favicon prefetch). */
  tabIds: TabId[]
}

export function applyArcSidebar(tabs: TabManager, sidebar: ArcSidebar): ArcImportResult {
  const { model } = tabs
  const result: ArcImportResult = { spacesCreated: 0, folders: 0, tabs: 0, favorites: 0, duplicates: 0, tabIds: [] }
  const targetByProfile = new Map<string, SpaceId>()

  const resolveSpace = (title: string | null, color: string | null): SpaceId => {
    if (title === null) return model.spaceOrder[0]!
    const key = title.toLowerCase()
    const match = model.spaceOrder.find((id) => model.getSpace(id)?.name.trim().toLowerCase() === key)
    if (match) return match
    result.spacesCreated += 1
    return tabs.createSpace({ name: title, icon: 'star', color: nearestSpaceColor(color) })
  }

  const childIds = (spaceId: SpaceId, parentId: FolderId | null): readonly string[] =>
    (parentId ? model.getFolder(parentId)?.childIds : model.getSpace(spaceId)?.savedIds) ?? []

  const importNodes = (nodes: ArcNode[], spaceId: SpaceId, parentId: FolderId | null) => {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        const siblings = childIds(spaceId, parentId)
        let folderId = siblings.find((id) => model.getFolder(id)?.name === node.title)
        if (!folderId) {
          folderId = tabs.createFolder({ spaceId, parentId, name: node.title, index: siblings.length }) ?? undefined
          if (!folderId) continue
          tabs.setFolderCollapsed(folderId, true)
          result.folders += 1
        }
        importNodes(node.children, spaceId, folderId)
        continue
      }
      if (childIds(spaceId, parentId).some((id) => model.getTab(id)?.savedUrl === node.url)) {
        result.duplicates += 1
        continue
      }
      result.tabIds.push(
        tabs.addUnloadedTab({ spaceId, url: node.url, title: node.title, saved: true, folderId: parentId })
      )
      result.tabs += 1
    }
  }

  for (const space of sidebar.spaces) {
    if (space.pinned.length === 0) continue
    const spaceId = resolveSpace(space.title, space.color)
    if (!targetByProfile.has(space.profile)) targetByProfile.set(space.profile, spaceId)
    importNodes(space.pinned, spaceId, null)
  }

  for (const [profile, favorites] of Object.entries(sidebar.favorites)) {
    const spaceId = targetByProfile.get(profile) ?? (profile === 'default' ? model.spaceOrder[0] : undefined)
    const space = spaceId ? model.getSpace(spaceId) : undefined
    if (!space) continue
    for (const fav of favorites) {
      if (space.pinnedTabIds.some((id) => model.getTab(id)?.url === fav.url)) {
        result.duplicates += 1
        continue
      }
      result.tabIds.push(tabs.addUnloadedTab({ spaceId: space.id, url: fav.url, title: fav.title, pinned: true }))
      result.favorites += 1
    }
  }
  return result
}

/** Arc's theme color, snapped to the closest color the space editor offers. */
export function nearestSpaceColor(hex: string | null): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return SPACE_COLORS[0]
  const [r, g, b] = rgb(hex)
  let best: string = SPACE_COLORS[0]
  let bestDistance = Infinity
  for (const candidate of SPACE_COLORS) {
    const [cr, cg, cb] = rgb(candidate)
    const distance = (r! - cr!) ** 2 + (g! - cg!) ** 2 + (b! - cb!) ** 2
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** Arc's "User Data" folder (respects ARC_IMPORT_ROOT; none under ARC_TEST without it). */
function arcRoot(): string | null {
  return importRoots().find((r) => r.browser === 'arc')?.root ?? null
}

export async function loadArcSidebar(): Promise<ArcSidebar | null> {
  const root = arcRoot()
  return root ? readArcSidebar(arcSidebarPath(root)) : null
}

/**
 * Icons Arc already has for these pages, from its Chromium "Favicons"
 * database, keyed by page URL. The database is copied first: Arc may hold
 * it locked while running, and nothing under Arc's folder is ever opened for
 * writing. Missing or unreadable database = empty map.
 */
export async function readArcFavicons(
  profileDir: string,
  pageUrls: readonly string[]
): Promise<Map<string, { iconUrl: string; icon: Icon }>> {
  const out = new Map<string, { iconUrl: string; icon: Icon }>()
  if (pageUrls.length === 0) return out
  const dir = await mkdtemp(join(tmpdir(), 'arc-favicons-'))
  try {
    const copy = join(dir, 'Favicons')
    await copyFile(join(profileDir, 'Favicons'), copy)
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      // Chromium stores PNG bitmaps; prefer the 32px one, then the closest size.
      const query = db.prepare(
        `SELECT f.url AS icon, b.image_data AS data
           FROM icon_mapping m
           JOIN favicons f ON f.id = m.icon_id
           JOIN favicon_bitmaps b ON b.icon_id = f.id
          WHERE m.page_url = ? AND length(b.image_data) > 0
          ORDER BY b.width = 32 DESC, abs(b.width - 32), length(b.image_data) DESC
          LIMIT 1`
      )
      for (const url of new Set(pageUrls)) {
        const row = query.get(url) as { icon: unknown; data: unknown } | undefined
        if (row && typeof row.icon === 'string' && row.data instanceof Uint8Array) {
          out.set(url, { iconUrl: row.icon, icon: { mime: 'image/png', data: new Uint8Array(row.data) } })
        }
      }
    } finally {
      db.close()
    }
  } catch {
    // No usable database: icons come from the network instead.
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return out
}

/**
 * Give imported tabs an icon: Arc's own first (instant, offline), then
 * `<origin>/favicon.ico` from the network for the rest, in the background.
 */
export async function importArcFavicons(tabs: TabManager, favicons: FaviconCache, tabIds: readonly TabId[]): Promise<void> {
  const root = arcRoot()
  const imported = tabIds.map((id) => tabs.model.getTab(id)).filter((t) => t !== undefined)
  const pageOf = (t: { savedUrl: string; url: string }) => t.savedUrl || t.url
  const icons = root ? await readArcFavicons(join(root, 'Default'), imported.map(pageOf)) : new Map()
  for (const tab of imported) {
    const hit = icons.get(pageOf(tab))
    if (!hit || tab.favicon) continue
    if (!favicons.has(hit.iconUrl)) favicons.put(hit.iconUrl, hit.icon)
    if (favicons.has(hit.iconUrl)) tabs.model.updateTab(tab.id, { favicon: hit.iconUrl })
  }
  await tabs.prefetchFavicons(tabIds)
}

let importing = false

/** Settings / palette flow: confirm, import, report — native dialogs only. */
export async function importArcSidebarWithDialogs(
  tabs: TabManager,
  favicons: FaviconCache,
  parent: BaseWindow | null,
  t: Translate
): Promise<void> {
  if (importing) return
  importing = true
  try {
    const show = (options: Electron.MessageBoxOptions) =>
      parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
    const sidebar = await loadArcSidebar()
    if (!sidebar) {
      await show({ type: 'info', message: t('arcImport.notFound'), buttons: [t('common.close')] })
      return
    }
    const summary = summarizeArcSidebar(sidebar)
    if (summary.tabs + summary.favorites === 0) {
      await show({ type: 'info', message: t('arcImport.nothing'), buttons: [t('common.close')] })
      return
    }
    const { response } = await show({
      type: 'question',
      message: t('arcImport.confirm.message'),
      detail: t('arcImport.confirm.detail', summary),
      buttons: [t('arcImport.confirm.import'), t('common.cancel')],
      defaultId: 0,
      cancelId: 1
    })
    if (response !== 0) return
    const result = applyArcSidebar(tabs, sidebar)
    void importArcFavicons(tabs, favicons, result.tabIds)
    await show({
      type: 'info',
      message: t('arcImport.result.message'),
      detail: t('arcImport.result.detail', {
        tabs: result.tabs,
        folders: result.folders,
        favorites: result.favorites,
        duplicates: result.duplicates
      }),
      buttons: [t('common.close')]
    })
  } finally {
    importing = false
  }
}
