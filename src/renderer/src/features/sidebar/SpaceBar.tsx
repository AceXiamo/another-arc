import { memo } from 'react'
import { Icon } from '../../components/Icon'
import { SpaceIcon } from '../../components/SpaceIcon'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { titleBar } from '../../lib/title-bar'
import { useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'
import { IconButton } from './SidebarHeader'

const SpaceButton = memo(function SpaceButton({ id }: { id: string }) {
  const space = useBrowser((s) => s.spaces[id])
  const active = useBrowser((s) => s.window.activeSpaceId === id)
  const dropTarget = useUi((s) => {
    const t = s.drag?.target
    return t?.kind === 'space' && t.spaceId === id
  })
  if (!space) return null
  return (
    <button
      data-space-drop={id}
      title={space.name}
      onClick={() => send('spaces.activate', id)}
      onDoubleClick={() => useUi.setState({ spaceEditor: id })}
      onContextMenu={(e) => {
        e.preventDefault()
        send('spaces.contextMenu', id, { x: e.clientX, y: e.clientY })
      }}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-[7px] transition-transform duration-150 ${
        active
          ? 'text-[color-mix(in_oklch,var(--accent)_88%,transparent)]'
          : 'text-[var(--ink-faint)] hover:bg-[var(--sb-hover)] hover:text-[var(--ink)]'
      } ${dropTarget ? 'scale-[1.2] bg-[var(--sb-active)] text-[var(--accent)]' : ''}`}
    >
      <SpaceIcon icon={space.icon} size={15} />
    </button>
  )
})

function DownloadsButton() {
  const t = useT()
  const active = useBrowser((s) => {
    let n = 0
    for (const d of Object.values(s.downloads)) if (d.status === 'progressing') n++
    return n
  })
  const hasAny = useBrowser((s) => Object.keys(s.downloads).length > 0)
  if (!hasAny) return null
  return (
    <button
      title={t('sidebar.spaceBar.downloads')}
      onClick={() => send('tabs.openInternal', 'downloads')}
      className="relative grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--ink)] hover:bg-[var(--sb-hover)] hover:text-[var(--ink-strong)]"
    >
      <Icon name="download" size={16} />
      {active > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-[var(--accent-fill)] px-[3px] text-[9px] font-semibold leading-none text-white">
          {active}
        </span>
      )}
    </button>
  )
}

export function SpaceBar() {
  const t = useT()
  const order = useBrowser((s) => s.spaceOrder)
  return (
    <div {...titleBar} className="drag flex h-11 shrink-0 items-center gap-0.5 px-2">
      <IconButton icon="settings" title={t('sidebar.spaceBar.settings')} onClick={() => send('tabs.openInternal', 'settings')} />
      <DownloadsButton />
      <div className="no-drag flex min-w-0 flex-1 items-center justify-center gap-0.5 overflow-x-auto">
        {order.map((id) => (
          <SpaceButton key={id} id={id} />
        ))}
      </div>
      <IconButton icon="plus" title={t('sidebar.spaceBar.newSpace')} onClick={() => useUi.setState({ spaceEditor: 'new' })} />
    </div>
  )
}
