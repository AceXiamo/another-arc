import { Icon, type IconName } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { titleBar } from '../../lib/title-bar'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'

export function IconButton({
  icon,
  title,
  onClick,
  disabled,
  size = 16
}: {
  icon: IconName
  title: string
  onClick: () => void
  disabled?: boolean
  size?: number
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--ink)] hover:bg-[var(--sb-hover)] hover:text-[var(--ink-strong)] active:bg-[var(--sb-press)] disabled:text-[var(--ink-faint)] disabled:hover:bg-transparent"
    >
      <Icon name={icon} size={size} />
    </button>
  )
}

/** Title bar row: traffic lights live on the left, navigation on the right. */
export function SidebarHeader() {
  const t = useT()
  const fullscreen = useBrowser((s) => s.window.fullscreen)
  const collapsed = useBrowser((s) => s.window.sidebarCollapsed)
  const tab = useBrowser(selectActiveTab)
  const live = tab?.live ?? false
  return (
    <div
      {...titleBar}
      className="drag flex h-[44px] shrink-0 items-center gap-0.5 pr-2"
      style={{ paddingLeft: fullscreen ? 8 : 78 }}
    >
      <IconButton
        icon="sidebar"
        title={t('sidebar.header.toggleSidebar')}
        onClick={() => {
          useUi.setState({ peek: false })
          send('window.setSidebar', { collapsed: !collapsed })
        }}
      />
      <div className="flex-1" />
      <IconButton icon="back" title={t('sidebar.header.back')} disabled={!tab?.canGoBack} onClick={() => tab && send('tabs.goBack', tab.id)} />
      <IconButton
        icon="forward"
        title={t('sidebar.header.forward')}
        disabled={!tab?.canGoForward}
        onClick={() => tab && send('tabs.goForward', tab.id)}
      />
      {tab?.loading ? (
        <IconButton icon="stop" title={t('sidebar.header.stop')} onClick={() => send('tabs.stop', tab.id)} />
      ) : (
        <IconButton
          icon="reload"
          title={t('sidebar.header.reload')}
          disabled={!tab || (!live && !tab.url.startsWith('http'))}
          onClick={() => tab && send('tabs.reload', tab.id, false)}
          size={15}
        />
      )}
    </div>
  )
}
