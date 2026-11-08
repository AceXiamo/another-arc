import { lazy, Suspense } from 'react'
import { LAYOUT } from '@shared/layout'
import { parseInternalUrl, tabPresentsView } from '@shared/url'
import { holeOf, type Insets } from '../../lib/card-layout'
import { selectActiveSpace, selectActiveTab, useBrowser } from '../../stores/browser'
import { DeviceFrame } from './DeviceFrame'
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
 * shell is raised for overlays the page still shows through. `page` is where
 * the page's view goes (the card, less docked DevTools).
 */
export function ContentArea({ page }: { page: Insets }) {
  const tab = useBrowser(selectActiveTab)
  const space = useBrowser(selectActiveSpace)
  const hole = holeOf(page)

  let content: React.ReactNode = null
  if (!tab) {
    content = <EmptyState spaceName={space?.name ?? ''} spaceIcon={space?.icon} />
  } else if (tab.crashed) {
    content = <CrashPage tab={tab} />
  } else if (tab.error) {
    content = <ErrorPage tab={tab} />
  } else if (tab.viewport && tabPresentsView(tab)) {
    content = 'device'
  } else if (!tabPresentsView(tab)) {
    const internal = parseInternalUrl(tab.url)
    content = (
      <Suspense fallback={null}>
        {internal === 'settings' && <SettingsPage />}
        {internal === 'extensions' && <ExtensionsPage />}
        {internal === 'history' && <HistoryPage />}
        {internal === 'downloads' && <DownloadsPage />}
        {internal === 'passwords' && <PasswordsPage />}
      </Suspense>
    )
  }

  return (
    <div
      data-page-card
      className="absolute overflow-hidden"
      style={{
        ...hole,
        borderRadius: LAYOUT.radius - 1,
        boxShadow: '0 0 0 100vmax var(--chrome)'
      }}
    >
      {content === 'device' && tab?.viewport ? (
        <DeviceFrame tabId={tab.id} viewport={tab.viewport} />
      ) : (
        content && (
          <div data-card-content className="absolute inset-0 bg-[var(--surface)]">
            {content}
          </div>
        )
      )}
      <PageDialogSheet />
    </div>
  )
}
