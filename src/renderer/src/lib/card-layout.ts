import { LAYOUT, type DockSide } from '@shared/layout'

// The page card's parts in window coordinates, as CSS insets from the window's
// edges. Main positions the views with `splitCard` (src/shared/layout.ts); this
// is the same arithmetic in CSS, on the same integers, so the shell's holes
// and the views line up to the pixel and follow window resizes in the same
// frame, with no measuring. `100%` is the window: every user of these insets
// (ContentArea, the backdrop's clip path, the splitter) spans the whole window.

export interface Insets {
  left: string
  top: string
  right: string
  bottom: string
}

export interface CardParts {
  page: Insets
  devtools: Insets | null
  /** The gap between the page and docked DevTools, which is the resize handle. */
  splitter: Insets | null
}

const g = LAYOUT.gutter

/** Docked DevTools' size along the split (devtoolsExtent in main). */
function extent(cardLength: string, sizeVar: '--devtools-width' | '--devtools-height'): string {
  return `max(${LAYOUT.devtoolsMin}px, min(var(${sizeVar}), ${cardLength} - ${LAYOUT.devtoolsPageMin + g}px))`
}

/** `left` is the card's left edge (after the sidebar); `side` where DevTools dock, if they show. */
export function cardParts(left: string, side: DockSide | null): CardParts {
  const card: Insets = { left, top: `${g}px`, right: `${g}px`, bottom: `${g}px` }
  if (!side) return { page: card, devtools: null, splitter: null }
  if (side === 'bottom') {
    const h = extent(`(100% - ${2 * g}px)`, '--devtools-height')
    return {
      page: { ...card, bottom: `calc(${2 * g}px + ${h})` },
      devtools: { ...card, top: `calc(100% - ${g}px - ${h})` },
      splitter: { ...card, top: `calc(100% - ${2 * g}px - ${h})`, bottom: `calc(${g}px + ${h})` }
    }
  }
  const w = extent(`(100% - ${left} - ${g}px)`, '--devtools-width')
  if (side === 'right') {
    return {
      page: { ...card, right: `calc(${2 * g}px + ${w})` },
      devtools: { ...card, left: `calc(100% - ${g}px - ${w})` },
      splitter: { ...card, left: `calc(100% - ${2 * g}px - ${w})`, right: `calc(${g}px + ${w})` }
    }
  }
  return {
    page: { ...card, left: `calc(${left} + ${w} + ${g}px)` },
    devtools: { ...card, right: `calc(100% - ${left} - ${w})` },
    splitter: { ...card, left: `calc(${left} + ${w})`, right: `calc(100% - ${left} - ${w} - ${g}px)` }
  }
}

/**
 * The hole for a view: 1px inside its bounds on every side, so the view's
 * antialiased rounded edge is what shows, never a sliver of the hole.
 */
export function holeOf(i: Insets): Insets {
  return {
    left: `calc(${i.left} + 1px)`,
    top: `calc(${i.top} + 1px)`,
    right: `calc(${i.right} + 1px)`,
    bottom: `calc(${i.bottom} + 1px)`
  }
}
