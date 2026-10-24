// Importing extensions from other Chromium browsers (Arc, Chrome…).
// {browser} is a product name ("Arc", "Chrome"); {profile} is the user's own
// profile name in that browser.
export default {
  // Extensions page button and ⌘T palette command
  'extImport.button': 'Import from {browser}',
  'extImport.button.busy': 'Importing…',
  'extImport.button.title': 'Copy the extensions turned on in your {browser} profile “{profile}”',
  'extImport.palette.command': 'Import extensions from {browser}…',
  'extImport.palette.keywords': 'import, import extensions, arc, chrome',

  // Confirmation dialog
  'extImport.confirm.message': 'Import extensions from your {browser} profile “{profile}”?',
  'extImport.confirm.toImport': 'To import ({count}):',
  'extImport.confirm.skipped': 'Skipped ({count}):',
  'extImport.confirm.note':
    'Only the extension files are copied. Their data (wallet vaults, settings, logins) stays in {browser}. {browser} itself isn’t changed.',
  'extImport.confirm.import': 'Import',
  'extImport.item': '{name} {version}',
  'extImport.itemWithReason': '{name}: {reason}',

  // Why an extension is skipped
  'extImport.skip.disabled': 'turned off in {browser}',
  'extImport.skip.installed': 'already installed',
  'extImport.skip.manifestVersion': 'manifest version {version} isn’t supported',
  'extImport.skip.unreadable': 'its files are missing or unreadable',
  'extImport.skip.crashes': 'crashes this browser',
  'extImport.skip.newTab': 'replaces the new tab page, which isn’t supported',

  // Nothing to do
  'extImport.nothing.message': 'Nothing new to import from your {browser} profile “{profile}”',
  'extImport.notFound.message': 'No {browser} extensions found',
  'extImport.notFound.detail': 'Looked for the last-used {browser} profile in {path}',

  // Result dialog
  'extImport.result.done': 'Extensions imported from {browser}',
  'extImport.result.partial': 'Some extensions couldn’t be imported from {browser}',
  'extImport.result.failed': 'Couldn’t import extensions from {browser}',
  'extImport.result.count': 'Imported: {count} of {total}',
  'extImport.result.failedHeading': 'Couldn’t import ({count}):',
  'extImport.result.dataNote':
    'Extension data isn’t copied: wallet vaults, settings and logins stay in {browser}. Restore each wallet again with its recovery phrase, and sign in to extensions again.',

  // Arc's sidebar: spaces, folders, pinned tabs and favorites
  'arcImport.settings.section': 'Import from Arc',
  'arcImport.settings.everything': 'Sidebar and extensions',
  'arcImport.settings.sidebarHint': '{tabs} pinned tabs in {folders} folders, {favorites} favorites',
  'arcImport.settings.extensionsHint': '{count} extensions',
  'arcImport.settings.import': 'Import…',
  'arcImport.palette.command': 'Import from Arc…',
  'arcImport.palette.keywords': 'import,arc,bookmarks,folders,pinned,favorites,sidebar,导入,书签,文件夹,置顶,收藏',
  'arcImport.notFound': 'Arc’s sidebar wasn’t found on this Mac',
  'arcImport.nothing': 'Arc’s sidebar has nothing to import',
  'arcImport.confirm.message': 'Import your Arc sidebar?',
  'arcImport.confirm.detail':
    'Found {tabs} pinned tabs in {folders} folders across {spaces} spaces, plus {favorites} favorites.\n\nPinned tabs and folders go into the space with the same name (created if missing; Arc’s unnamed space maps to your first space). Favorites become favorite tiles. Nothing is added twice, so importing again is safe. Today tabs, notes and easels aren’t imported.',
  'arcImport.confirm.import': 'Import',
  'arcImport.all.message': 'Import from Arc?',
  'arcImport.all.sidebar': 'Sidebar: {tabs} pinned tabs in {folders} folders, {favorites} favorites',
  'arcImport.all.extensions': 'Extensions ({count}): {names}',
  'arcImport.all.note':
    'Pinned tabs and folders go into the space with the same name, and nothing is added twice, so importing again is safe. Extension data (wallets, settings, logins) isn’t copied.',
  'arcImport.all.notNow': 'Not Now',
  'arcImport.all.installing': 'Installing {count} extensions from Arc…',
  'arcImport.result.message': 'Imported from Arc',
  'arcImport.result.detail':
    'Added {tabs} pinned tabs, {folders} folders and {favorites} favorites; {duplicates} were already here and were skipped. Site icons appear as they are fetched.'
} satisfies Record<string, string>
