import { join } from 'node:path'
import { dialog, type BaseWindow, type Session } from 'electron'
import type { ImportableBrowser, ImportBrowser } from '@shared/ext-import'
import type { Translate } from '@shared/i18n'
import type { ImportCandidate } from '../extensions/browser-import'
import type { ExtensionManager } from '../extensions/extension-manager'
import type { FaviconCache } from '../history/favicon-cache'
import type { TabManager } from '../tabs/tab-manager'
import { summarizeSidebar, type ArcSidebar } from './arc-sidebar'
import { browserName, browserRoots, lastUsedProfile, listProfiles, resolveRoot, type BrowserProfile } from './browsers'
import {
  importSession,
  needsRestart,
  partitionDirName,
  siteDataBytes,
  surveySession,
  type SessionSummary
} from './session-import'
import { applySidebar, importFavicons, loadBookmarks } from './sidebar-import'

// "Import from another browser": bookmarks, extensions and the signed-in
// state of one profile, in one confirmation. Offered once on a fresh
// profile, and available from the File menu, Settings and ⌘T.
//
// Every browser goes through the same three readers; which ones have
// anything to say is decided per browser by `browsers.ts`.

export interface ImportHost {
  tabs: TabManager
  favicons: FaviconCache
  extensions: ExtensionManager
  /** Current-language translator (read on each use). */
  readonly t: Translate
  parent(): BaseWindow | null
  toast(message: string): void
  /** The browsing session the cookies go into, and the partition behind it. */
  profileSession(): Session
  profilePartition(): string
  userData(): string
  /** Where imported passwords go. */
  passwordStore(): import('../passwords/password-store').PasswordStore
  /** Restart the app, so staged site storage can be moved in. */
  relaunch(): void
}

/** Everything one profile of one browser has to offer. */
interface Candidate {
  browser: ImportBrowser
  /** Absolute path of the profile folder. */
  profileDir: string
  profile: BrowserProfile
  profiles: BrowserProfile[]
  bookmarks: ArcSidebar | null
  extensions: ImportCandidate[]
  session: SessionSummary | null
}

/** Used when a browser keeps no profile list we can read. */
const FALLBACK_PROFILE: BrowserProfile = { dir: 'Default', name: 'Default' }

let importing = false

/** True when this profile holds nothing an import would add to (first-run offer). */
export function isFreshProfile(host: ImportHost): boolean {
  const { model } = host.tabs
  const hasSaved = model.spaceOrder.some((id) => (model.getSpace(id)?.savedIds.length ?? 0) > 0)
  return !hasSaved && host.extensions.info().length === 0
}

/** Every installed browser and what it would bring over, for the Settings list. */
export async function scanImportable(host: ImportHost, chosen: Record<string, string> = {}): Promise<ImportableBrowser[]> {
  const found = await Promise.all(
    browserRoots().map((r) => survey(host, r.browser, chosen[r.browser]).catch(() => null))
  )
  return found.filter((c): c is Candidate => c !== null && hasSomething(c)).map(toSummary)
}

/**
 * Confirm, import, report — native dialogs only. With `firstRun`, nothing is
 * said when there is nothing to offer, and the second button reads "Not Now".
 */
export async function importFromBrowser(
  host: ImportHost,
  browser: ImportBrowser,
  opts: { profileDir?: string; firstRun?: boolean } = {}
): Promise<void> {
  if (importing) return
  importing = true
  try {
    await run(host, browser, opts)
  } finally {
    importing = false
  }
}

/** The browser to offer on a fresh profile: whichever has the most to bring. */
export async function bestImportCandidate(host: ImportHost): Promise<ImportBrowser | null> {
  const browsers = await scanImportable(host)
  let best: ImportableBrowser | null = null
  for (const b of browsers) if (!best || weigh(b) > weigh(best)) best = b
  return best?.id ?? null
}

function weigh(b: ImportableBrowser): number {
  const bookmarks = b.bookmarks ? b.bookmarks.tabs + b.bookmarks.favorites : 0
  return bookmarks * 10 + b.extensions * 50 + (b.logins?.hosts ?? 0)
}

async function survey(host: ImportHost, browser: ImportBrowser, profileDir?: string): Promise<Candidate | null> {
  const base = browserRoots().find((r) => r.browser === browser)?.root
  if (!base) return null
  // Arc keeps its sidebar outside the profile tree, so a browser with no
  // readable profile can still have bookmarks to offer. Everything else
  // then reads nothing and `hasSomething` drops it.
  const root = (await resolveRoot(base)) ?? base
  const profiles = await listProfiles(root)
  const profile = profiles.find((p) => p.dir === profileDir) ?? (await lastUsedProfile(root)) ?? FALLBACK_PROFILE
  const absolute = join(root, profile.dir)

  const userData = host.userData()
  const partition = partitionDirName(host.profilePartition())
  const [bookmarks, source, session] = await Promise.all([
    loadBookmarks(browser, root, profile.dir).catch(() => null),
    host.extensions.sourceFor(browser, profile).catch(() => null),
    surveySession(browser, absolute, userData, partition).catch(() => null)
  ])
  return {
    browser,
    profileDir: absolute,
    profile,
    profiles,
    bookmarks,
    extensions: source?.extensions.filter((c) => !c.skip) ?? [],
    session
  }
}

function hasSomething(c: Candidate): boolean {
  const counts = c.bookmarks ? summarizeSidebar(c.bookmarks) : null
  return (counts !== null && counts.tabs + counts.favorites > 0) || c.extensions.length > 0 || c.session !== null
}

function toSummary(c: Candidate): ImportableBrowser {
  const counts = c.bookmarks ? summarizeSidebar(c.bookmarks) : null
  return {
    id: c.browser,
    name: browserName(c.browser),
    profiles: c.profiles.map((p) => ({ dir: p.dir, name: p.name })),
    profileDir: c.profile.dir,
    bookmarks: counts && counts.tabs + counts.favorites > 0 ? { folders: counts.folders, tabs: counts.tabs, favorites: counts.favorites } : null,
    extensions: c.extensions.length,
    logins: c.session ? { cookies: c.session.cookies, hosts: c.session.hosts, siteDataBytes: siteDataBytes(c.session) } : null
  }
}

async function run(
  host: ImportHost,
  browser: ImportBrowser,
  { profileDir, firstRun = false }: { profileDir?: string; firstRun?: boolean }
): Promise<void> {
  const { t } = host
  const parent = host.parent()
  const show = (options: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  const name = browserName(browser)

  const candidate = await survey(host, browser, profileDir)
  if (!candidate || !hasSomething(candidate)) {
    if (!firstRun) await show({ type: 'info', message: t('browserImport.nothing', { browser: name }), buttons: [t('common.close')] })
    return
  }
  const counts = candidate.bookmarks ? summarizeSidebar(candidate.bookmarks) : null
  const hasBookmarks = counts !== null && counts.tabs + counts.favorites > 0
  const { extensions, session } = candidate

  const detail = [
    // Which profile only matters when there is more than one.
    ...(candidate.profiles.length > 1 ? [t('browserImport.all.profile', { profile: candidate.profile.name })] : []),
    ...(hasBookmarks ? [t('browserImport.all.bookmarks', counts)] : []),
    ...(extensions.length > 0
      ? [t('browserImport.all.extensions', { count: extensions.length, names: extensions.map((c) => c.name).join(', ') })]
      : []),
    ...(session && session.passwords > 0 ? [t('passwords.import.count', { count: session.passwords })] : []),
    ...(session
      ? [
          t('browserImport.all.session', {
            cookies: session.cookies,
            hosts: session.hosts,
            sites: session.indexedDb.origins,
            mb: megabytes(siteDataBytes(session))
          })
        ]
      : []),
    '',
    t('browserImport.all.note'),
    ...(session ? ['', t('browserImport.session.note', { browser: name })] : [])
  ]
  const { response, checkboxChecked } = await show({
    type: 'question',
    message: t('browserImport.all.message', { browser: name, profile: candidate.profile.name }),
    detail: detail.join('\n'),
    buttons: [t('browserImport.confirm.import'), firstRun ? t('browserImport.all.notNow') : t('common.cancel')],
    defaultId: 0,
    cancelId: 1,
    ...(session ? { checkboxLabel: t('browserImport.session.checkbox'), checkboxChecked: true } : {})
  })
  if (response !== 0) return

  const lines: string[] = []
  if (hasBookmarks && candidate.bookmarks) {
    const result = applySidebar(host.tabs, candidate.bookmarks)
    void importFavicons(host.tabs, host.favicons, result.tabIds, candidate.profileDir)
    lines.push(
      t('browserImport.result.bookmarks', {
        tabs: result.tabs,
        folders: result.folders,
        favorites: result.favorites,
        duplicates: result.duplicates
      })
    )
  }
  if (extensions.length > 0) {
    // Installing takes a few seconds; the bookmarks are already in the sidebar.
    host.toast(t('browserImport.all.installing', { count: extensions.length }))
    const results = (await host.extensions.importFrom(browser, candidate.profile))?.results ?? []
    const failed = results.filter((r) => r.error !== null)
    lines.push(
      '',
      t('extImport.result.count', { count: results.length - failed.length, total: results.length }),
      ...(failed.length > 0
        ? [
            t('extImport.result.failedHeading', { count: failed.length }),
            ...failed.map((r) => `• ${t('extImport.itemWithReason', { name: r.name, reason: r.error ?? '' })}`)
          ]
        : []),
      '',
      t('extImport.result.dataNote', { browser: name })
    )
  }

  let restart = false
  if (session && checkboxChecked) {
    // The keychain may put a system prompt in front of the user first.
    host.toast(t('browserImport.session.importing', { browser: name }))
    const result = await importSession(
      host.profileSession(),
      session,
      host.userData(),
      partitionDirName(host.profilePartition()),
      host.passwordStore()
    )
    restart = needsRestart(result)
    const { partitioned, sessionOnly, expired, undecryptable, malformed } = result.skipped
    const { localStorageBytes, indexedDbOrigins, indexedDbBytes } = result.staged
    lines.push(
      '',
      ...(result.failure === 'keychain'
        ? [t('browserImport.session.result.noKey', { browser: name })]
        : result.failure === 'unreadable'
          ? [t('browserImport.session.result.unreadable', { browser: name })]
          : [
              t('browserImport.session.result.cookies', {
                count: result.cookies,
                skipped: sessionOnly + expired + undecryptable + malformed + result.rejected
              }),
              ...(partitioned > 0 ? [t('browserImport.session.result.partitioned', { count: partitioned })] : []),
              ...(restart
                ? [
                    t('browserImport.session.result.staged', {
                      mb: megabytes(localStorageBytes + indexedDbBytes),
                      sites: indexedDbOrigins
                    })
                  ]
                : []),
              ...passwordLines(result, t)
            ])
    )
  }

  await show({
    type: 'info',
    message: t('browserImport.result.message', { browser: name }),
    detail: lines.join('\n'),
    buttons: [t('common.close')]
  })

  if (restart) {
    const { response: restart } = await show({
      type: 'question',
      message: t('browserImport.session.restart.message'),
      detail: t('browserImport.session.restart.detail', { browser: name }),
      buttons: [t('browserImport.session.restart.now'), t('browserImport.session.restart.later')],
      defaultId: 0,
      cancelId: 1
    })
    if (restart === 0) host.relaunch()
  }
}

/** What came of the saved passwords, and what could not. */
function passwordLines(result: Awaited<ReturnType<typeof importSession>>, t: Translate): string[] {
  const { imported, skipped } = result.passwords
  if (imported === 0 && skipped.inKeychain === 0) return []
  return [
    t('passwords.import.result', {
      count: imported,
      skipped: skipped.android + skipped.blacklisted + skipped.undecryptable
    }),
    ...(skipped.inKeychain > 0 ? [t('passwords.import.inKeychain', { count: skipped.inKeychain })] : [])
  ]
}

/** Dialog-sized number: whole megabytes, and never a bare "0". */
function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? String(Math.round(mb)) : mb > 0 ? '<1' : '0'
}
