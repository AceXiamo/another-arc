import { dialog, type BaseWindow } from 'electron'
import type { Translate } from '@shared/i18n'
import type { ExtensionManager } from '../extensions/extension-manager'
import type { FaviconCache } from '../history/favicon-cache'
import type { TabManager } from '../tabs/tab-manager'
import { summarizeArcSidebar } from './arc-sidebar'
import { applyArcSidebar, importArcFavicons, loadArcSidebar } from './arc-sidebar-import'

// "Import from Arc": the sidebar (spaces, pinned tabs, folders, favorites) and
// the extensions in one confirmation. Offered once on a fresh profile, and
// available from the File menu, Settings and ⌘T.

export interface ArcImportHost {
  tabs: TabManager
  favicons: FaviconCache
  extensions: ExtensionManager
  /** Current-language translator (read on each use). */
  readonly t: Translate
  parent(): BaseWindow | null
  toast(message: string): void
}

let importing = false

/** True when this profile holds nothing an import would add to (first-run offer). */
export function isFreshProfile(host: ArcImportHost): boolean {
  const { model } = host.tabs
  const hasSaved = model.spaceOrder.some((id) => (model.getSpace(id)?.savedIds.length ?? 0) > 0)
  return !hasSaved && host.extensions.info().length === 0
}

/**
 * Confirm, import, report — native dialogs only. With `firstRun`, nothing is
 * said when Arc has nothing to offer, and the second button reads "Not Now".
 */
export async function importFromArc(host: ArcImportHost, opts: { firstRun?: boolean } = {}): Promise<void> {
  if (importing) return
  importing = true
  try {
    await run(host, opts.firstRun === true)
  } finally {
    importing = false
  }
}

async function run(host: ArcImportHost, firstRun: boolean): Promise<void> {
  const { t } = host
  const parent = host.parent()
  const show = (options: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)

  const sidebar = await loadArcSidebar()
  const summary = sidebar ? summarizeArcSidebar(sidebar) : null
  const hasSidebar = summary !== null && summary.tabs + summary.favorites > 0
  const source = (await host.extensions.importSources()).find((s) => s.id === 'arc')
  const extensions = source?.extensions.filter((c) => !c.skip) ?? []
  if (!hasSidebar && extensions.length === 0) {
    if (!firstRun) await show({ type: 'info', message: t('arcImport.nothing'), buttons: [t('common.close')] })
    return
  }

  const detail = [
    ...(hasSidebar ? [t('arcImport.all.sidebar', summary)] : []),
    ...(extensions.length > 0
      ? [t('arcImport.all.extensions', { count: extensions.length, names: extensions.map((c) => c.name).join(', ') })]
      : []),
    '',
    t('arcImport.all.note')
  ]
  const { response } = await show({
    type: 'question',
    message: t('arcImport.all.message'),
    detail: detail.join('\n'),
    buttons: [t('arcImport.confirm.import'), firstRun ? t('arcImport.all.notNow') : t('common.cancel')],
    defaultId: 0,
    cancelId: 1
  })
  if (response !== 0) return

  const lines: string[] = []
  if (hasSidebar && sidebar) {
    const result = applyArcSidebar(host.tabs, sidebar)
    void importArcFavicons(host.tabs, host.favicons, result.tabIds)
    lines.push(
      t('arcImport.result.detail', {
        tabs: result.tabs,
        folders: result.folders,
        favorites: result.favorites,
        duplicates: result.duplicates
      })
    )
  }
  if (extensions.length > 0) {
    // Installing takes a few seconds; the bookmarks are already in the sidebar.
    host.toast(t('arcImport.all.installing', { count: extensions.length }))
    const results = (await host.extensions.importFrom('arc'))?.results ?? []
    const failed = results.filter((r) => r.error !== null)
    lines.push(
      '',
      t('extImport.result.count', { count: results.length - failed.length, total: results.length }),
      ...(failed.length > 0
        ? [
            t('extImport.result.failedHeading', { count: failed.length }),
            ...failed.map((r) => `• ${t('extImport.itemWithReason', { name: r.name, reason: r.error ?? '' })}`)
          ]
        : []),
      '',
      t('extImport.result.dataNote', { browser: 'Arc' })
    )
  }
  await show({ type: 'info', message: t('arcImport.result.message'), detail: lines.join('\n'), buttons: [t('common.close')] })
}
