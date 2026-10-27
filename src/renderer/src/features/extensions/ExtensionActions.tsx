import { memo, useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type { ActionState, ExtensionAction } from '../../../../preload/api'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'

/** Pinned actions that fit in the address pill; the rest stay in the site controls. */
export const MAX_PINNED_ACTIONS = 3

/**
 * Extension action state from electron-chrome-extensions' browserAction API,
 * through the preload bridge. We render our own buttons so pinning, ordering
 * and styling stay under the shell's control. One observer is shared by every
 * component that needs it (the pill and the site controls): main tracks
 * observers per webContents, so a second add/remove pair would cut off both.
 */
const useActionStore = create<{ state: ActionState | null }>(() => ({ state: null }))
let observers = 0
let stopObserving: (() => void) | null = null

function refreshActions(): void {
  const partition = useBrowser.getState().extensionPartition
  if (!partition || observers === 0) return
  window.arc.actions
    .invoke(partition, 'browserAction.getState')
    .then((s) => observers > 0 && useActionStore.setState({ state: s as ActionState }))
    .catch(() => undefined)
}

function observeActions(partition: string): () => void {
  if (observers++ === 0) {
    void window.arc.actions.invoke(partition, 'browserAction.addObserver').catch(() => undefined)
    const off = window.arc.actions.onUpdate(refreshActions)
    stopObserving = () => {
      off()
      void window.arc.actions.invoke(partition, 'browserAction.removeObserver').catch(() => undefined)
    }
  }
  return () => {
    if (--observers > 0) return
    stopObserving?.()
    stopObserving = null
    useActionStore.setState({ state: null })
  }
}

/** Action state while `wanted`; re-read when the active tab or the extension set changes. */
export function useActionState(wanted: boolean): ActionState | null {
  const partition = useBrowser((s) => s.extensionPartition)
  const extensions = useBrowser((s) => s.extensions)
  const activeTabId = useBrowser((s) => selectActiveTab(s)?.id)
  const state = useActionStore((s) => s.state)
  useEffect(() => (wanted && partition ? observeActions(partition) : undefined), [wanted, partition])
  useEffect(() => {
    if (wanted) refreshActions()
  }, [wanted, partition, activeTabId, extensions])
  return wanted ? state : null
}

/**
 * Open the extension's popup or side panel in its own window (main routes
 * it), anchored to `anchor`. From the toolbar a second click closes it.
 */
export function activateAction(extensionId: string, tabId: number, anchor: DOMRect, eventType: string, toggle: boolean): void {
  const partition = useBrowser.getState().extensionPartition
  if (!partition) return
  void window.arc.actions
    .invoke(partition, 'browserAction.activate', {
      eventType,
      extensionId,
      tabId,
      alignment: 'bottom right',
      anchorRect: { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height },
      toggle
    })
    .catch(() => undefined)
}

/** The action's current icon (per tab) with its badge; a neutral glyph if it cannot be served. */
export const ActionIcon = memo(function ActionIcon({
  action,
  tabId,
  size = 16
}: {
  action: ExtensionAction
  tabId: number
  size?: number
}) {
  const partition = useBrowser((s) => s.extensionPartition)
  const info = { ...action, ...(action.tabs[String(tabId)] ?? {}) }
  const params = new URLSearchParams({ tabId: String(tabId), partition })
  if (info.iconModified) params.set('t', String(info.iconModified))
  const icon = `crx://extension-icon/${action.id}/32/2?${params}`
  // Keep the <img> even when it fails (it is the click target's identity),
  // but show the glyph instead of a broken-image marker.
  const [broken, setBroken] = useState<string | null>(null)
  const failed = broken === icon
  return (
    <span className="relative grid place-items-center" style={{ width: size, height: size }}>
      <img
        src={icon}
        width={size}
        height={size}
        alt=""
        draggable={false}
        onError={() => setBroken(icon)}
        className={failed ? 'opacity-0' : ''}
      />
      {failed && (
        <Icon
          name="puzzle"
          size={size}
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[var(--ink)]"
        />
      )}
      {info.text && (
        <span
          className="absolute -bottom-1.5 -right-2 min-w-3 rounded-[4px] px-[3px] text-center text-[9px] font-semibold leading-[12px] text-white shadow-[0_0_0_1px_var(--chrome)]"
          style={{ background: info.color || '#555' }}
        >
          {info.text}
        </span>
      )}
    </span>
  )
})

/** Pinned extension buttons inside the address pill. */
export function PinnedActions() {
  const t = useT()
  const extensions = useBrowser((s) => s.extensions)
  const pinned = useMemo(
    () => extensions.filter((e) => e.enabled && e.pinned && e.hasAction).slice(0, MAX_PINNED_ACTIONS),
    [extensions]
  )
  const state = useActionState(pinned.length > 0)
  if (!state) return null
  const tabId = state.activeTabId ?? -1
  return pinned.map((ext) => {
    const action = state.actions.find((a) => a.id === ext.id)
    if (!action) return null
    const title = action.tabs[String(tabId)]?.title ?? action.title ?? ext.name
    return (
      <button
        key={ext.id}
        title={ext.windowOpen ? t('extWindow.button.openTitle', { title }) : title}
        aria-pressed={ext.windowOpen === true}
        onClick={(e) => activateAction(ext.id, tabId, e.currentTarget.getBoundingClientRect(), e.type, true)}
        onContextMenu={(e) => {
          e.preventDefault()
          send('extensions.contextMenu', ext.id, { x: e.clientX, y: e.clientY })
        }}
        className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] active:bg-[var(--sb-press)] ${
          ext.windowOpen ? 'bg-[var(--sb-active)]' : 'hover:bg-[var(--sb-hover)]'
        }`}
      >
        <ActionIcon action={action} tabId={tabId} />
      </button>
    )
  })
}
