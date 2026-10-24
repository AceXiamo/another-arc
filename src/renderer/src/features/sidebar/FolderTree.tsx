import { memo, useEffect, useRef } from 'react'
import type { FolderId, SpaceId } from '@shared/types'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { isWithinFolder, optimisticFolder, useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'
import { beginDrag, childDropIndexFor, dragJustEnded, dropBeforeChild, dropInto, isDragging, treeInset } from './drag'
import { DropLine, TabItem } from './TabItem'

function setCollapsed(id: FolderId, collapsed: boolean): void {
  optimisticFolder(id, { collapsed })
  send('folders.setCollapsed', id, collapsed)
}

/**
 * Indicator for "after the last child". Absolutely placed in the gap below the
 * list so it never shifts rows (which would move the hit zones mid-drag).
 */
function EndLine({ inset }: { inset: number }) {
  return (
    <span
      className="pointer-events-none absolute -bottom-0.5 right-2 h-0.5 rounded-full bg-[var(--accent)]"
      style={{ left: inset }}
    />
  )
}

interface NodeProps {
  id: string
  spaceId: SpaceId
  /** Enclosing folder; null at the top level. */
  parentId: FolderId | null
  /** Position among the parent's children. */
  index: number
  depth: number
}

/** An entry of the saved list: a folder or a saved tab, at the top level or nested. */
const TreeNode = memo(function TreeNode(props: NodeProps) {
  const isFolder = useBrowser((s) => props.id in s.folders)
  if (isFolder) return <FolderNode {...props} />
  return <TabItem id={props.id} index={props.index} tree={{ parentId: props.parentId, depth: props.depth }} />
})

function RenameField({ id, name }: { id: FolderId; name: string }) {
  const t = useT()
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select everything but keep the start of a long name in view.
    el.setSelectionRange(0, el.value.length, 'backward')
    el.scrollLeft = 0
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const value = ref.current?.value.trim() ?? ''
    if (commit && value && value !== name) {
      optimisticFolder(id, { name: value })
      send('folders.rename', id, value)
    }
    if (useUi.getState().renamingFolder === id) useUi.setState({ renamingFolder: null })
  }
  // Keep every event inside the field: the row would otherwise drag, toggle
  // or open its menu, and Space / Enter would toggle the folder.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <input
      ref={ref}
      defaultValue={name}
      aria-label={t('sidebar.folders.renameLabel')}
      maxLength={200}
      spellCheck={false}
      className="-ml-1 h-6 min-w-0 flex-1 rounded-[6px] bg-[var(--sb-field)] px-1 text-[var(--text)] shadow-[inset_0_0_0_1px_var(--focus)] outline-none"
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    />
  )
}

/** Quiet hint inside an open folder that holds nothing yet; also a drop target. */
function EmptyHint({ id, depth }: { id: FolderId; depth: number }) {
  const t = useT()
  return (
    <div
      data-tree-row="empty"
      data-id={id}
      data-parent={id}
      data-index={0}
      className="flex h-7 shrink-0 items-center truncate pr-2 text-[12px] text-[var(--text-3)]"
      style={{ paddingLeft: treeInset(depth) }}
    >
      {t('sidebar.folders.empty')}
    </div>
  )
}

const FolderNode = memo(function FolderNode({ id, spaceId, parentId, index, depth }: NodeProps) {
  const folder = useBrowser((s) => s.folders[id])
  const renaming = useUi((s) => s.renamingFolder === id)
  const dragging = useUi(isDragging('folder', id))
  const before = useUi(dropBeforeChild(spaceId, parentId, index))
  const into = useUi(dropInto(id))
  const endIndex = useUi(childDropIndexFor(spaceId, id))
  // A collapsed folder still shows the active tab when it lives inside it (as in Arc).
  const peekId = useBrowser((s) => {
    const active = s.spaces[spaceId]?.activeTabId
    const tab = active ? s.tabs[active] : undefined
    return s.folders[id]?.collapsed && tab?.folderId && isWithinFolder(s.folders, tab.folderId, id) ? tab.id : null
  })
  const peekParent = useBrowser((s) => (peekId ? (s.tabs[peekId]?.folderId ?? null) : null))
  const peekIndex = useBrowser((s) => (peekId && peekParent ? (s.folders[peekParent]?.childIds.indexOf(peekId) ?? 0) : 0))
  if (!folder) return null

  const open = !folder.collapsed
  const count = folder.childIds.length
  const inset = treeInset(depth)
  const rename = () => useUi.setState({ renamingFolder: id })

  return (
    <div className={`relative flex flex-col gap-0.5 ${dragging ? 'opacity-40' : ''}`}>
      <div
        data-tree-row="folder"
        data-id={id}
        data-parent={parentId ?? ''}
        data-index={index}
        role={renaming ? undefined : 'button'}
        tabIndex={renaming ? undefined : 0}
        aria-expanded={open}
        title={renaming ? undefined : folder.name}
        onPointerDown={(e) => {
          if (!renaming) beginDrag(e, { kind: 'folder', id })
        }}
        onClick={(e) => {
          // The second click of a double-click belongs to rename.
          if (renaming || e.detail > 1 || dragJustEnded()) return
          setCollapsed(id, open)
        }}
        onDoubleClick={() => {
          if (renaming) return
          // Undo the first click's toggle, then edit the name.
          const current = useBrowser.getState().folders[id]
          if (current) setCollapsed(id, !current.collapsed)
          rename()
        }}
        onKeyDown={(e) => {
          if (renaming || e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') setCollapsed(id, open)
          else if (e.key === 'ArrowRight' && !open) setCollapsed(id, false)
          else if (e.key === 'ArrowLeft' && open) setCollapsed(id, true)
          else if (e.key === 'F2') rename()
          else return
          e.preventDefault()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          send('folders.contextMenu', id, { x: e.clientX, y: e.clientY })
        }}
        className={`tab-row group relative flex h-[34px] shrink-0 items-center gap-2.5 rounded-[10px] pr-2 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)] ${
          into ? 'bg-[var(--accent-soft)]' : dragging ? '' : 'hover:bg-[var(--sb-hover)] active:bg-[var(--sb-press)]'
        }`}
        style={{ paddingLeft: inset }}
      >
        {before && <DropLine inset={inset - 2} />}
        <Icon
          name={open ? 'folderOpen' : 'folder'}
          size={16}
          className={into ? 'text-[var(--accent)]' : 'text-[var(--ink)] group-hover:text-[var(--ink-strong)]'}
        />
        {renaming ? (
          <RenameField id={id} name={folder.name} />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[var(--text-1)] group-hover:text-[var(--text)]">{folder.name}</span>
        )}
        {!renaming && !open && count > 0 && (
          <span aria-hidden="true" className="shrink-0 text-[11px] tabular-nums text-[var(--text-3)]">
            {count}
          </span>
        )}
      </div>
      {open &&
        (count === 0 ? (
          <EmptyHint id={id} depth={depth + 1} />
        ) : (
          folder.childIds.map((childId, i) => (
            <TreeNode key={childId} id={childId} spaceId={spaceId} parentId={id} index={i} depth={depth + 1} />
          ))
        ))}
      {open && count > 0 && endIndex >= count && <EndLine inset={treeInset(depth + 1) - 2} />}
      {peekId && peekParent && <TabItem id={peekId} index={peekIndex} tree={{ parentId: peekParent, depth: depth + 1 }} />}
    </div>
  )
})

/**
 * The saved list of a space (Arc's pinned section): saved tabs and folders,
 * between the space label and today's tabs.
 */
export function FolderTree({ spaceId, savedIds }: { spaceId: SpaceId; savedIds: readonly string[] }) {
  const atEnd = useUi((s) => childDropIndexFor(spaceId, null)(s) >= savedIds.length)
  return (
    <div data-tab-section="folders" data-space-id={spaceId} className="mt-0.5 flex shrink-0 flex-col">
      <div className="relative flex flex-col gap-0.5">
        {savedIds.map((id, i) => (
          <TreeNode key={id} id={id} spaceId={spaceId} parentId={null} index={i} depth={0} />
        ))}
        {atEnd && <EndLine inset={treeInset(0) - 2} />}
      </div>
      {/* Arc-style divider between the saved list and today's tabs. */}
      <div className="flex h-4 items-center px-2.5" aria-hidden="true">
        <span className="h-px flex-1 bg-[var(--sb-line)]" />
      </div>
    </div>
  )
}
