import { Fragment, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { TabState } from '@shared/types'
import { displayHost } from '@shared/url'
import { Icon, type IconName } from '../../components/Icon'
import { SpaceIcon } from '../../components/SpaceIcon'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useUi } from '../../stores/ui'

/**
 * Fill `{name}` placeholders with React nodes (e.g. a bold host name).
 * Text around the slots is kept as plain strings.
 */
function fill(text: string, slots: Record<string, React.ReactNode>): React.ReactNode {
  return text.split(/\{(\w+)\}/g).map((part, i) =>
    i % 2 === 1 ? <Fragment key={i}>{part in slots ? slots[part] : `{${part}}`}</Fragment> : part || null
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="scroll-y flex h-full p-8">
      <div className="m-auto flex w-full max-w-[440px] flex-col items-start gap-3 pb-[6vh]">{children}</div>
    </div>
  )
}

function Badge({ icon, danger }: { icon: IconName; danger?: boolean }) {
  return (
    <span
      className={`mb-1 grid h-12 w-12 place-items-center rounded-[14px] ${
        danger ? 'bg-[var(--danger-soft)] text-[var(--danger)]' : 'bg-[var(--surface-2)] text-[var(--ink)] shadow-[var(--card-shadow)]'
      }`}
    >
      <Icon name={icon} size={24} strokeWidth={1.5} />
    </span>
  )
}

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="text-[19px] font-semibold leading-tight tracking-[-0.01em]">{children}</h1>
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="leading-relaxed text-[var(--text-2)]">{children}</p>
}

function Detail({ children }: { children: React.ReactNode }) {
  return (
    <code className="max-w-full break-all rounded-[6px] bg-[var(--surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--text-3)]">
      {children}
    </code>
  )
}

function Button({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`h-[30px] rounded-[8px] px-3.5 font-medium ${
        primary
          ? 'bg-[var(--accent-fill)] text-white hover:brightness-110 active:brightness-95'
          : 'text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)] active:bg-[var(--press)]'
      }`}
    >
      {children}
    </button>
  )
}

export function EmptyState({ spaceName, spaceIcon }: { spaceName: string; spaceIcon?: string }) {
  const t = useT()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 pb-[6vh] text-[var(--text-3)]">
      {spaceIcon && <SpaceIcon icon={spaceIcon} size={34} className="mb-1 text-[var(--ink-faint)]" />}
      <div className="text-[15px] font-medium text-[var(--text-2)]">
        {t('status.empty.title', { space: spaceName || t('status.empty.fallbackSpace') })}
      </div>
      <button
        onClick={() => useUi.setState({ palette: 'new-tab' })}
        className="flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
      >
        {fill(t('status.empty.newTab'), {
          keys: (
            <span className="flex gap-0.5">
              <kbd className="kbd font-sans">⌘</kbd>
              <kbd className="kbd font-sans">T</kbd>
            </span>
          )
        })}
      </button>
    </div>
  )
}

export function CrashPage({ tab }: { tab: TabState }) {
  const t = useT()
  const locale = useLocale()
  return (
    <Shell>
      <Badge icon="crash" />
      <Title>{t('status.crash.title')}</Title>
      <Body>{t('status.crash.body', { host: displayHost(tab.url, locale) })}</Body>
      <div className="mt-2">
        <Button primary onClick={() => send('tabs.reload', tab.id, false)}>
          {t('common.reload')}
        </Button>
      </div>
    </Shell>
  )
}

export function ErrorPage({ tab }: { tab: TabState }) {
  const t = useT()
  const locale = useLocale()
  const error = tab.error!
  const [advanced, setAdvanced] = useState(false)
  const host = displayHost(error.url || tab.url, locale)
  const bold = <b className="font-semibold text-[var(--text)]">{host}</b>
  if (error.kind === 'certificate') {
    return (
      <Shell>
        <Badge icon="warning" danger />
        <Title>{t('status.cert.title')}</Title>
        <Body>{fill(t('status.cert.body'), { host: bold })}</Body>
        <Detail>
          {error.description} ({error.code})
        </Detail>
        <div className="mt-2 flex gap-1.5">
          <Button primary onClick={() => (tab.canGoBack ? send('tabs.goBack', tab.id) : send('tabs.close', tab.id))}>
            {t('status.cert.back')}
          </Button>
          <Button onClick={() => setAdvanced((v) => !v)}>
            {advanced ? t('status.cert.hideAdvanced') : t('status.cert.advanced')}
          </Button>
        </div>
        {advanced && (
          <div className="anim-fade mt-1 rounded-[10px] bg-[var(--surface-2)] p-3.5 text-[12px] leading-relaxed text-[var(--text-2)] shadow-[var(--card-shadow)]">
            {t('status.cert.advancedBody', { host })}
            <button
              className="mt-2 block font-medium text-[var(--danger)] underline underline-offset-2"
              onClick={() => send('tabs.allowCertificate', tab.id)}
            >
              {t('status.cert.proceed', { host })}
            </button>
          </div>
        )}
      </Shell>
    )
  }
  return (
    <Shell>
      <Badge icon="offline" />
      <Title>{t('status.net.title')}</Title>
      <Body>{fill(t(netErrorKey(error.code)), { host: bold })}</Body>
      <Detail>{error.description}</Detail>
      <div className="mt-2">
        <Button primary onClick={() => send('tabs.reload', tab.id, false)}>
          {t('common.reload')}
        </Button>
      </div>
    </Shell>
  )
}

/** Message for a Chromium net error code; `{host}` marks the bold host name. */
function netErrorKey(code: number): MessageKey {
  switch (code) {
    case -105:
    case -137:
      return 'status.net.nameNotResolved'
    case -106:
      return 'status.net.offline'
    case -102:
      return 'status.net.refused'
    case -118:
    case -7:
      return 'status.net.timedOut'
    case -100:
    case -101:
      return 'status.net.closed'
    case -20:
      return 'status.net.blocked'
    case -21:
      return 'status.net.changed'
    case -300:
      return 'status.net.invalidUrl'
    default:
      return 'status.net.generic'
  }
}
