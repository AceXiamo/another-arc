import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MessageKey } from '@shared/i18n'
import type { ExtensionInfo, PermissionDecision, SitePermission } from '@shared/types'
import { isInternalUrl, originOf, securityLevel } from '@shared/url'
import { Icon, type IconName } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useSurface } from '../../lib/surface'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import { toast, useUi } from '../../stores/ui'
import { ActionIcon, activateAction, useActionState } from '../extensions/ExtensionActions'

const WIDTH = 264
const EDGE = 8
/** Gap between the button and the card (the arrow sits in it). */
const GAP = 11
/** Transparent room around the card inside its surface: the arrow above, the shadow around. */
const ROOM = { top: 10, side: 28, bottom: 44 }

const PERMISSIONS: Record<string, { label: MessageKey; icon: IconName }> = {
  media: { label: 'settings.permissions.media', icon: 'camera' },
  geolocation: { label: 'settings.permissions.geolocation', icon: 'location' },
  notifications: { label: 'settings.permissions.notifications', icon: 'bell' },
  'clipboard-read': { label: 'settings.permissions.clipboardRead', icon: 'clipboard' },
  midiSysex: { label: 'settings.permissions.midiSysex', icon: 'shield' },
  'idle-detection': { label: 'settings.permissions.idleDetection', icon: 'shield' },
  'window-management': { label: 'settings.permissions.windowManagement', icon: 'shield' },
  'storage-access': { label: 'settings.permissions.storageAccess', icon: 'shield' },
  'top-level-storage-access': { label: 'settings.permissions.storageAccess', icon: 'shield' },
  fileSystem: { label: 'settings.permissions.fileSystem', icon: 'folder' },
  openExternal: { label: 'settings.permissions.openExternal', icon: 'external' }
}

let dismissedAt = -Infinity

/** It lost focus (main says so): a press somewhere else, maybe on its own button. */
export function dismissSitePanel(): void {
  if (useUi.getState().sitePanel) dismissedAt = performance.now()
  close()
}

function close(): void {
  const ui = useUi.getState()
  if (!ui.sitePanel) return
  // A peeking sidebar stays while the panel is open (see Sidebar); let it go
  // with the panel unless the pointer is back on it.
  const peekEnds = ui.peek && !document.querySelector('aside:hover')
  useUi.setState({ sitePanel: null, ...(peekEnds ? { peek: false } : {}) })
}

let openAtPress = false

/**
 * The controls button was pressed. Pressing it takes the focus from an open
 * panel, which closes it before the click: remember it was open. (Main's
 * word that it lost focus can also beat the press here by a moment.)
 */
export function pressSitePanelButton(): void {
  openAtPress = useUi.getState().sitePanel !== null || performance.now() - dismissedAt < 150
}

/** The controls button's click: open under it, or close. */
export function toggleSitePanel(button: HTMLElement): void {
  const wasOpen = openAtPress || useUi.getState().sitePanel !== null
  openAtPress = false
  if (wasOpen) return close()
  const r = button.getBoundingClientRect()
  useUi.setState({ sitePanel: { x: r.left + r.width / 2, y: r.bottom } })
}

/** Top-left of the panel's surface in the window, for menus and popups anchored inside it. */
const SurfaceOrigin = createContext({ x: 0, y: 0 })

function useToWindow() {
  const origin = useContext(SurfaceOrigin)
  return (r: DOMRect) => new DOMRect(r.x + origin.x, r.y + origin.y, r.width, r.height)
}

/**
 * Site controls (Arc's "site menu"): quick actions for the page, every
 * extension (pin one to keep it in the address pill), this site's remembered
 * permissions and its connection. It floats in a surface of its own, hanging
 * from the pill's controls button, so the page next to it is never covered or
 * repainted; clicking anywhere else (it loses focus) or Escape closes it.
 */
export function SitePanel() {
  const anchor = useUi((s) => s.sitePanel)
  const tabId = useBrowser((s) => selectActiveTab(s)?.id)
  const spaceId = useBrowser((s) => s.window.activeSpaceId)
  const collapsed = useBrowser((s) => s.window.sidebarCollapsed)
  const peek = useUi((s) => s.peek)
  const sidebarGone = collapsed && !peek
  const palette = useUi((s) => s.palette !== null)
  // Created on first use, then kept (hidden) so it opens instantly.
  const [used, setUsed] = useState(false)
  if (anchor && !used) setUsed(true)
  const root = useSurface('sitePanel', used)
  // Another tab or space, the sidebar going away or the palette opening leaves the panel behind.
  useEffect(() => close(), [tabId, spaceId])
  useEffect(() => {
    if (sidebarGone || palette) close()
  }, [sidebarGone, palette])
  if (!root || !anchor) return null
  return createPortal(<PanelFrame anchor={anchor} />, root)
}

function PanelFrame({ anchor }: { anchor: { x: number; y: number } }) {
  const card = useRef<HTMLDivElement>(null)
  const left = Math.max(EDGE, Math.min(anchor.x - WIDTH / 2, window.innerWidth - WIDTH - EDGE))
  const origin = useMemo(() => ({ x: Math.round(left - ROOM.side), y: Math.round(anchor.y + GAP - ROOM.top) }), [left, anchor.y])

  // Size the surface to the card (it grows as extensions and permissions
  // load), show it, and close on Escape; hide it when closed. Losing focus
  // closes it too, but that comes from main: the surface's own window gets
  // no blur event when another view takes the focus.
  useLayoutEffect(() => {
    const node = card.current
    const view = node?.ownerDocument.defaultView
    if (!node || !view) return
    const place = () =>
      send('sitePanel.place', {
        x: origin.x,
        y: origin.y,
        width: WIDTH + 2 * ROOM.side,
        height: Math.ceil(node.offsetHeight) + ROOM.top + ROOM.bottom
      })
    place()
    send('surface.setVisible', 'sitePanel', true)
    const resize = new view.ResizeObserver(place)
    resize.observe(node)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    view.addEventListener('keydown', onKey)
    return () => {
      resize.disconnect()
      view.removeEventListener('keydown', onKey)
      send('surface.setVisible', 'sitePanel', false)
    }
  }, [origin])

  return (
    // The room around the card belongs to the surface: a press there closes, like anywhere else.
    <div className="relative h-full" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={card}
        role="dialog"
        className="anim-pop absolute flex flex-col rounded-[14px] bg-[var(--popover)] p-2 text-[var(--text)] shadow-[var(--popover-shadow)]"
        style={{ left: ROOM.side, top: ROOM.top, width: WIDTH, transformOrigin: `${anchor.x - left}px -8px` }}
      >
        {/* Arrow pointing at the button. */}
        <span
          aria-hidden
          className="absolute -top-[5px] h-2.5 w-2.5 rotate-45 rounded-tl-[3px] bg-[var(--popover)] shadow-[-0.5px_-0.5px_0_var(--popover-line)]"
          style={{ left: anchor.x - left - 5 }}
        />
        <SurfaceOrigin.Provider value={origin}>
          <PanelBody />
        </SurfaceOrigin.Provider>
      </div>
    </div>
  )
}

function PanelBody() {
  const t = useT()
  const toWindow = useToWindow()
  const tab = useBrowser(selectActiveTab)
  const extensions = useBrowser((s) => s.extensions)
  const enabled = useMemo(() => extensions.filter((e) => e.enabled), [extensions])
  const state = useActionState(enabled.some((e) => e.hasAction))
  const origin = tab && !isInternalUrl(tab.url) ? originOf(tab.url) : null
  const [permissions, setPermissions] = useState<SitePermission[]>([])
  useEffect(() => {
    let alive = true
    if (origin) void rpc('permissions.list').then((all) => alive && setPermissions(all.filter((p) => p.origin === origin)))
    return () => {
      alive = false
    }
  }, [origin])

  const live = tab?.live === true
  const web = tab !== undefined && !isInternalUrl(tab.url)
  const level = tab ? securityLevel(tab.url) : 'internal'
  const certError = tab?.error?.kind === 'certificate'
  const actionTabId = state?.activeTabId ?? -1

  return (
    <>
      <div className="grid grid-cols-4 gap-1.5">
        <QuickAction
          icon="share"
          label={t('sidebar.site.share')}
          disabled={!web}
          onClick={(e) => {
            const r = toWindow(e.currentTarget.getBoundingClientRect())
            close()
            if (tab) send('tabs.share', tab.id, { x: r.left, y: r.bottom + 4 })
          }}
        />
        <QuickAction
          icon="camera"
          label={t('sidebar.site.screenshot')}
          disabled={!live}
          onClick={() => {
            close()
            if (tab) void rpc('tabs.copyScreenshot', tab.id).then((ok) => ok && toast(t('sidebar.site.screenshotCopied')))
          }}
        />
        <QuickAction
          icon="search"
          label={t('sidebar.site.find')}
          disabled={!live}
          onClick={() => useUi.setState({ sitePanel: null, findOpen: true })}
        />
        <QuickAction
          icon={tab?.muted ? 'muted' : 'volume'}
          label={tab?.muted ? t('sidebar.site.unmute') : t('sidebar.site.mute')}
          disabled={!tab}
          active={tab?.muted}
          onClick={() => tab && send('tabs.setMuted', tab.id, !tab.muted)}
        />
      </div>

      <SectionHeader title={t('sidebar.site.extensions')}>
        <button
          onClick={() => {
            close()
            send('tabs.openInternal', 'extensions')
          }}
          className="rounded-[5px] px-1 text-[12px] font-medium text-[var(--text-3)] hover:text-[var(--text-1)]"
        >
          {t('sidebar.site.manage')}
        </button>
      </SectionHeader>
      <div className="grid grid-cols-4 gap-1.5">
        {enabled.map((ext) => {
          const action = ext.hasAction ? state?.actions.find((a) => a.id === ext.id) : undefined
          return (
            <ExtensionTile
              key={ext.id}
              ext={ext}
              tabId={actionTabId}
              icon={action ? <ActionIcon action={action} tabId={actionTabId} size={18} /> : undefined}
            />
          )
        })}
        <button
          title={t('sidebar.site.addExtension')}
          onClick={() => {
            close()
            send('tabs.openInternal', 'extensions')
          }}
          className="grid h-9 place-items-center rounded-[9px] bg-[var(--hover)] text-[var(--ink)] transition-[scale,background-color] duration-150 ease-out hover:bg-[var(--press)] hover:text-[var(--ink-strong)] active:scale-[0.96]"
        >
          <Icon name="plus" size={16} strokeWidth={1.8} />
        </button>
      </div>

      {origin && permissions.length > 0 && (
        <>
          <SectionHeader title={t('sidebar.site.settings')} />
          <div className="flex flex-col">
            {permissions.map((p) => (
              <PermissionRow
                key={p.permission}
                permission={p}
                onChange={(decision) => {
                  send('permissions.set', p.origin, p.permission, decision)
                  setPermissions((list) => list.map((x) => (x.permission === p.permission ? { ...x, decision } : x)))
                }}
              />
            ))}
          </div>
        </>
      )}

      <div className="mx-1 mt-2 border-t border-[var(--line)] pt-2">
        <div className="flex items-center gap-2">
          {web && level !== 'internal' ? (
            <span
              className={`flex h-7 items-center gap-1.5 rounded-[8px] bg-[var(--hover)] pl-2 pr-2.5 text-[12px] font-medium ${
                certError ? 'text-[var(--danger)]' : 'text-[var(--text-2)]'
              }`}
            >
              <Icon name={level === 'secure' && !certError ? 'lock' : 'warning'} size={13} strokeWidth={1.8} />
              {certError ? t('sidebar.site.certError') : level === 'secure' ? t('sidebar.site.secure') : t('sidebar.site.insecure')}
            </span>
          ) : (
            <span className="h-7" />
          )}
          <div className="flex-1" />
          <button
            title={t('sidebar.site.more')}
            disabled={!tab}
            onClick={(e) => {
              const r = toWindow(e.currentTarget.getBoundingClientRect())
              close()
              if (tab) send('tabs.siteMenu', tab.id, { x: r.left, y: r.bottom + 4 })
            }}
            className="grid h-7 w-7 place-items-center rounded-full bg-[var(--hover)] text-[var(--ink)] transition-[scale,background-color] duration-150 ease-out hover:bg-[var(--press)] hover:text-[var(--ink-strong)] active:scale-[0.94] disabled:opacity-40"
          >
            <Icon name="more" size={16} strokeWidth={2.6} />
          </button>
        </div>
      </div>
    </>
  )
}

function SectionHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-1.5 mt-3 flex items-center justify-between px-1">
      <h3 className="text-[12px] font-semibold text-[var(--text-2)]">{title}</h3>
      {children}
    </div>
  )
}

function QuickAction({
  icon,
  label,
  onClick,
  disabled,
  active
}: {
  icon: IconName
  label: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`grid h-10 place-items-center rounded-[10px] transition-[scale,background-color] duration-150 ease-out enabled:active:scale-[0.96] disabled:opacity-40 ${
        active
          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'bg-[var(--hover)] text-[var(--ink-strong)] enabled:hover:bg-[var(--press)]'
      }`}
    >
      <Icon name={icon} size={18} />
    </button>
  )
}

/**
 * One extension. A click runs its action (popup or side panel window), or
 * opens its options when it has no action. Actions can be pinned to the
 * address pill: the corner badge says so, and on hover it toggles (top
 * right, clear of the action's own badge text).
 */
function ExtensionTile({ ext, icon, tabId }: { ext: ExtensionInfo; icon: React.ReactNode; tabId: number }) {
  const t = useT()
  const toWindow = useToWindow()
  const run = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = toWindow(e.currentTarget.getBoundingClientRect())
    close()
    if (ext.hasAction) activateAction(ext.id, tabId, r, e.type, false)
    else if (ext.optionsUrl) send('extensions.openOptions', ext.id)
    else send('tabs.openInternal', 'extensions')
  }
  return (
    <div className="group/tile relative">
      <button
        title={ext.name}
        onClick={run}
        onContextMenu={(e) => {
          e.preventDefault()
          const r = toWindow(new DOMRect(e.clientX, e.clientY))
          close()
          send('extensions.contextMenu', ext.id, { x: r.x, y: r.y })
        }}
        className="grid h-9 w-full place-items-center rounded-[9px] bg-[var(--hover)] transition-[scale,background-color] duration-150 ease-out hover:bg-[var(--press)] active:scale-[0.96]"
      >
        {icon ??
          (ext.icon ? (
            <img src={ext.icon} width={18} height={18} alt="" draggable={false} />
          ) : (
            <Icon name="puzzle" size={18} className="text-[var(--ink)]" />
          ))}
      </button>
      {ext.hasAction && (
        <button
          title={ext.pinned ? t('sidebar.site.unpin') : t('sidebar.site.pin')}
          aria-pressed={ext.pinned}
          onClick={() => send('extensions.setPinned', ext.id, !ext.pinned)}
          className={`absolute -right-1 -top-1 grid h-[18px] w-[18px] place-items-center rounded-full shadow-[0_0_0_2px_var(--popover)] transition-opacity duration-150 ${
            ext.pinned
              ? 'bg-[var(--ink-strong)] text-[var(--popover)]'
              : 'bg-[var(--surface-3)] text-[var(--ink)] opacity-0 hover:text-[var(--ink-strong)] focus-visible:opacity-100 group-hover/tile:opacity-100'
          }`}
        >
          <Icon name="pin" size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

function PermissionRow({ permission, onChange }: { permission: SitePermission; onChange: (d: PermissionDecision) => void }) {
  const t = useT()
  const meta = PERMISSIONS[permission.permission]
  const allowed = permission.decision === 'allow'
  return (
    <button
      onClick={() => onChange(allowed ? 'deny' : 'allow')}
      className="flex h-11 items-center gap-2.5 rounded-[9px] px-1.5 text-left hover:bg-[var(--hover)] active:bg-[var(--press)]"
    >
      <span
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${
          allowed ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--hover)] text-[var(--ink)]'
        }`}
      >
        <Icon name={meta?.icon ?? 'shield'} size={15} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] text-[var(--text-1)]">
          {meta ? t(meta.label) : permission.permission}
        </span>
        <span className="text-[12px] leading-[15px] text-[var(--text-3)]">
          {allowed ? t('settings.permissions.allowed') : t('settings.permissions.blocked')}
        </span>
      </span>
    </button>
  )
}
