import { useEffect, useState } from 'react'
import type { AgentInfo, AgentSnippet } from '@shared/agent'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { Row, Section, SmallButton, Toggle } from './PageLayout'

/** While the page is open, refresh the server state this often (connected clients). */
const REFRESH_MS = 5000

/**
 * Settings → Agents: the switch for the MCP endpoint and what an agent needs
 * to connect. The token never leaves main except here and onto the clipboard.
 */
export function AgentSettings() {
  const t = useT()
  const enabled = useBrowser((s) => s.settings.agentEnabled)
  const port = useBrowser((s) => s.settings.agentPort)
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const [portText, setPortText] = useState(String(port))
  const [copied, setCopied] = useState<AgentSnippet | null>(null)
  const [now, setNow] = useState(Date.now())

  // Main answers once a start or stop in progress has finished.
  useEffect(() => {
    let live = true
    const load = () =>
      void rpc('agent.info').then((next) => {
        if (!live) return
        setInfo(next)
        setNow(Date.now())
      })
    load()
    const timer = enabled ? setInterval(load, REFRESH_MS) : undefined
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [enabled, port])

  useEffect(() => setPortText(String(port)), [port])

  const copy = (what: AgentSnippet) => {
    send('agent.copy', what)
    setCopied(what)
    setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600)
  }
  const copyButton = (what: AgentSnippet, label: string) => (
    <SmallButton onClick={() => copy(what)}>{copied === what ? t('agent.settings.copied') : label}</SmallButton>
  )
  const savePort = () => {
    const value = Number(portText)
    if (Number.isInteger(value) && value >= 1024 && value <= 65535) send('settings.update', { agentPort: value })
    else setPortText(String(port))
  }

  const status = !info
    ? t('agent.settings.starting')
    : info.running
      ? t('agent.settings.running', { url: info.url })
      : info.error === 'portInUse'
        ? t('agent.settings.portInUse', { port })
        : info.error === 'failed'
          ? t('agent.settings.failed', { port })
          : t('agent.settings.starting')
  const ago = (at: number) => {
    const minutes = Math.floor((now - at) / 60_000)
    return minutes < 1 ? t('agent.settings.justNow') : t('agent.settings.minutesAgo', { count: minutes })
  }

  return (
    <Section title={t('agent.settings.section')} description={t('agent.settings.description')}>
      <Row label={t('agent.settings.enable')} hint={t('agent.settings.enableHint')}>
        <Toggle checked={enabled} onChange={(agentEnabled) => send('settings.update', { agentEnabled })} label={t('agent.settings.enable')} />
      </Row>
      {enabled && (
        <>
          <Row label={t('agent.settings.server')} hint={status}>
            <span className="text-[12px] text-[var(--text-3)]">{t('agent.settings.port')}</span>
            <input
              value={portText}
              inputMode="numeric"
              aria-label={t('agent.settings.port')}
              aria-invalid={info?.error === 'portInUse'}
              onChange={(e) => setPortText(e.target.value.replace(/\D/g, '').slice(0, 5))}
              onBlur={savePort}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              className="field h-[28px] w-[72px] text-right tabular-nums aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger)]"
            />
          </Row>
          <Row label={t('agent.settings.token')} hint={t('agent.settings.tokenHint')}>
            {info && <span className="font-mono text-[12px] tracking-wide text-[var(--text-3)]">{`••••${info.token.slice(-4)}`}</span>}
            {copyButton('token', t('agent.settings.copy'))}
            <SmallButton onClick={() => void rpc('agent.regenerateToken').then(setInfo)}>{t('agent.settings.regenerate')}</SmallButton>
          </Row>
          <Row label={t('agent.settings.claude')} hint={t('agent.settings.claudeHint')}>
            {copyButton('claude', t('agent.settings.copyCommand'))}
          </Row>
          <Row label={t('agent.settings.codex')} hint={t('agent.settings.codexHint')}>
            {copyButton('codex', t('agent.settings.copyConfig'))}
          </Row>
          <Row label={t('agent.settings.json')} hint={t('agent.settings.jsonHint')}>
            {copyButton('json', t('agent.settings.copyConfig'))}
          </Row>
          {info && info.clients.length > 0 && (
            <Row
              label={t('agent.settings.clients')}
              hint={info.clients
                .slice(0, 4)
                .map((c) => `${c.name} · ${ago(c.lastSeen)}`)
                .join(', ')}
            >
              {null}
            </Row>
          )}
        </>
      )}
    </Section>
  )
}
