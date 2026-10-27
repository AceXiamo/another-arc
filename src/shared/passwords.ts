// Saved logins. The password itself never crosses into the shell or into a
// page's own world: main holds it, encrypted, and only ever writes it into
// a field through the page preload.

/** A saved credential, as everything outside main may see it. */
export interface SavedLogin {
  id: string
  /** Origin it belongs to, e.g. `https://example.com`. */
  origin: string
  username: string
  createdAt: number
  lastUsedAt: number
  timesUsed: number
}

/** One row of the autofill dropdown. */
export interface AutofillEntry {
  id: string
  username: string
}

/** A field's position in the page, in CSS pixels from the page's top-left. */
export interface FieldRect {
  x: number
  y: number
  width: number
  height: number
}

/** What the preload reports when a sign-in field takes focus. */
export interface AutofillRequest {
  origin: string
  rect: FieldRect
  /** Already-typed username, so the list can be narrowed to it. */
  typed: string
}

/** A sign-in the preload saw go through. */
export interface SubmittedLogin {
  origin: string
  username: string
  password: string
}

/**
 * Dropdown geometry. Main sizes the surface from these and the shell draws
 * to them, so the two must agree: every pixel the card is shorter than the
 * surface shows up as blank space under the last row.
 */
/** Room for the card's shadow, on every side but the one facing the field. */
export const AUTOFILL_INSET = 6
/** Inside the card, around the rows. */
export const AUTOFILL_PADDING = 4
/** A login: username over a masked password. */
export const AUTOFILL_ROW_HEIGHT = 40
/** The rule (1px, 4px either side) and the "Saved passwords…" row (28px). */
export const AUTOFILL_FOOTER_HEIGHT = 37
/** The width follows the field, within these bounds. */
export const AUTOFILL_MIN_WIDTH = 240
export const AUTOFILL_MAX_WIDTH = 360
/** More than this and the list scrolls. */
export const AUTOFILL_MAX_ROWS = 4

/** Height of the card itself for `count` logins. */
export function autofillCardHeight(count: number): number {
  return AUTOFILL_PADDING * 2 + Math.min(count, AUTOFILL_MAX_ROWS) * AUTOFILL_ROW_HEIGHT + AUTOFILL_FOOTER_HEIGHT
}

/**
 * Channels between a page's preload and main. Separate from the shell's
 * three channels: these carry a page's own reports, so main checks the
 * sender on every one.
 */
export const PASSWORD_IPC = {
  /** preload → main: the user went into a sign-in field, offer what we have. */
  focus: 'arc:pw:focus',
  /** preload → main: the field lost focus (`BlurInfo` says how). */
  blur: 'arc:pw:blur',
  /** preload → main: the field moved (scroll, resize); a new `FieldRect`. */
  move: 'arc:pw:move',
  /** preload → main: a key meant for the dropdown (`AutofillKey`). */
  key: 'arc:pw:key',
  /** preload → main: a sign-in went through, offer to save it. */
  submitted: 'arc:pw:submitted',
  /** main → preload: put this credential into the form. */
  fill: 'arc:pw:fill',
  /** main → preload: whether the dropdown is open, and which row is picked. */
  state: 'arc:pw:state'
} as const

export interface BlurInfo {
  /**
   * Focus left the page altogether rather than moving inside it: most often
   * a click on the dropdown itself, also the sidebar or another app.
   */
  left: boolean
}

export type AutofillKey = 'up' | 'down' | 'enter'

export interface AutofillState {
  open: boolean
  /** Row picked with the arrow keys; -1 when none is. */
  active: number
}

/** "example.com" for https://www.example.com; other schemes keep theirs. How saved logins are listed. */
export function siteOf(origin: string): string {
  try {
    const url = new URL(origin)
    const host = url.host.replace(/^www\./, '')
    return url.protocol === 'https:' ? host : `${url.protocol}//${host}`
  } catch {
    return origin
  }
}
