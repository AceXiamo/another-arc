// Strings for the "shell-settings" module (Settings and Extensions pages).
// Keys: 'settings.<section>.<name>' and 'extensions.<area>.<name>'.
export default {
  // Search
  'settings.search.title': 'Search',
  'settings.search.engine': 'Default search engine',
  'settings.search.engineHint': "Used when what you type in the address bar isn't a URL",
  'settings.search.custom': 'Custom…',
  'settings.search.customUrl': 'Custom search URL',
  'settings.search.customUrlHint': 'Use %s for the search terms, e.g. https://example.com/search?q=%s',

  // Appearance
  'settings.appearance.title': 'Appearance',
  'settings.appearance.language': 'Language',
  'settings.appearance.theme': 'Theme',
  'settings.appearance.themeSystem': 'System',
  'settings.appearance.themeLight': 'Light',
  'settings.appearance.themeDark': 'Dark',

  // Performance
  'settings.performance.title': 'Performance',
  'settings.performance.description':
    'Discarded tabs keep only their title, icon and back/forward history, and reload when you switch back to them.',
  'settings.performance.discard': 'Discard background tabs',
  'settings.performance.discardHint': 'Frees background tabs left idle this long; tabs playing audio are never discarded',
  'settings.performance.never': 'Never',
  'settings.performance.minutes': '{count} minutes',
  'settings.performance.oneHour': '1 hour',
  'settings.performance.hours': '{count} hours',
  'settings.performance.memoryBudget': 'Memory budget',
  'settings.performance.memoryBudgetHint':
    'Discards the least recently used background tabs once the browser goes over this; leave empty for no limit',
  'settings.performance.noLimit': 'No limit',

  // Downloads
  'settings.downloads.title': 'Downloads',
  'settings.downloads.askWhere': 'Ask where to save each file',
  'settings.downloads.location': 'Location',
  'settings.downloads.defaultFolder': 'Downloads folder',
  'settings.downloads.useDefault': 'Use default',
  'settings.downloads.change': 'Change…',

  // Site permissions
  'settings.permissions.title': 'Site permissions',
  'settings.permissions.description':
    "Sites can't use these features by default. Choices you ask a prompt to remember show up here.",
  'settings.permissions.empty': 'No saved site permissions',
  'settings.permissions.allowed': 'Allowed',
  'settings.permissions.blocked': 'Blocked',
  'settings.permissions.reset': 'Reset',
  'settings.permissions.media': 'Camera and microphone',
  'settings.permissions.geolocation': 'Location',
  'settings.permissions.notifications': 'Notifications',
  'settings.permissions.clipboardRead': 'Read clipboard',
  'settings.permissions.midiSysex': 'MIDI devices',
  'settings.permissions.idleDetection': 'Idle detection',
  'settings.permissions.windowManagement': 'Window management',
  'settings.permissions.storageAccess': 'Third-party cookies',
  'settings.permissions.fileSystem': 'File editing',
  'settings.permissions.openExternal': 'Open external apps',

  // Extensions page
  'extensions.page.load': 'Load unpacked extension',
  'extensions.page.intro':
    'Choose a folder that contains manifest.json. The extension is copied into the browser’s data folder; use “Update from source” later to pick up changes from the original folder. Check the compatibility report for what’s supported: “Loaded” doesn’t mean every feature works.',
  'extensions.page.empty': 'No extensions installed yet',

  // Extension card
  'extensions.card.enable': 'Enable',
  'extensions.card.noPermissions': 'No permissions requested',
  'extensions.card.broadAccess': 'Can read and change all your data on all websites you visit',
  'extensions.card.showPermissions': 'Show permissions',
  'extensions.card.hidePermissions': 'Hide permissions',
  'extensions.card.pin': 'Pin to toolbar',
  'extensions.card.unpin': 'Unpin from toolbar',
  'extensions.card.options': 'Options',
  'extensions.card.update': 'Update from source',
  'extensions.card.remove': 'Remove'
} satisfies Record<string, string>
