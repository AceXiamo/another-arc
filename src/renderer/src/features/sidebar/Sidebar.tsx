import { useRef } from 'react'
import { send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'
import { AddressPill } from './AddressPill'
import { PermissionPrompts } from './PermissionPrompts'
import { SidebarHeader } from './SidebarHeader'
import { SidebarResizer } from './SidebarResizer'
import { SpaceBar } from './SpaceBar'
import { SpaceEditor } from './SpaceEditor'
import { TabSections } from './TabSections'

const SWIPE_THRESHOLD = 90
const SWIPE_COOLDOWN_MS = 450

/** Two-finger horizontal swipe on the sidebar switches spaces (as in Arc). */
function useSpaceSwipe() {
  const acc = useRef(0)
  const lockedUntil = useRef(0)
  return (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const now = performance.now()
    if (now < lockedUntil.current) return
    acc.current += e.deltaX
    if (Math.abs(acc.current) < SWIPE_THRESHOLD) return
    const direction = acc.current > 0 ? 1 : -1
    acc.current = 0
    lockedUntil.current = now + SWIPE_COOLDOWN_MS
    const { spaceOrder, window } = useBrowser.getState()
    const i = spaceOrder.indexOf(window.activeSpaceId)
    const next = spaceOrder[i + direction]
    if (next) send('spaces.activate', next)
  }
}

export function Sidebar({ floating = false }: { floating?: boolean }) {
  const editor = useUi((s) => s.spaceEditor)
  const focused = useBrowser((s) => s.window.focused)
  const onWheel = useSpaceSwipe()
  return (
    <aside
      onWheel={onWheel}
      onPointerLeave={
        floating
          ? () => {
              // The theme panel and the site controls float beside the sidebar; reaching them must not end the peek.
              const ui = useUi.getState()
              if (!ui.spaceEditor && !ui.sitePanel) useUi.setState({ peek: false })
            }
          : undefined
      }
      className={`chrome-ink absolute bottom-0 left-0 top-0 flex flex-col ${
        floating ? 'chrome-surface anim-slide z-30 rounded-r-[12px] shadow-[var(--popover-shadow)]' : ''
      } ${focused ? '' : 'saturate-[0.85]'}`}
      style={{ width: 'var(--sidebar-width)' }}
    >
      <SidebarHeader />
      <div className="no-drag flex flex-col gap-2 px-2 pb-2">
        <AddressPill />
        <PermissionPrompts />
      </div>
      <TabSections />
      <SpaceBar />
      {editor && <SpaceEditor key={editor} target={editor} />}
      {!floating && <SidebarResizer />}
    </aside>
  )
}
