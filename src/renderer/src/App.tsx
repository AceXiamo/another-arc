import { LAYOUT } from '@shared/layout'
import { Toasts } from './components/Toasts'
import { FindSurface } from './features/find/FindSurface'
import { ContentArea } from './features/pages/ContentArea'
import { CommandPalette } from './features/palette/CommandPalette'
import { DragGhost } from './features/sidebar/DragGhost'
import { PeekEdge } from './features/sidebar/PeekEdge'
import { Sidebar } from './features/sidebar/Sidebar'
import { useBrowser } from './stores/browser'
import { useUi } from './stores/ui'

export function App() {
  const collapsed = useBrowser((s) => s.window.sidebarCollapsed)
  const htmlFullscreen = useBrowser((s) => s.window.htmlFullscreen)
  const palette = useUi((s) => s.palette)
  const peek = useUi((s) => s.peek)

  if (htmlFullscreen) return null

  const cardLeft = collapsed ? `${LAYOUT.gutter}px` : 'var(--sidebar-width)'
  return (
    <div className="relative h-full w-full">
      <ContentArea left={cardLeft} />
      {collapsed ? <PeekEdge /> : <Sidebar />}
      {collapsed && peek && <Sidebar floating />}
      {palette && <CommandPalette key={palette} mode={palette} cardLeft={cardLeft} />}
      <FindSurface />
      <Toasts />
      <DragGhost />
    </div>
  )
}
