import { displayHost, isInternalUrl, securityLevel } from '@shared/url'
import { Icon, type IconName } from '../../components/Icon'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import { toast, useUi } from '../../stores/ui'
import { PinnedActions } from '../extensions/ExtensionActions'
import { pressSitePanelButton, toggleSitePanel } from './SitePanel'

/**
 * Address pill: the page's host (click to edit), then pinned extensions,
 * copy URL and the site controls button, which opens the site panel
 * (quick actions, every extension, site settings).
 */
export function AddressPill() {
  const t = useT()
  const locale = useLocale()
  const tab = useBrowser(selectActiveTab)
  const panelOpen = useUi((s) => s.sitePanel !== null)
  const level = tab ? securityLevel(tab.url) : 'internal'
  const certError = tab?.error?.kind === 'certificate'
  const zoom = tab?.zoomFactor ?? 1
  const zoomed = Math.abs(zoom - 1) > 0.001
  const copyable = tab !== undefined && !isInternalUrl(tab.url)
  return (
    <div className="flex h-[34px] items-center rounded-[10px] bg-[var(--sb-field)] pr-1 has-[>button:first-child:hover]:bg-[var(--sb-field-hover)]">
      <button
        onClick={() => useUi.setState({ palette: tab ? 'edit-url' : 'new-tab' })}
        title={tab ? tab.url : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[10px] pl-2.5 pr-1.5 text-left"
      >
        {certError || level === 'insecure' ? (
          <Icon
            name="warning"
            size={13}
            strokeWidth={1.8}
            className={certError ? 'text-[var(--danger)]' : 'text-[var(--ink)]'}
          />
        ) : level === 'secure' ? (
          <Icon name="lock" size={13} strokeWidth={1.8} className="text-[var(--ink)]" />
        ) : (
          <Icon name="search" size={13} strokeWidth={1.8} className="text-[var(--ink)]" />
        )}
        <span className={`min-w-0 flex-1 truncate ${tab ? 'text-[var(--text-2)]' : 'text-[var(--text-3)]'}`}>
          {tab ? displayHost(tab.url, locale) || t('tab.newTabTitle') : t('sidebar.address.placeholder')}
        </span>
        {zoomed && (
          <span
            role="button"
            title={t('sidebar.address.resetZoom')}
            onClick={(e) => {
              e.stopPropagation()
              if (tab) send('zoom.adjust', tab.id, 0)
            }}
            className="rounded-[5px] bg-[var(--hover)] px-1.5 py-px text-[11px] font-medium tabular-nums text-[var(--text-2)] hover:bg-[var(--press)]"
          >
            {Math.round(zoom * 100)}%
          </span>
        )}
      </button>
      <PinnedActions />
      {copyable && (
        <PillButton
          icon="link"
          title={t('sidebar.address.copyUrl')}
          onClick={() => {
            send('tabs.copyUrl', tab.id)
            toast(t('toast.urlCopied'))
          }}
        />
      )}
      <PillButton
        icon="sliders"
        title={t('sidebar.address.siteControls')}
        pressed={panelOpen}
        onPointerDown={pressSitePanelButton}
        onClick={(e) => toggleSitePanel(e.currentTarget)}
      />
    </div>
  )
}

function PillButton({
  icon,
  title,
  onClick,
  onPointerDown,
  pressed
}: {
  icon: IconName
  title: string
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  onPointerDown?: () => void
  pressed?: boolean
}) {
  return (
    <button
      title={title}
      aria-pressed={pressed}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] hover:text-[var(--ink-strong)] active:bg-[var(--sb-press)] ${
        pressed ? 'bg-[var(--sb-active)] text-[var(--ink-strong)]' : 'text-[var(--ink)] hover:bg-[var(--sb-hover)]'
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
  )
}
