// Strings for the "shell-palette" module. Keys: '<module>.<component>.<name>'.
export default {
  'palette.input.searchPlaceholder': 'Search or enter address',
  'palette.input.editUrlPlaceholder': 'Enter address or search',

  'palette.command.openPage': 'Open {page}',
  'palette.command.newSpace': 'New space',
  'palette.command.reopenClosedTab': 'Reopen closed tab',
  'palette.command.toggleSidebar': 'Toggle sidebar',
  'palette.command.loadUnpackedExtension': 'Load unpacked extension…',

  // Comma-separated match words for each command. Every language's words
  // always match, so typing either English or Chinese finds the command.
  'palette.keywords.newSpace': 'space, new space',
  'palette.keywords.reopenClosedTab': 'reopen, restore',
  'palette.keywords.toggleSidebar': 'sidebar',
  'palette.keywords.loadUnpackedExtension': 'extension, load unpacked, install extension',

  'palette.hint.switchToTab': 'Switch to tab',
  'palette.hint.current': 'Current',
  'palette.hint.go': 'Go',
  'palette.hint.command': 'Command',

  'palette.subtitle.searchWith': 'Search with {engine}',

  'find.placeholder': 'Find in page',
  'find.previous': 'Previous match (⇧↩)',
  'find.next': 'Next match (↩)',
  'find.close': 'Close (Esc)'
} satisfies Record<string, string>
