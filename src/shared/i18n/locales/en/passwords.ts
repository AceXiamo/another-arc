const en = {
  // The dropdown over a sign-in field
  'passwords.autofill.manage': 'Saved passwords…',
  'passwords.autofill.noUsername': 'No username',

  // Offering to remember a sign-in that just went through
  'passwords.save.message': 'Save this password for {origin}?',
  'passwords.save.messageNoUser': 'Save this password?',
  'passwords.save.save': 'Save',
  'passwords.save.notNow': 'Not now',
  'passwords.save.reason': 'Confirm it is you to show this password',

  // Settings
  'passwords.settings.section': 'Passwords',
  'passwords.settings.description':
    'Saved on this Mac only and encrypted with your login keychain. Nothing is ever synced.',
  'passwords.settings.empty': 'No saved passwords yet',
  'passwords.settings.unavailable': 'macOS will not give this app a key, so passwords cannot be saved',
  'passwords.settings.used': 'Used {count} times',
  'passwords.settings.neverUsed': 'Never used',
  'passwords.settings.copy': 'Copy',
  'passwords.settings.copied': 'Copied',
  'passwords.settings.show': 'Show',
  'passwords.settings.hide': 'Hide',
  'passwords.settings.remove': 'Remove',
  'passwords.settings.noTouchID': 'Showing a password needs Touch ID; use Copy instead',
  'passwords.settings.saved': 'Saved passwords',
  'passwords.settings.summary': '{count} passwords for {sites} sites',

  // The passwords page
  'passwords.page.search': 'Search sites and usernames',
  'passwords.page.clearSearch': 'Clear search',
  'passwords.page.noMatches': 'No saved passwords match',
  'passwords.page.noMatchesHint': 'Try part of a site name or a username',

  // Importing them from another browser
  'passwords.import.count': '{count} passwords',
  'passwords.import.result': 'Passwords: {count} imported, {skipped} skipped',
  'passwords.import.inKeychain': '{count} are kept in that browser’s own keychain items and cannot be read'
} satisfies Record<string, string>

export default en
