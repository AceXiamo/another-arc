// Strings for the "shell-sidebar" module. Keys: '<module>.<component>.<name>'.
export default {
  'sidebar.header.toggleSidebar': 'Toggle sidebar (⌘S)',
  'sidebar.header.back': 'Back (⌘[)',
  'sidebar.header.forward': 'Forward (⌘])',
  'sidebar.header.stop': 'Stop',
  'sidebar.header.reload': 'Reload (⌘R)',

  'sidebar.address.placeholder': 'Search or enter address',
  'sidebar.address.resetZoom': 'Reset to actual size (⌘0)',
  'sidebar.address.copyUrl': 'Copy URL (⇧⌘C)',
  'sidebar.address.siteControls': 'Site controls',

  'sidebar.site.share': 'Share',
  'sidebar.site.screenshot': 'Screenshot',
  'sidebar.site.screenshotCopied': 'Screenshot copied',
  'sidebar.site.find': 'Find',
  'sidebar.site.mute': 'Mute',
  'sidebar.site.unmute': 'Unmute',
  'sidebar.site.extensions': 'Extensions',
  'sidebar.site.manage': 'Manage',
  'sidebar.site.addExtension': 'Add extensions',
  'sidebar.site.pin': 'Pin to address bar',
  'sidebar.site.unpin': 'Unpin from address bar',
  'sidebar.site.settings': 'Site settings',
  'sidebar.site.secure': 'Secure',
  'sidebar.site.insecure': 'Not secure',
  'sidebar.site.certError': 'Certificate error',
  'sidebar.site.more': 'More',

  'sidebar.tabs.mute': 'Mute tab',
  'sidebar.tabs.unmute': 'Unmute tab',
  'sidebar.tabs.close': 'Close tab (⌘W)',

  'sidebar.folders.renameLabel': 'Folder name',
  // Hint inside an open folder that has nothing in it yet.
  'sidebar.folders.empty': 'Drag tabs here',
  // Close button on a live saved tab (top level or in a folder): closing unloads it, the bookmark stays.
  'sidebar.folders.unloadTab': 'Close (⌘W). It stays in the sidebar',

  'sidebar.resizer.hint': 'Drag to resize, double-click to reset',

  'sidebar.spaceBar.settings': 'Settings (⌘,)',
  'sidebar.spaceBar.downloads': 'Downloads (⇧⌘J)',
  'sidebar.spaceBar.newSpace': 'New space',

  'sidebar.spaceEditor.titleNew': 'New space',
  'sidebar.spaceEditor.titleEdit': 'Edit space',
  'sidebar.spaceEditor.namePlaceholder': 'Space name',
  'sidebar.spaceEditor.create': 'Create',

  // Shown under the requesting site's name in a permission prompt.
  'sidebar.permission.cameraAndMicrophone': 'Wants to use your camera and microphone',
  'sidebar.permission.camera': 'Wants to use your camera',
  'sidebar.permission.microphone': 'Wants to use your microphone',
  'sidebar.permission.geolocation': 'Wants to know your location',
  'sidebar.permission.notifications': 'Wants to send you notifications',
  'sidebar.permission.clipboardRead': 'Wants to see text and images on your clipboard',
  'sidebar.permission.midiSysex': 'Wants full control of your MIDI devices',
  'sidebar.permission.idleDetection': 'Wants to know when you’re using your device',
  'sidebar.permission.windowManagement': 'Wants to manage windows on all your displays',
  'sidebar.permission.storageAccess': 'Wants to use your cookies and data from other sites',
  'sidebar.permission.fileSystem': 'Wants to edit files on your device',
  'sidebar.permission.openExternal': 'Wants to open an external app ({scheme}:)',
  'sidebar.permission.other': 'Wants to use {permission}',
  'sidebar.permission.remember': 'Remember my choice'
} satisfies Record<string, string>
