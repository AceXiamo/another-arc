import type { FolderId, ShellCommand } from '@shared/types'
import { dismissSitePanel } from '../features/sidebar/SitePanel'
import { optimisticFolder, selectActiveDialog, useBrowser } from '../stores/browser'
import { toast, useUi } from '../stores/ui'
import { send } from './rpc'

/** Commands pushed from main (menu items, reserved shortcuts). */
export function handleCommand(cmd: ShellCommand): void {
  switch (cmd.type) {
    case 'palette.open':
      useUi.setState({ palette: cmd.mode, peek: false })
      break
    case 'palette.close':
      useUi.setState({ palette: null })
      break
    case 'find.open':
      useUi.setState({ findOpen: true })
      break
    case 'find.close':
      useUi.setState({ findOpen: false })
      break
    case 'space.edit':
      useUi.setState({ spaceEditor: cmd.spaceId, themePanel: cmd.theme ? 'standalone' : null })
      break
    case 'folder.rename':
      revealFolder(cmd.folderId)
      useUi.setState({ renamingFolder: cmd.folderId })
      break
    case 'toast':
      toast(cmd.message)
      break
    case 'autofill':
      useUi.setState({ autofill: cmd.entries ? { entries: cmd.entries, active: cmd.active, above: cmd.above } : null })
      break
    case 'password.offerSave':
      useUi.setState({ passwordPrompt: { origin: cmd.origin, username: cmd.username } })
      break
    case 'sitePanel.dismiss':
      dismissSitePanel()
      break
    case 'download.started':
      useUi.setState((s) => ({ flights: [...s.flights, { id: cmd.id, filename: cmd.filename, mimeType: cmd.mimeType, from: cmd.from }] }))
      break
  }
}

/** Expand any collapsed ancestors so the folder's row (and its rename field) is on screen. */
function revealFolder(folderId: FolderId): void {
  const { folders } = useBrowser.getState()
  for (let id = folders[folderId]?.parentId ?? null, guard = 0; id && guard < 256; guard++) {
    const parent = folders[id]
    if (!parent) break
    if (parent.collapsed) {
      optimisticFolder(parent.id, { collapsed: false })
      send('folders.setCollapsed', parent.id, false)
    }
    id = parent.parentId
  }
}

/**
 * UI state → main process. The shell is raised above the page whenever a
 * modal overlay (palette, sidebar peek, the space editor and its theme panel,
 * a page's alert / confirm / prompt) is showing. The site controls float in
 * a surface of their own instead: they never cover the page.
 */
export function startUiEffects(): void {
  let overlay = false
  const syncOverlay = () => {
    const ui = useUi.getState()
    const next = ui.palette !== null || ui.peek || ui.spaceEditor !== null || selectActiveDialog(useBrowser.getState()) !== null
    if (next !== overlay) {
      overlay = next
      send('window.setOverlay', next)
    }
  }
  useUi.subscribe((s, prev) => {
    // The editor lives in the sidebar: with the sidebar collapsed, reveal it as a peek.
    if (s.spaceEditor !== null && prev.spaceEditor === null && !s.peek && useBrowser.getState().window.sidebarCollapsed) {
      useUi.setState({ peek: true })
      return
    }
    syncOverlay()
  })
  useBrowser.subscribe(syncOverlay)
  // A collapsed sidebar that gets expanded must drop any peek state.
  useBrowser.subscribe((s, prev) => {
    if (!s.window.sidebarCollapsed && prev.window.sidebarCollapsed && useUi.getState().peek) {
      useUi.setState({ peek: false })
    }
    // A rename field left behind in another space must not reappear later.
    if (s.window.activeSpaceId !== prev.window.activeSpaceId && useUi.getState().renamingFolder) {
      useUi.setState({ renamingFolder: null })
    }
  })
}
