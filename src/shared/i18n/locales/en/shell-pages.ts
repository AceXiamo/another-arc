// Strings for the "shell-pages" module. Keys: '<module>.<component>.<name>'.
export default {
  // History page
  'history.clearData': 'Clear browsing data…',
  'history.searchPlaceholder': 'Search history',
  'history.today': 'Today',
  'history.yesterday': 'Yesterday',
  'history.empty': 'No history yet',
  'history.emptyHint': 'Pages you visit will show up here.',
  'history.noMatches': 'No matching history',
  'history.noMatchesHint': 'Try a shorter word, or part of the address.',
  'history.clearSearch': 'Clear search',

  // Downloads page
  'downloads.clearCompleted': 'Clear completed',
  'downloads.started': 'Downloading “{name}”',
  'downloads.openFolder': 'Open folder',
  'downloads.open': 'Open',
  'downloads.retry': 'Retry',
  'downloads.today': 'Today',
  'downloads.yesterday': 'Yesterday',
  'downloads.earlier': 'Earlier',
  'downloads.left': '{time} left',
  'downloads.dragHint': 'Drag it into Finder or another app',
  'downloads.emptyHint': 'Files you download will show up here.',
  'downloads.files.one': '{count} file',
  'downloads.files.other': '{count} files',
  'downloads.active': '{count} downloading',
  'downloads.pause': 'Pause',
  'downloads.resume': 'Resume',
  'downloads.showInFinder': 'Show in Finder',
  'downloads.remove': 'Remove from list',
  'downloads.status.cancelled': 'Canceled',
  'downloads.status.interrupted': 'Interrupted',
  'downloads.status.paused': 'Paused · {size}',


  // Empty space placeholder. {keys} is the ⌘T shortcut.
  'status.empty.title': '{space} has no tabs yet',
  'status.empty.fallbackSpace': 'This space',
  'status.empty.nothingOpen': 'No tab open',
  'status.empty.newTab': 'Press {keys} to open a new tab',

  // Crash page
  'status.crash.title': 'This page crashed',
  'status.crash.body':
    'The renderer process for {host} quit unexpectedly. Your computer may be low on memory, or the page ran into a problem.',

  // Certificate error page. {host} in the body is rendered in bold.
  'status.cert.title': 'Your connection is not private',
  'status.cert.body': 'Attackers might be trying to steal your information from {host} (for example, passwords or credit cards).',
  'status.cert.back': 'Back to safety',
  'status.cert.advanced': 'Advanced',
  'status.cert.hideAdvanced': 'Hide advanced',
  'status.cert.advancedBody':
    'This server couldn’t prove that it’s {host}; its security certificate is not trusted. Proceed only if you fully understand the risks. The exception lasts until you quit the app.',
  'status.cert.proceed': 'Proceed to {host} (unsafe)',

  // Network error page. {host} is rendered in bold.
  'status.net.title': 'This site can’t be reached',
  'status.net.back': 'Go back',
  'status.net.nameNotResolved': '{host}’s server IP address could not be found.',
  'status.net.offline': '{host} can’t be reached: you appear to be offline.',
  'status.net.refused': '{host} refused to connect.',
  'status.net.timedOut': '{host} took too long to respond.',
  'status.net.closed': '{host} unexpectedly closed the connection.',
  'status.net.blocked': '{host} was blocked by an extension.',
  'status.net.changed': 'The network changed while connecting to {host}.',
  'status.net.invalidUrl': 'The address of {host} is invalid.',
  'status.net.generic': '{host} might be temporarily down, or it may have moved permanently to a new address.',

  // A page's alert() / confirm() / prompt(). {host} is the asking site, with its port if any.
  'pageDialog.says': '{host} says',
  'pageDialog.thisPageSays': 'This page says',
  'pageDialog.ok': 'OK',
  'pageDialog.suppress': 'Don’t let this page show more dialogs'
} satisfies Record<string, string>
