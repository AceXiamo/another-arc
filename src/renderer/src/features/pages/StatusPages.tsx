import { Fragment, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import type { TabState } from '@shared/types'
import { displayHost } from '@shared/url'
import { Illustration } from '../../components/Illustration'
import { SpaceIcon } from '../../components/SpaceIcon'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
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

/**
 * Centered column: art, then heading, text and actions. It is anchored from
 * the top (about where centered content would start) rather than centered,
 * so revealing "Advanced" grows downward instead of moving the buttons.
 */
function Shell({ art, children }: { art: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="scroll-y h-full px-8 pb-10 pt-[max(2rem,calc(46vh-160px))]">
      <div className="anim-fade mx-auto flex w-full max-w-[420px] flex-col items-center text-center">
        {art}
        {children}
      </div>
    </div>
  )
}

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="mt-6 text-balance text-[19px] font-semibold leading-tight tracking-[-0.01em]">{children}</h1>
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-balance leading-relaxed text-[var(--text-2)]">{children}</p>
}

function Detail({ children }: { children: React.ReactNode }) {
  return (
    <code className="mt-3 max-w-full break-all rounded-[6px] bg-[var(--surface-2)] px-2 py-1 font-mono text-[11px] text-[var(--text-3)] shadow-[var(--card-shadow)]">
      {children}
    </code>
  )
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-center gap-2">{children}</div>
}

function Button({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`h-8 rounded-[9px] px-4 font-medium transition-[scale,filter,background-color] duration-150 ease-out active:scale-[0.96] ${
        primary
          ? 'bg-[var(--accent-fill)] text-white hover:brightness-110 active:brightness-95'
          : 'bg-[var(--surface-2)] text-[var(--text-1)] shadow-[var(--card-shadow)] hover:bg-[var(--surface-3)] active:bg-[var(--press)]'
      }`}
    >
      {children}
    </button>
  )
}

export function EmptyState({ spaceName, spaceIcon }: { spaceName: string; spaceIcon?: string }) {
  const t = useT()
  // A space full of favorites and pinned tabs is not empty; it just has nothing open.
  const hasBookmarks = useBrowser((s) => {
    const space = s.spaces[s.window.activeSpaceId]
    return !!space && space.pinnedTabIds.length + space.savedIds.length > 0
  })
  return (
    <div className="flex h-full flex-col items-center justify-center pb-[6vh] text-center">
      <Illustration name="no-tabs" className="anim-fade">
        {/* The space's own glyph sits in the empty window (body center: 64, 59.5). */}
        {spaceIcon && (
          <SpaceIcon
            icon={spaceIcon}
            size={26}
            className="absolute left-[64px] top-[59.5px] -translate-x-1/2 -translate-y-1/2 text-[color-mix(in_oklab,var(--art-line)_70%,transparent)]"
          />
        )}
      </Illustration>
      <div className="mt-6 text-balance text-[15px] font-medium text-[var(--text-1)]">
        {hasBookmarks
          ? t('status.empty.nothingOpen')
          : t('status.empty.title', { space: spaceName || t('status.empty.fallbackSpace') })}
      </div>
      <button
        onClick={() => useUi.setState({ palette: 'new-tab' })}
        className="mt-2 flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-[var(--text-3)] transition-[scale,background-color] duration-150 ease-out hover:bg-[var(--hover)] hover:text-[var(--text-2)] active:scale-[0.96] active:bg-[var(--press)]"
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
    <Shell art={<Illustration name="crash" />}>
      <Title>{t('status.crash.title')}</Title>
      <Body>{t('status.crash.body', { host: displayHost(tab.url, locale) })}</Body>
      <Actions>
        <Button primary onClick={() => send('tabs.reload', tab.id, false)}>
          {t('common.reload')}
        </Button>
      </Actions>
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
      <Shell art={<Illustration name="certificate" tone="danger" />}>
        <Title>{t('status.cert.title')}</Title>
        <Body>{fill(t('status.cert.body'), { host: bold })}</Body>
        <Detail>
          {error.description} ({error.code})
        </Detail>
        <Actions>
          <Button primary onClick={() => (tab.canGoBack ? send('tabs.goBack', tab.id) : send('tabs.close', tab.id))}>
            {t('status.cert.back')}
          </Button>
          <Button onClick={() => setAdvanced((v) => !v)}>
            {advanced ? t('status.cert.hideAdvanced') : t('status.cert.advanced')}
          </Button>
        </Actions>
        {advanced && (
          <div className="anim-fade mt-4 w-full rounded-[12px] bg-[var(--surface-2)] p-4 text-left text-[12px] leading-relaxed text-[var(--text-2)] shadow-[var(--card-shadow)]">
            <p className="text-pretty">{t('status.cert.advancedBody', { host })}</p>
            <button
              className="-mx-1 mt-2 rounded-[6px] px-1 py-0.5 text-left font-medium text-[var(--danger)] underline decoration-[color-mix(in_oklab,var(--danger)_40%,transparent)] underline-offset-2 hover:bg-[var(--danger-soft)] hover:decoration-current"
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
    <Shell art={<Illustration name="offline" className="my-[28px]" />}>
      <Title>{t('status.net.title')}</Title>
      <Body>{fill(t(netErrorKey(error.code)), { host: bold })}</Body>
      <Detail>{error.description}</Detail>
      <Actions>
        <Button primary onClick={() => send('tabs.reload', tab.id, false)}>
          {t('common.reload')}
        </Button>
        {tab.canGoBack && <Button onClick={() => send('tabs.goBack', tab.id)}>{t('status.net.back')}</Button>}
      </Actions>
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
