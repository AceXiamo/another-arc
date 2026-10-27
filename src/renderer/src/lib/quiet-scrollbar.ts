// The other half of `.scroll-y-quiet`: marks a scroll container while it is
// moving (`data-scrolling`) and while the pointer is at the scrollbar's edge
// (`data-scroll-edge`), which is when the stylesheet shows the thumb.
//
// Plain DOM listeners writing data attributes: nothing here re-renders React,
// and the pointer listener only runs while the pointer is over the list.

/** How long the thumb stays once the list stops moving. */
const LINGER_MS = 900
/**
 * A pointer this close to the right edge shows the thumb, so it can be
 * grabbed: wider than the 11px gutter, so it shows on the way there.
 */
const EDGE_PX = 20

/**
 * Use as a ref: `<div ref={quietScrollbar} className="scroll-y-quiet">`.
 * React calls the returned cleanup when the element goes away.
 */
export function quietScrollbar(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined
  let timer = 0
  let edgeTimer = 0

  const onScroll = () => {
    el.dataset.scrolling = ''
    clearTimeout(timer)
    timer = window.setTimeout(() => delete el.dataset.scrolling, LINGER_MS)
  }

  const nearEdge = (event: PointerEvent) => el.getBoundingClientRect().right - event.clientX <= EDGE_PX

  const onMove = (event: PointerEvent) => {
    clearTimeout(edgeTimer)
    // Nothing to grab when the list fits.
    const near = el.scrollHeight > el.clientHeight && nearEdge(event)
    if (near === 'scrollEdge' in el.dataset) return
    if (near) el.dataset.scrollEdge = ''
    else delete el.dataset.scrollEdge
  }

  // The sidebar's resize handle lies over the outer 5px of the gutter, so
  // overshooting the thumb by a little leaves the list. Leaving that way, the
  // thumb lingers as it does after a scroll instead of vanishing under the
  // pointer.
  const onLeave = (event: PointerEvent) => {
    clearTimeout(edgeTimer)
    if (nearEdge(event)) edgeTimer = window.setTimeout(() => delete el.dataset.scrollEdge, LINGER_MS)
    else delete el.dataset.scrollEdge
  }

  el.addEventListener('scroll', onScroll, { passive: true })
  el.addEventListener('pointermove', onMove, { passive: true })
  el.addEventListener('pointerleave', onLeave)
  return () => {
    clearTimeout(timer)
    clearTimeout(edgeTimer)
    el.removeEventListener('scroll', onScroll)
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerleave', onLeave)
    delete el.dataset.scrolling
    delete el.dataset.scrollEdge
  }
}
