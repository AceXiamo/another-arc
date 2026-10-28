import { LAYOUT } from '@shared/layout'
import { Toasts } from './components/Toasts'
import { DownloadFlights } from './features/downloads/DownloadFlights'
import { FindSurface } from './features/find/FindSurface'
import { ContentArea } from './features/pages/ContentArea'
import { CommandPalette } from './features/palette/CommandPalette'
import { AutofillSurface } from './features/passwords/AutofillSurface'
import { SavePasswordPrompt } from './features/passwords/SavePasswordPrompt'
import { DragGhost } from './features/sidebar/DragGhost'
import { PeekEdge } from './features/sidebar/PeekEdge'
import { Sidebar } from './features/sidebar/Sidebar'
import { SitePanel } from './features/sidebar/SitePanel'
import { ChromeBackdrop } from './features/theme/ChromeBackdrop'
import { titleBar } from './lib/title-bar'
import { useBrowser } from './stores/browser'
import { useUi } from './stores/ui'

const CARD_CHROME_OFF = { '--chrome': 'transparent' } as React.CSSProperties

export function App() {
  const collapsed = useBrowser((s) => s.window.sidebarCollapsed)
  const htmlFullscreen = useBrowser((s) => s.window.htmlFullscreen)
  const palette = useUi((s) => s.palette)
  const peek = useUi((s) => s.peek)

  if (htmlFullscreen) return null

  const cardLeft = collapsed ? `${LAYOUT.gutter}px` : 'var(--sidebar-width)'
  return (
    <div className="relative h-full w-full">
      <ChromeBackdrop left={cardLeft} />
      {/* The backdrop paints the chrome (gradient, grain), so the card's own
          chrome-colored box-shadow is turned off here. */}
      <div className="contents" style={CARD_CHROME_OFF}>
        <ContentArea left={cardLeft} />
      </div>
      {collapsed ? (
        <PeekEdge />
      ) : (
        // The gap above the page acts as the title bar too (the sidebar header covers the left).
        <div
          {...titleBar}
          data-title-bar
          className="drag absolute right-0 top-0 z-10"
          style={{ left: cardLeft, height: LAYOUT.gutter }}
        />
      )}
      {!collapsed && <Sidebar />}
      {collapsed && peek && <Sidebar floating />}
      <SitePanel />
      {palette && <CommandPalette key={palette} mode={palette} cardLeft={cardLeft} />}
      <FindSurface />
      <AutofillSurface />
      <SavePasswordPrompt />
      <Toasts />
      <DragGhost />
      <DownloadFlights />
    </div>
  )
}
