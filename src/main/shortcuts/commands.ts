export const TAB_SELECT_COMMANDS = [
  'tab.select.1',
  'tab.select.2',
  'tab.select.3',
  'tab.select.4',
  'tab.select.5',
  'tab.select.6',
  'tab.select.7',
  'tab.select.8',
  'tab.select.9'
] as const

export type CommandId =
  | 'tab.new'
  | 'tab.close'
  | 'tab.reopen'
  | 'tab.next'
  | 'tab.prev'
  | (typeof TAB_SELECT_COMMANDS)[number]
  | 'tab.reload'
  | 'tab.hardReload'
  | 'tab.stop'
  | 'tab.back'
  | 'tab.forward'
  | 'tab.duplicate'
  | 'tab.pin'
  | 'tab.copyUrl'
  | 'address.focus'
  | 'space.next'
  | 'space.prev'
  | 'find.open'
  | 'find.next'
  | 'find.prev'
  | 'zoom.in'
  | 'zoom.out'
  | 'zoom.reset'
  | 'sidebar.toggle'
  | 'page.devtools'
  | 'open.history'
  | 'open.downloads'
  | 'open.extensions'
  | 'open.settings'
  | 'import.browser'
  | 'window.close'
  | 'shell.devtools'

export type CommandRunner = (id: CommandId) => void
