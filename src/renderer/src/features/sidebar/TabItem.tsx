import { memo } from 'react'
import type { FolderId } from '@shared/types'
import { isSavedTab } from '@shared/tabs'
import { fallbackTitle } from '@shared/url'
import { Favicon } from '../../components/Favicon'
import { Icon } from '../../components/Icon'
import { AgentDot } from '../agent/AgentDot'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'
import { beginDrag, dropBefore, dropBeforeChild, isDragging, treeInset } from './drag'

/** Where a saved tab sits in the saved list. */
export interface TreePosition {
  /** Enclosing folder; null at the top level. */
  parentId: FolderId | null
  depth: number
}

function useTabRow(id: string, pinned: boolean, index: number, tree?: TreePosition) {
  const tab = useBrowser((s) => s.tabs[id])
  const active = useBrowser((s) => {
    const t = s.tabs[id]
    return t ? s.spaces[t.spaceId]?.activeTabId === id : false
  })
  const dragging = useUi(isDragging('tab', id))
  const spaceId = tab?.spaceId ?? ''
  const before = useUi(tree ? dropBeforeChild(spaceId, tree.parentId, index) : dropBefore(spaceId, pinned, index))
  return { tab, active, dragging, before }
}

function handlers(id: string, active: boolean) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      // Activate on press, like Chrome: it feels instant.
      if (!active) send('tabs.activate', id)
      beginDrag(e, { kind: 'tab', id })
    },
    onAuxClick: (e: React.MouseEvent) => {
      // A saved tab is unloaded rather than removed (main decides).
      if (e.button === 1) send('tabs.close', id)
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      send('tabs.contextMenu', id, { x: e.clientX, y: e.clientY })
    }
  }
}

/** Drop indicator drawn at the top edge of a row (inside it: rows use paint containment). */
export function DropLine({ inset = 8 }: { inset?: number }) {
  return <span className="pointer-events-none absolute right-2 top-0 h-0.5 rounded-full bg-[var(--accent)]" style={{ left: inset }} />
}

export const TabItem = memo(function TabItem({ id, index, tree }: { id: string; index: number; tree?: TreePosition }) {
  const t = useT()
  const locale = useLocale()
  const { tab, active, dragging, before } = useTabRow(id, false, index, tree)
  if (!tab) return null
  const title = tab.title || tab.savedTitle || fallbackTitle(tab.url || tab.savedUrl, locale)
  // Unloaded (discarded / restored / closed saved) tabs read quieter until they are woken.
  const asleep = !tab.live && !active
  // A saved tab only offers "close" while it has something to unload.
  const saved = isSavedTab(tab)
  const closable = !saved || tab.live
  const inset = tree ? treeInset(tree.depth) : 10
  return (
    <div
      data-tab-id={id}
      {...(tree && { 'data-tree-row': 'tab', 'data-id': id, 'data-parent': tree.parentId ?? '', 'data-index': index })}
      title={title}
      {...handlers(id, active)}
      className={`tab-row group relative flex h-[34px] shrink-0 items-center gap-2.5 rounded-[10px] pr-1 ${
        active
          ? 'bg-[var(--sb-active)] shadow-[var(--active-shadow)]'
          : dragging
            ? ''
            : 'hover:bg-[var(--sb-hover)] active:bg-[var(--sb-press)]'
      } ${dragging ? 'opacity-40' : ''}`}
      style={{ paddingLeft: inset }}
    >
      {before && <DropLine inset={inset - 2} />}
      <span className="relative flex shrink-0">
        {tab.loading ? (
          <span className="grid h-4 w-4 place-items-center">
            <span className="spinner" />
          </span>
        ) : (
          <span className={`flex ${asleep ? 'opacity-55' : ''}`}>
            <Favicon url={tab.url || tab.savedUrl} favicon={tab.favicon} title={title} />
          </span>
        )}
        {tab.agent && <AgentDot />}
      </span>
      <span
        className={`min-w-0 flex-1 truncate ${
          active
            ? 'font-medium text-[var(--text)]'
            : `${asleep ? 'text-[var(--text-2)]' : 'text-[var(--text-1)]'} group-hover:text-[var(--text)]`
        } ${closable ? '' : 'pr-1.5'}`}
      >
        {title}
      </span>
      {(tab.audible || tab.muted) && (
        <button
          className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[var(--ink)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)]"
          title={tab.muted ? t('sidebar.tabs.unmute') : t('sidebar.tabs.mute')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => send('tabs.setMuted', id, !tab.muted)}
        >
          <Icon name={tab.muted ? 'muted' : 'volume'} size={14} />
        </button>
      )}
      {closable && (
        <button
          className={`grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[var(--ink)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)] active:bg-[var(--press)] ${
            active ? '' : 'opacity-0 group-hover:opacity-100'
          }`}
          title={saved ? t('sidebar.folders.unloadTab') : t('sidebar.tabs.close')}
          aria-label={saved ? t('sidebar.folders.unloadTab') : t('sidebar.tabs.close')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => send('tabs.close', id)}
        >
          <Icon name="close" size={14} strokeWidth={1.8} />
        </button>
      )}
    </div>
  )
})

export const PinnedTile = memo(function PinnedTile({ id, index }: { id: string; index: number }) {
  const locale = useLocale()
  const { tab, active, dragging, before } = useTabRow(id, true, index)
  if (!tab) return null
  const title = tab.title || fallbackTitle(tab.url, locale)
  const asleep = !tab.live && !active
  return (
    <div
      data-tab-id={id}
      title={title}
      {...handlers(id, active)}
      className={`tab-row relative grid h-[46px] place-items-center rounded-[12px] ${
        active
          ? 'bg-[var(--sb-active)] shadow-[var(--active-shadow)]'
          : 'bg-[var(--sb-tile)] hover:bg-[var(--sb-tile-hover)] active:bg-[var(--sb-press)]'
      } ${dragging ? 'opacity-40' : ''} ${before ? 'outline-2 outline-offset-1 outline-[var(--accent)]' : ''}`}
    >
      {tab.loading ? (
        <span className="spinner" />
      ) : (
        <span className={`relative flex ${asleep ? 'opacity-55' : ''}`}>
          <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} size={18} />
          {tab.agent && <AgentDot />}
        </span>
      )}
      {(tab.audible || tab.muted) && (
        <span className="absolute right-1.5 top-1.5 text-[var(--ink)]">
          <Icon name={tab.muted ? 'muted' : 'volume'} size={11} strokeWidth={2} />
        </span>
      )}
    </div>
  )
})
