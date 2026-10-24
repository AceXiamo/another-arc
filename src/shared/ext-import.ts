// Importing extensions from another Chromium browser's profile (Arc, Chrome).

/** Browsers whose last-used profile can be imported from. Also the source id. */
export const IMPORT_BROWSERS = ['arc', 'chrome'] as const

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
