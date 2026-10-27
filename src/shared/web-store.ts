// Chrome Web Store support. The store's pages install through
// `chrome.webstorePrivate` and list installed items through
// `chrome.management`, which only Chrome provides; the page preload stands
// them in on the store's origin and forwards each call to main.

export const WEB_STORE_ORIGIN = 'https://chromewebstore.google.com'

export const WEB_STORE_IPC = {
  /** invoke(method, ...args) → { value } | { value, error } */
  call: 'web-store:call',
  /** main → page: chrome.management.onInstalled / onUninstalled */
  installed: 'web-store:installed',
  uninstalled: 'web-store:uninstalled'
} as const

/** Methods the page may call (webstorePrivate.* and management.*). */
export const WEB_STORE_METHODS = [
  'beginInstallWithManifest3',
  'completeInstall',
  'enableAppLauncher',
  'getBrowserLogin',
  'getExtensionStatus',
  'getFullChromeVersion',
  'getIsLauncherEnabled',
  'getMV2DeprecationStatus',
  'getReferrerChain',
  'getStoreLogin',
  'getWebGLStatus',
  'install',
  'isInIncognitoMode',
  'isPendingCustodianApproval',
  'setStoreLogin',
  'management.getAll',
  'management.get',
  'management.setEnabled',
  'management.uninstall'
] as const

export type WebStoreMethod = (typeof WEB_STORE_METHODS)[number]

/** A call's outcome; `error` becomes `chrome.runtime.lastError`. */
export interface WebStoreReply {
  value: unknown
  error?: string
}

/** chrome.webstorePrivate enums, as Chrome defines them (the store compares against these). */
export const WebStoreResult = {
  ALREADY_INSTALLED: 'already_installed',
  BLACKLISTED: 'blacklisted',
  BLOCKED_BY_POLICY: 'blocked_by_policy',
  BLOCKED_FOR_CHILD_ACCOUNT: 'blocked_for_child_account',
  FEATURE_DISABLED: 'feature_disabled',
  ICON_ERROR: 'icon_error',
  INSTALL_ERROR: 'install_error',
  INSTALL_IN_PROGRESS: 'install_in_progress',
  INVALID_ICON_URL: 'invalid_icon_url',
  INVALID_ID: 'invalid_id',
  LAUNCH_IN_PROGRESS: 'launch_in_progress',
  MANIFEST_ERROR: 'manifest_error',
  MISSING_DEPENDENCIES: 'missing_dependencies',
  SUCCESS: 'success',
  UNKNOWN_ERROR: 'unknown_error',
  UNSUPPORTED_EXTENSION_TYPE: 'unsupported_extension_type',
  USER_CANCELLED: 'user_cancelled',
  USER_GESTURE_REQUIRED: 'user_gesture_required'
} as const

export const ExtensionInstallStatus = {
  BLACKLISTED: 'blacklisted',
  BLOCKED_BY_POLICY: 'blocked_by_policy',
  CAN_REQUEST: 'can_request',
  CORRUPTED: 'corrupted',
  CUSTODIAN_APPROVAL_REQUIRED: 'custodian_approval_required',
  CUSTODIAN_APPROVAL_REQUIRED_FOR_INSTALLATION: 'custodian_approval_required_for_installation',
  DEPRECATED_MANIFEST_VERSION: 'deprecated_manifest_version',
  DISABLED: 'disabled',
  ENABLED: 'enabled',
  FORCE_INSTALLED: 'force_installed',
  INSTALLABLE: 'installable',
  REQUEST_PENDING: 'request_pending',
  TERMINATED: 'terminated'
} as const

export const MV2DeprecationStatus = { INACTIVE: 'inactive', SOFT_DISABLE: 'soft_disable', WARNING: 'warning' } as const

export const WebGlStatus = { WEBGL_ALLOWED: 'webgl_allowed', WEBGL_BLOCKED: 'webgl_blocked' } as const

/** Extension ids are 32 letters a–p. */
export const EXTENSION_ID = /^[a-p]{32}$/
