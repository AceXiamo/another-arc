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
  'arcImport.notFound': 'Arc’s sidebar wasn’t found on this Mac',
  'arcImport.nothing': 'Arc’s sidebar has nothing to import',
  'arcImport.confirm.message': 'Import your Arc sidebar?',
  'arcImport.confirm.detail':
    'Found {tabs} pinned tabs in {folders} folders across {spaces} spaces, plus {favorites} favorites.\n\nPinned tabs and folders go into the space with the same name (created if missing; Arc’s unnamed space maps to your first space). Favorites become favorite tiles. Nothing is added twice, so importing again is safe. Today tabs, notes and easels aren’t imported.',
  'arcImport.confirm.import': 'Import',
  'arcImport.result.message': 'Imported from Arc',
  'arcImport.result.detail':
    'Added {tabs} pinned tabs, {folders} folders and {favorites} favorites; {duplicates} were already here and were skipped. Site icons appear as they are fetched.',

  // Importing from another browser: bookmarks, extensions, signed-in state
  'browserImport.settings.section': 'Import from another browser',
  'browserImport.settings.profile': 'Profile',
  'browserImport.settings.import': 'Import…',
  'browserImport.settings.bookmarks': '{tabs} bookmarks in {folders} folders',
  'browserImport.settings.extensions': '{count} extensions',
  'browserImport.settings.logins': 'logins for {hosts} sites',
  'browserImport.palette.command': 'Import from another browser…',
  'browserImport.palette.keywords':
    'import,browser,arc,chrome,edge,brave,bookmarks,folders,favorites,cookies,logins,导入,浏览器,书签,文件夹,收藏,登录',
  'browserImport.nothing': '{browser} has nothing to import',
  'browserImport.all.message': 'Import from {browser}?',
  'browserImport.all.profile': 'Profile: {profile}',
  'browserImport.all.bookmarks': 'Bookmarks: {tabs} in {folders} folders, {favorites} favorites',
  'browserImport.all.extensions': 'Extensions ({count}): {names}',
  'browserImport.all.session':
    'Logins: {cookies} cookies from {hosts} sites, plus {mb} MB of site data (localStorage, and IndexedDB for {sites} sites)',
  'browserImport.all.note':
    'Bookmarks go into the space with the same name, and nothing is added twice, so importing again is safe. An extension’s own data (wallets, settings, accounts inside it) isn’t copied.',
  'browserImport.all.notNow': 'Not Now',
  'browserImport.all.installing': 'Installing {count} extensions…',
  'browserImport.confirm.import': 'Import',
  'browserImport.result.message': 'Imported from {browser}',
  'browserImport.result.bookmarks':
    'Added {tabs} bookmarks, {folders} folders and {favorites} favorites; {duplicates} were already here and were skipped. Site icons appear as they are fetched.',
  'browserImport.session.checkbox': 'Bring my logins over too',
  'browserImport.session.note':
    'macOS asks you to allow access to {browser}’s keychain item first — its cookies cannot be read without it. Site data is moved in on the next launch: localStorage replaces what this profile has, keeping the old database beside it as a backup, while IndexedDB merges one site at a time and never touches a site that already has data here. An extension’s own storage is never copied. Quit {browser} first so it has written everything out. Sites that tie a session to the device (passkeys, device-bound sessions) will still ask you to sign in.',
  'browserImport.session.importing': 'Importing logins from {browser}…',
  'browserImport.session.result.cookies': 'Logins: {count} cookies imported, {skipped} skipped',
  'browserImport.session.result.partitioned': '{count} more belong to an embedded site and cannot be carried over',
  'browserImport.session.result.staged': 'Site data ({mb} MB, IndexedDB for {sites} sites) is ready and applies on the next launch',
  'browserImport.session.result.noKey': 'Logins: {browser}’s keychain item could not be read, so no cookies were imported',
  'browserImport.session.result.unreadable': 'Logins: {browser}’s cookie database could not be read',
  'browserImport.session.restart.message': 'Restart to finish importing site data?',
  'browserImport.session.restart.detail':
    '{browser}’s localStorage and IndexedDB are copied and waiting. They are moved in while no page is open, so they only take effect after a restart.',
  'browserImport.session.restart.now': 'Restart Now',
  'browserImport.session.restart.later': 'Later',

  // The window an extension's popup or side panel opens in. Its titlebar
  // shows the extension's own name.
  'extWindow.fallbackTitle': 'Extension',
  'extWindow.menu.close': 'Close Window',
  // Toolbar button tooltip while its window is open; {title} is the extension's own tooltip.
  'extWindow.button.openTitle': '{title} (click to close)'
} satisfies Record<string, string>
