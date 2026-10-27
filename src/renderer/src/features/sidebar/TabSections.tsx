import { SpaceIcon } from '../../components/SpaceIcon'
import { quietScrollbar } from '../../lib/quiet-scrollbar'
import { send } from '../../lib/rpc'
import { selectActiveSpace, useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'
import { dropIndexFor } from './drag'
import { FolderTree } from './FolderTree'
import { PinnedTile, TabItem } from './TabItem'

/** Space name with a hairline rule, separating pinned tiles from tabs (as in Arc). */
function SpaceLabel({ id, name, icon }: { id: string; name: string; icon: string }) {
  return (
    <div
      className="flex h-7 shrink-0 items-center gap-2 px-2"
      onDoubleClick={() => useUi.setState({ spaceEditor: id })}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        send('spaces.contextMenu', id, { x: e.clientX, y: e.clientY })
      }}
    >
      <SpaceIcon icon={icon} size={13} className="text-[var(--ink)]" />
      <span className="max-w-[60%] truncate text-[12px] font-semibold text-[var(--text-2)]">{name}</span>
      <span className="h-px min-w-4 flex-1 bg-[var(--sb-line)]" />
    </div>
  )
}

export function TabSections() {
  const space = useBrowser(selectActiveSpace)
  const pinnedEnd = useUi(
    (s) => space !== undefined && dropIndexFor(space.id, true)(s) >= space.pinnedTabIds.length
  )
  const tabsEnd = useUi((s) => space !== undefined && dropIndexFor(space.id, false)(s) >= space.tabIds.length)
  const draggingTab = useUi((s) => s.drag?.item.kind === 'tab')
  if (!space) return <div className="flex-1" />

  const showPinned = space.pinnedTabIds.length > 0 || draggingTab
  return (
    <div
      className="no-drag flex min-h-0 flex-1 flex-col"
      // Rows and labels stop propagation, so this only fires on empty space.
      onContextMenu={(e) => {
        e.preventDefault()
        send('sidebar.contextMenu', space.id, { x: e.clientX, y: e.clientY })
      }}
    >
      {/* Favorites and the space name stay put (as in Arc); only the lists below scroll. */}
      <div className="flex shrink-0 flex-col px-2 pt-1">
        {showPinned && (
          <div
            data-tab-section="pinned"
            data-space-id={space.id}
            className={`mb-1.5 grid grid-cols-[repeat(auto-fit,minmax(52px,1fr))] gap-1.5 rounded-[12px] ${
              space.pinnedTabIds.length === 0 ? 'min-h-[46px] border border-dashed border-[var(--ink-faint)]' : ''
            } ${pinnedEnd ? 'outline-2 outline-offset-2 outline-[var(--accent)]' : ''}`}
          >
            {space.pinnedTabIds.map((id, i) => (
              <PinnedTile key={id} id={id} index={i} />
            ))}
          </div>
        )}

        <SpaceLabel id={space.id} name={space.name} icon={space.icon} />
      </div>

      <div ref={quietScrollbar} data-sidebar-scroll className="scroll-y-quiet flex min-h-0 flex-1 flex-col px-2 pb-2">
        {space.savedIds.length > 0 && <FolderTree spaceId={space.id} savedIds={space.savedIds} />}

        <div
          data-tab-section="tabs"
          data-space-id={space.id}
          className={`flex min-h-10 flex-1 flex-col gap-0.5 pb-6 ${space.savedIds.length > 0 ? '' : 'mt-0.5'}`}
        >
          {space.tabIds.map((id, i) => (
            <TabItem key={id} id={id} index={i} />
          ))}
          {tabsEnd && <div className="pointer-events-none mx-2 h-0.5 rounded-full bg-[var(--accent)]" />}
        </div>
      </div>
    </div>
  )
}
