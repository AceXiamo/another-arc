import { displayHost, isInternalUrl, securityLevel } from '@shared/url'
import { Icon } from '../../components/Icon'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import { toast, useUi } from '../../stores/ui'

export function AddressPill() {
  const t = useT()
  const locale = useLocale()
  const tab = useBrowser(selectActiveTab)
  const level = tab ? securityLevel(tab.url) : 'internal'
  const certError = tab?.error?.kind === 'certificate'
  const zoom = tab?.zoomFactor ?? 1
  const zoomed = Math.abs(zoom - 1) > 0.001
  const copyable = tab !== undefined && !isInternalUrl(tab.url)
  return (
    <div className="group relative">
      <button
        onClick={() => useUi.setState({ palette: tab ? 'edit-url' : 'new-tab' })}
        title={tab ? tab.url : undefined}
        className="flex h-[34px] w-full items-center gap-2 rounded-[10px] bg-[var(--sb-field)] pl-2.5 pr-2 text-left hover:bg-[var(--sb-field-hover)]"
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
        <span
          className={`min-w-0 flex-1 truncate ${tab ? 'text-[var(--text-2)]' : 'text-[var(--text-3)]'} ${
            copyable && !zoomed ? 'group-hover:pr-6' : ''
          }`}
        >
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
            className={`rounded-[5px] bg-[var(--hover)] px-1.5 py-px text-[11px] font-medium tabular-nums text-[var(--text-2)] hover:bg-[var(--press)] ${
              copyable ? 'group-hover:mr-6' : ''
            }`}
          >
            {Math.round(zoom * 100)}%
          </span>
        )}
      </button>
      {copyable && (
        <button
          title={t('sidebar.address.copyUrl')}
          onClick={() => {
            send('tabs.copyUrl', tab.id)
            toast(t('toast.urlCopied'))
          }}
          className="absolute right-1 top-1 hidden h-[26px] w-[26px] place-items-center rounded-[7px] text-[var(--ink)] hover:bg-[var(--sb-hover)] hover:text-[var(--ink-strong)] group-hover:grid"
        >
          <Icon name="copy" size={14} />
        </button>
      )}
    </div>
  )
}
