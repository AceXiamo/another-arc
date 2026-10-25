import { memo, type CSSProperties } from 'react'
import { LAYOUT } from '@shared/layout'

/**
 * The window chrome behind the sidebar and around the page card: the space's
 * tint, gradient and grain (see .chrome-backdrop in styles.css). It has a
 * hole with exactly the card's geometry (ContentArea: left + 1px, gutter + 1px
 * from the other edges, radius − 1), so the page shows through whenever the
 * shell is raised above it. Everything it paints comes from CSS variables;
 * switching spaces never re-renders it.
 */
export const ChromeBackdrop = memo(function ChromeBackdrop({ left }: { left: string }) {
  const style = {
    '--hole-left': `calc(${left} + 1px)`,
    '--hole-inset': `${LAYOUT.gutter + 1}px`,
    '--hole-radius': `${LAYOUT.radius - 1}px`
  } as CSSProperties
  return (
    <div aria-hidden data-chrome-backdrop className="chrome-backdrop" style={style}>
      <div className="chrome-grain" />
    </div>
  )
})
