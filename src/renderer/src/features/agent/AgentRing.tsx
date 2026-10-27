import { LAYOUT } from '@shared/layout'
import { tabPresentsView } from '@shared/url'
import { useT } from '../../lib/i18n'
import { selectActiveTab, useBrowser } from '../../stores/browser'

/** The agent's colors; the page runtime (src/preload/agent-runtime.ts) draws with the same ones. */
const SPECTRUM = ['#ff4d8d', '#ff8a3d', '#ffd23f', '#3ddc97', '#2ec5ff', '#4f6bff', '#b259ff', '#ff4d8d']

/**
 * A rainbow frame around the page card while an agent drives the tab on
 * screen, with a glow that breathes in the gutter. Same geometry as the card
 * (ContentArea); the page view covers the inside, and the page draws the
 * same glow inside its own edges, so the light seems to come from the edge.
 */
export function AgentRing({ left }: { left: string }) {
  const active = useBrowser((s) => {
    const tab = selectActiveTab(s)
    return tab?.agent === true && tabPresentsView(tab)
  })
  if (!active) return null
  return (
    <div
      aria-hidden
      className="agent-ring anim-fade pointer-events-none absolute"
      style={
        {
          left,
          top: LAYOUT.gutter,
          right: LAYOUT.gutter,
          bottom: LAYOUT.gutter,
          '--r': `${LAYOUT.radius}px`,
          '--fade': `${LAYOUT.gutter}px`
        } as React.CSSProperties
      }
    >
      <div className="agent-ring-glow">
        <canvas ref={paintRainbow} width={96} height={96} className="agent-rainbow" />
      </div>
      <div className="agent-ring-line">
        <canvas ref={paintRainbow} width={96} height={96} className="agent-rainbow" />
      </div>
    </div>
  )
}

/**
 * A rainbow disc, painted once: CSS scales it up and spins it, so the GPU
 * turns a 96 px texture instead of repainting a window-sized gradient.
 */
function paintRainbow(canvas: HTMLCanvasElement | null): void {
  const ctx = canvas?.getContext('2d')
  if (!ctx) return
  const gradient = ctx.createConicGradient(0, 48, 48)
  SPECTRUM.forEach((color, i) => gradient.addColorStop(i / (SPECTRUM.length - 1), color))
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 96, 96)
}

/** Marks a tab in the sidebar while an agent works in it. */
export function AgentDot() {
  const t = useT()
  return <span className="agent-dot" title={t('agent.tab.working')} />
}
