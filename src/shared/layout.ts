// Window geometry shared by the main process (which positions the page view)
// and the shell (which draws the chrome around it). Computing the page bounds
// in main from the same constants means window resizes never wait on a
// renderer round-trip, so the page and the sidebar stay in lockstep.

export const LAYOUT = {
  /** Gap between the page card and the window edges. */
  gutter: 8,
  /** Corner radius of the page card. */
  radius: 10,
  sidebarMin: 200,
  sidebarMax: 480,
  sidebarDefault: 260,
  /** Height reserved for the traffic lights at the top of the sidebar. */
  titlebarHeight: 44,
  /**
   * Origin of the macOS window buttons. Their 12pt dots sit ~7.6pt below this
   * y, so y = 14 centres them on the 44pt title row (centre 22) and in line
   * with the sidebar header buttons.
   */
  trafficLights: { x: 16, y: 14 }
} as const

export interface Size {
  width: number
  height: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutInput {
  sidebarWidth: number
  sidebarCollapsed: boolean
  htmlFullscreen: boolean
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return LAYOUT.sidebarDefault
  return Math.round(Math.min(LAYOUT.sidebarMax, Math.max(LAYOUT.sidebarMin, width)))
}

/** Bounds of the page card inside the window content area. */
export function pageBounds(win: Size, input: LayoutInput): Rect {
  if (input.htmlFullscreen) return { x: 0, y: 0, width: win.width, height: win.height }
  const left = input.sidebarCollapsed ? LAYOUT.gutter : clampSidebarWidth(input.sidebarWidth)
  return {
    x: left,
    y: LAYOUT.gutter,
    width: Math.max(0, win.width - left - LAYOUT.gutter),
    height: Math.max(0, win.height - LAYOUT.gutter * 2)
  }
}

export function pageRadius(input: LayoutInput): number {
  return input.htmlFullscreen ? 0 : LAYOUT.radius
}

/**
 * Small non-modal UI drawn above the page (find bar). Each surface is a
 * child window of the shell rendered by the shell's own JS, so it shares
 * the shell's renderer process and costs no extra memory.
 */
export const SURFACES = {
  find: { width: 400, height: 72, margin: 4 }
} as const

export type SurfaceId = keyof typeof SURFACES

export function surfaceBounds(id: SurfaceId, card: Rect): Rect {
  const s = SURFACES[id]
  return {
    x: Math.max(card.x, card.x + card.width - s.width - s.margin),
    y: card.y + s.margin,
    width: Math.min(s.width, card.width),
    height: s.height
  }
}

/** window.open() frame name prefix used by the shell to create a surface. */
export const SURFACE_FRAME_PREFIX = 'arc-surface:'
