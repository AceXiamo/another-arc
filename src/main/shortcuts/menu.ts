import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { Translate } from '@shared/i18n'
import { TAB_SELECT_COMMANDS, type CommandId, type CommandRunner } from './commands'
import { RESERVED_ACCELERATORS } from './keymap'

/**
 * The native menu doubles as the registry of non-reserved shortcuts. Reserved
 * shortcuts appear with their accelerator for discoverability but are not
 * registered here (`registerAccelerator: false`): `before-input-event`
 * already handled them, so they can never fire twice.
 */
export function buildAppMenu(run: CommandRunner, opts: { isDev: boolean; t: Translate }): Menu {
  const { t } = opts
  const appName = { app: app.name }
  const item = (label: string, command: CommandId, accelerator?: string): MenuItemConstructorOptions => {
    const reserved = RESERVED_ACCELERATORS[command]
    return {
      label,
      click: () => run(command),
      ...(reserved
        ? { accelerator: reserved, registerAccelerator: false }
        : accelerator
          ? { accelerator }
          : {})
    }
  }
  // Extra accelerators that should work but do not need their own menu row.
  const hidden = (command: CommandId, accelerator: string): MenuItemConstructorOptions => ({
    label: command,
    accelerator,
    visible: false,
    acceleratorWorksWhenHidden: true,
    click: () => run(command)
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: t('menu.about', appName) },
        { type: 'separator' },
        item(t('menu.settings'), 'open.settings', 'Cmd+,'),
        item(t('menu.extensions'), 'open.extensions'),
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide', appName) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit', appName) }
      ]
    },
    {
      label: t('menu.file'),
      submenu: [
        item(t('menu.newTab'), 'tab.new'),
        item(t('menu.reopenTab'), 'tab.reopen'),
        { type: 'separator' },
        item(t('menu.openLocation'), 'address.focus'),
        { type: 'separator' },
        item(t('menu.importArc'), 'import.arc'),
        { type: 'separator' },
        item(t('menu.closeTab'), 'tab.close'),
        item(t('menu.closeWindow'), 'window.close')
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'pasteAndMatchStyle', label: t('menu.pasteAndMatchStyle') },
        { role: 'delete', label: t('menu.delete') },
        { role: 'selectAll', label: t('menu.selectAll') },
        { type: 'separator' },
        item(t('menu.find'), 'find.open', 'Cmd+F'),
        item(t('menu.findNext'), 'find.next', 'Cmd+G'),
        item(t('menu.findPrevious'), 'find.prev', 'Cmd+Shift+G'),
        { type: 'separator' },
        item(t('menu.copyUrl'), 'tab.copyUrl', 'Cmd+Shift+C'),
        { type: 'separator' },
        { role: 'startSpeaking', label: t('menu.startSpeaking') },
        { role: 'stopSpeaking', label: t('menu.stopSpeaking') }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        item(t('menu.toggleSidebar'), 'sidebar.toggle', 'Cmd+S'),
        { type: 'separator' },
        item(t('menu.reload'), 'tab.reload', 'Cmd+R'),
        item(t('menu.hardReload'), 'tab.hardReload', 'Cmd+Shift+R'),
        item(t('menu.stop'), 'tab.stop', 'Cmd+.'),
        { type: 'separator' },
        item(t('menu.zoomIn'), 'zoom.in', 'Cmd+Plus'),
        item(t('menu.zoomOut'), 'zoom.out', 'Cmd+-'),
        item(t('menu.actualSize'), 'zoom.reset', 'Cmd+0'),
        hidden('zoom.in', 'Cmd+='),
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.toggleFullScreen') },
        { type: 'separator' },
        item(t('menu.devTools'), 'page.devtools', 'Cmd+Alt+I'),
        hidden('page.devtools', 'Cmd+Alt+J'),
        ...(opts.isDev ? [item(t('menu.shellDevTools'), 'shell.devtools', 'Cmd+Alt+Shift+I')] : [])
      ]
    },
    {
      label: t('menu.history'),
      submenu: [
        item(t('menu.back'), 'tab.back', 'Cmd+['),
        item(t('menu.forward'), 'tab.forward', 'Cmd+]'),
        { type: 'separator' },
        item(t('menu.showAllHistory'), 'open.history', 'Cmd+Y')
      ]
    },
    {
      label: t('menu.tabs'),
      submenu: [
        item(t('menu.nextTab'), 'tab.next'),
        item(t('menu.previousTab'), 'tab.prev'),
        { type: 'separator' },
        ...TAB_SELECT_COMMANDS.map((c, i) => item(i === 8 ? t('menu.lastTab') : t('menu.tabN', { n: i + 1 }), c)),
        { type: 'separator' },
        item(t('menu.duplicateTab'), 'tab.duplicate'),
        item(t('menu.togglePin'), 'tab.pin', 'Cmd+D'),
        { type: 'separator' },
        item(t('menu.nextSpace'), 'space.next'),
        item(t('menu.previousSpace'), 'space.prev')
      ]
    },
    {
      label: t('menu.window'),
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        { type: 'separator' },
        item(t('menu.downloads'), 'open.downloads', 'Cmd+Shift+J'),
        { type: 'separator' },
        { role: 'front', label: t('menu.bringAllToFront') }
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
