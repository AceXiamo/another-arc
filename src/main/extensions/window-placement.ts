// Where extension windows open. Pure geometry so it can be unit-tested; all
// rectangles are in screen coordinates (points).

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** Gap between the toolbar button and the window, and from the browser window's edge. */
export const ANCHOR_GAP = 6
export const EDGE_INSET = 12

/**
 * Top-left corner for an extension window of `size` (frame included):
 * the remembered position if there is one, else just below the toolbar
 * button that opened it, else the browser window's top-right corner (where
 * Chrome shows side panels). The result always lies fully inside `workArea`
 * when the window fits in it.
 */
export function placeWindow(
  size: { width: number; height: number },
  opts: { saved?: Point | null; anchor?: Rect | null; parent?: Rect | null; workArea: Rect }
): Point {
  let x: number
  let y: number
  if (opts.saved) {
    ;({ x, y } = opts.saved)
  } else if (opts.anchor) {
    x = opts.anchor.x
    y = opts.anchor.y + opts.anchor.height + ANCHOR_GAP
  } else if (opts.parent) {
    x = opts.parent.x + opts.parent.width - size.width - EDGE_INSET
    y = opts.parent.y + EDGE_INSET * 4
  } else {
    x = opts.workArea.x + (opts.workArea.width - size.width) / 2
    y = opts.workArea.y + (opts.workArea.height - size.height) / 3
  }
  return clampToArea({ x, y, width: size.width, height: size.height }, opts.workArea)
}

/** Move `rect` (without resizing it) so it lies inside `area`; oversized windows align to its top-left. */
export function clampToArea(rect: Rect, area: Rect): Point {
  const maxX = area.x + area.width - rect.width
  const maxY = area.y + area.height - rect.height
  return {
    x: Math.round(Math.max(area.x, Math.min(rect.x, maxX))),
    y: Math.round(Math.max(area.y, Math.min(rect.y, maxY)))
  }
}
