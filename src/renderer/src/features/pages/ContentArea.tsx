import { lazy, Suspense } from 'react'
import { LAYOUT } from '@shared/layout'
import { parseInternalUrl, tabPresentsView } from '@shared/url'
import { selectActiveSpace, selectActiveTab, useBrowser } from '../../stores/browser'
import { PageDialogSheet } from './PageDialogSheet'
import { CrashPage, EmptyState, ErrorPage } from './StatusPages'

// Internal pages are split out: they are rarely open and stay off the boot path.
const SettingsPage = lazy(() => import('./SettingsPage'))
const ExtensionsPage = lazy(() => import('./ExtensionsPage'))
const HistoryPage = lazy(() => import('./HistoryPage'))
const DownloadsPage = lazy(() => import('./DownloadsPage'))
const PasswordsPage = lazy(() => import('../passwords/PasswordsPage'))

/**
 * The page card. Its huge box-shadow paints the window chrome everywhere
 * *outside* the rounded card while the inside stays transparent: when a web
 * page is shown, its WebContentsView sits exactly in this hole, and when the
 * shell is raised for overlays the page still shows through.
 */
export function ContentArea({ left }: { left: string }) {
  const tab = useBrowser(selectActiveTab)
  const space = useBrowser(selectActiveSpace)
  const inset = LAYOUT.gutter + 1

  let content: React.ReactNode = null
  if (!tab) {
    content = <EmptyState spaceName={space?.name ?? ''} spaceIcon={space?.icon} />
  } else if (tab.crashed) {
    content = <CrashPage tab={tab} />
  } else if (tab.error) {
    content = <ErrorPage tab={tab} />
  } else if (!tabPresentsView(tab)) {
    const page = parseInternalUrl(tab.url)
    content = (
      <Suspense fallback={null}>
        {page === 'settings' && <SettingsPage />}
        {page === 'extensions' && <ExtensionsPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'downloads' && <DownloadsPage />}
        {page === 'passwords' && <PasswordsPage />}
      </Suspense>
    )
  }

  return (
    <div
      className="absolute overflow-hidden"
      style={{
        left: `calc(${left} + 1px)`,
        top: inset,
        right: inset,
        bottom: inset,
        borderRadius: LAYOUT.radius - 1,
        boxShadow: '0 0 0 100vmax var(--chrome)'
      }}
    >
      {content && <div className="absolute inset-0 bg-[var(--surface)]">{content}</div>}
      <PageDialogSheet />
    </div>
  )
}
