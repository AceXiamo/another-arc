import { useT } from '../../lib/i18n'

/** Marks a tab in the sidebar while an agent works in it. */
export function AgentDot() {
  const t = useT()
  return <span className="agent-dot" title={t('agent.tab.working')} />
}
