import { memo, useEffect, useMemo, useState } from 'react'
import type { ActionState, ExtensionAction } from '../../../../preload/api'
import { Icon } from '../../components/Icon'
import { send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'

/**
 * Pinned extension action buttons. State comes from electron-chrome-extensions'
 * browserAction API through the preload bridge; we render our own buttons so
 * pinning, ordering and styling stay under the shell's control.
 */
export function ExtensionActions() {
  const partition = useBrowser((s) => s.extensionPartition)
  const extensions = useBrowser((s) => s.extensions)
  const activeTabId = useBrowser((s) => selectActiveTab(s)?.id)
  const pinned = useMemo(
    () => extensions.filter((e) => e.enabled && e.pinned && e.hasAction).map((e) => e.id),
    [extensions]
  )
  const [state, setState] = useState<ActionState | null>(null)
  const wanted = pinned.length > 0

  // Observe once while any pinned action exists…
  useEffect(() => {
    if (!wanted || !partition) return
    let alive = true
    const refresh = () =>
      window.arc.actions
        .invoke(partition, 'browserAction.getState')
        .then((s) => alive && setState(s as ActionState))
        .catch(() => undefined)
    void window.arc.actions.invoke(partition, 'browserAction.addObserver').catch(() => undefined)
    const off = window.arc.actions.onUpdate(refresh)
    return () => {
      alive = false
      off()
      void window.arc.actions.invoke(partition, 'browserAction.removeObserver').catch(() => undefined)
    }
  }, [wanted, partition])

  // …and re-read per-tab badges/icons when the active tab or the set changes.
  useEffect(() => {
    if (!wanted || !partition) return
    let alive = true
    window.arc.actions
      .invoke(partition, 'browserAction.getState')
      .then((s) => alive && setState(s as ActionState))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [wanted, partition, activeTabId, extensions])

  if (!wanted || !state) return null
  const actions = pinned
    .map((id) => state.actions.find((a) => a.id === id))
    .filter((a): a is ExtensionAction => a !== undefined)
  if (actions.length === 0) return null
  return (
    <div className="flex flex-wrap gap-0.5">
      {actions.map((a) => (
        <ActionButton key={a.id} action={a} tabId={state.activeTabId ?? -1} partition={partition} />
      ))}
    </div>
  )
}

const ActionButton = memo(function ActionButton({
  action,
  tabId,
  partition
}: {
  action: ExtensionAction
  tabId: number
  partition: string
}) {
  const info = { ...action, ...(action.tabs[String(tabId)] ?? {}) }
  const params = new URLSearchParams({ tabId: String(tabId), partition })
  if (info.iconModified) params.set('t', String(info.iconModified))
  const icon = `crx://extension-icon/${action.id}/32/2?${params}`
  // If the icon cannot be served, keep the <img> (it is the click target's
  // identity) but show a neutral glyph instead of a broken-image marker.
  const [broken, setBroken] = useState<string | null>(null)
  const failed = broken === icon

  const activate = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    void window.arc.actions
      .invoke(partition, 'browserAction.activate', {
        eventType: e.type,
        extensionId: action.id,
        tabId,
        alignment: 'bottom right',
        anchorRect: { x: r.left, y: r.top, width: r.width, height: r.height }
      })
      .catch(() => undefined)
  }

  return (
    <button
      title={info.title ?? ''}
      onClick={activate}
      onContextMenu={(e) => {
        e.preventDefault()
        send('extensions.contextMenu', action.id, { x: e.clientX, y: e.clientY })
      }}
      className="relative grid h-7 w-7 place-items-center rounded-[7px] hover:bg-[var(--sb-hover)] active:bg-[var(--sb-press)]"
    >
      <img
        src={icon}
        width={16}
        height={16}
        alt=""
        draggable={false}
        onError={() => setBroken(icon)}
        className={failed ? 'opacity-0' : ''}
      />
      {failed && (
        <Icon
          name="puzzle"
          size={16}
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[var(--ink)]"
        />
      )}
      {info.text && (
        <span
          className="absolute -bottom-0.5 -right-0.5 min-w-3 rounded-[4px] px-[3px] text-center text-[9px] font-semibold leading-[12px] text-white shadow-[0_0_0_1px_var(--chrome)]"
          style={{ background: info.color || '#555' }}
        >
          {info.text}
        </span>
      )}
    </button>
  )
})
