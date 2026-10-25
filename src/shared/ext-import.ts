// Importing from another Chromium browser's profile: bookmarks, extensions
// and the signed-in state. The catalogue of where each one keeps its data
// lives in main (`src/main/import/browsers.ts`); these are just the ids.

/** Browsers that can be imported from. Also the source id. */
export const IMPORT_BROWSERS = [
  'arc',
  'dia',
  'chrome',
  'chromeBeta',
  'chromeCanary',
  'edge',
  'brave',
  'vivaldi',
  'opera',
  'chromium',
  'comet'
] as const

export type ImportBrowser = (typeof IMPORT_BROWSERS)[number]

/** What the Extensions page needs to offer an "Import from …" button. */
export interface ImportSourceSummary {
  id: ImportBrowser
  /** Product name shown in the UI ("Arc", "Chrome"). Not translated. */
  browserName: string
  /** The profile's display name in that browser (e.g. "Work"). */
  profileName: string
  /** Extensions that would be installed now. */
  importable: number
  /** Every user-installed extension found in the profile, including skipped ones. */
  total: number
}

/** A profile of another browser, as the picker lists it. */
export interface ImportableProfile {
  /** Directory name under that browser's root ("Default", "Profile 2"). */
  dir: string
  /** The profile's own display name. */
  name: string
}

/** One installed browser and what its chosen profile has to offer. */
export interface ImportableBrowser {
  id: ImportBrowser
  /** Product name, not translated. */
  name: string
  profiles: ImportableProfile[]
  /** The profile the counts below describe. */
  profileDir: string
  bookmarks: { folders: number; tabs: number; favorites: number } | null
  /** Extensions that would be installed now. */
  extensions: number
  logins: { cookies: number; hosts: number; /** localStorage and IndexedDB together. */ siteDataBytes: number } | null
}
