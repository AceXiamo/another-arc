import { memo, type CSSProperties } from 'react'
import { LAYOUT } from '@shared/layout'
import { holeOf, type CardParts } from '../../lib/card-layout'

/**
 * The window chrome behind the sidebar and around the page card: the space's
 * tint, gradient and grain (see .chrome-backdrop in styles.css). It has a
 * hole with exactly the card's geometry (ContentArea: 1px inside the page
 * view, radius − 1), and a second one for docked DevTools, so the views show
 * through whenever the shell is raised above them. Everything it paints comes
 * from CSS variables; switching spaces never re-renders it.
 */
export const ChromeBackdrop = memo(function ChromeBackdrop({ parts }: { parts: CardParts }) {
  const a = holeOf(parts.page)
  const b = parts.devtools && holeOf(parts.devtools)
  const style = {
    '--al': a.left,
    '--at': a.top,
    '--ar': a.right,
    '--ab': a.bottom,
    ...(b ? { '--bl': b.left, '--bt': b.top, '--br': b.right, '--bb': b.bottom } : {}),
    '--hole-radius': `${LAYOUT.radius - 1}px`
  } as CSSProperties
  return (
    <div aria-hidden data-chrome-backdrop data-split={b ? '' : undefined} className="chrome-backdrop" style={style}>
      <div className="chrome-grain" />
    </div>
  )
})
