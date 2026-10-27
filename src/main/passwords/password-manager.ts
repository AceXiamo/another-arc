import { ipcMain, type WebContents } from 'electron'
import {
  autofillCardHeight,
  AUTOFILL_INSET,
  AUTOFILL_MAX_WIDTH,
  AUTOFILL_MIN_WIDTH,
  PASSWORD_IPC,
  type AutofillEntry,
  type AutofillKey,
  type AutofillRequest,
  type AutofillState,
  type FieldRect,
  type SubmittedLogin
} from '@shared/passwords'
import type { Rect } from '@shared/layout'
import { originOf, type PasswordStore } from './password-store'

// Drives the sign-in dropdown and the "save this password?" prompt.
//
// The page preload reports a field the user went into; this decides what to
// offer and where, and the shell draws the list in a floating surface above
// the page. Picking one sends the credential back down to that page's
// preload — the only direction a password travels; it never reaches the
// shell.
//
// The dropdown never takes the keyboard. Arrow keys, Enter and Escape stay in
// the field and the preload forwards them here; a click on a row does move
// focus to the surface for a moment, which is why a page losing focus closes
// the dropdown only after `BLUR_GRACE_MS` — long enough for that pick to
// arrive first.
//
// Every message is checked against the WebContents it claims to come from:
// the origin is read from the sender's own URL, never from what it sent, so
// a page cannot ask for another site's logins.

/** Clear of the field, so the dropdown does not cover what is being typed. */
const GAP = 2
/** How long a page may be without focus before the dropdown closes. */
export const BLUR_GRACE_MS = 150

export interface PasswordHost {
  /** Tab id for a page's WebContents, or null when it is not a tab. */
  tabIdFor(wc: WebContents): string | null
  /** Show or hide the dropdown surface. */
  setDropdownVisible(visible: boolean): void
  /** Move it to `place()`'s answer without hiding it. */
  reposition(): void
  /** Tell the shell what to draw, which row is picked, and which side of the field it is on. */
  showEntries(entries: AutofillEntry[], active: number, above: boolean): void
  /** True while the dropdown surface itself has the keyboard (mid-click). */
  dropdownFocused(): boolean
  offerToSave(origin: string, username: string): void
}

interface Anchor {
  wc: WebContents
  rect: FieldRect
  zoom: number
}

export class PasswordManager {
  private anchor: Anchor | null = null
  private entries: AutofillEntry[] = []
  private active = -1
  /** Drawn above the field (no room below it). */
  private above = false
  private grace: ReturnType<typeof setTimeout> | null = null
  private pendingSave: SubmittedLogin | null = null

  constructor(
    readonly store: PasswordStore,
    private readonly host: PasswordHost
  ) {}

  /** One set of listeners for every page; the sender tells them apart. */
  attach(): void {
    ipcMain.on(PASSWORD_IPC.focus, (event, request: unknown) => this.onFocus(event.sender, request))
    ipcMain.on(PASSWORD_IPC.blur, (event, info: unknown) => this.onBlur(event.sender, info))
    ipcMain.on(PASSWORD_IPC.move, (event, rect: unknown) => this.onMove(event.sender, rect))
    ipcMain.on(PASSWORD_IPC.key, (event, key: unknown) => this.onKey(event.sender, key))
    ipcMain.on(PASSWORD_IPC.submitted, (event, submitted: unknown) => this.onSubmitted(event.sender, submitted))
  }

  /** What the dropdown lists right now. */
  current(): AutofillEntry[] {
    return this.entries
  }

  private onFocus(sender: WebContents, request: unknown): void {
    if (!this.host.tabIdFor(sender)) return
    const parsed = asRequest(request)
    const origin = originOf(sender.getURL())
    if (!parsed || !origin) return this.close()

    const typed = parsed.typed.trim().toLowerCase()
    const matches = this.store
      .forOrigin(origin)
      .filter((login) => typed === '' || login.username.toLowerCase().startsWith(typed))
    if (matches.length === 0) return this.close()

    this.cancelGrace()
    const wasOpen = this.anchor !== null
    this.anchor = { wc: sender, rect: parsed.rect, zoom: sender.getZoomFactor() }
    this.entries = matches.map((login) => ({ id: login.id, username: login.username }))
    this.active = -1
    this.push()
    // Already showing (another field, or narrowed while typing): move and
    // resize it in place instead of hiding and showing it again.
    if (wasOpen) this.host.reposition()
    else this.host.setDropdownVisible(true)
  }

  private onBlur(sender: WebContents, info: unknown): void {
    if (this.anchor?.wc !== sender) return
    if ((info as { left?: unknown } | null)?.left !== true) return this.close()
    // Focus left the page. Most often that is a click on a row, whose pick is
    // already on its way; give it a moment before closing.
    this.cancelGrace()
    this.grace = setTimeout(() => {
      this.grace = null
      const anchor = this.anchor
      if (!anchor) return
      // A click on the dropdown that missed every row: keep it, and hand the
      // keyboard back to the field.
      if (this.host.dropdownFocused()) {
        if (!anchor.wc.isDestroyed()) anchor.wc.focus()
        return
      }
      this.close()
    }, BLUR_GRACE_MS)
  }

  private onMove(sender: WebContents, rect: unknown): void {
    const anchor = this.anchor
    if (anchor?.wc !== sender || !isRect(rect)) return
    anchor.rect = rect
    anchor.zoom = sender.getZoomFactor()
    this.host.reposition()
  }

  private onKey(sender: WebContents, key: unknown): void {
    if (this.anchor?.wc !== sender || this.entries.length === 0) return
    const k = key as AutofillKey
    const count = this.entries.length
    if (k === 'down') this.active = (this.active + 1) % count
    else if (k === 'up') this.active = this.active <= 0 ? count - 1 : this.active - 1
    else if (k === 'enter') {
      const entry = this.entries[this.active]
      if (entry) this.fill(entry.id)
      return
    } else return
    this.push()
  }

  /** A pick, from a click in the shell or Enter in the field. */
  fill(id: string): void {
    const anchor = this.anchor
    // Read what was offered before closing, which clears it.
    const offered = this.entries.some((entry) => entry.id === id)
    this.close()
    if (!anchor || !offered || anchor.wc.isDestroyed()) return
    const login = this.store.get(id)
    const password = this.store.password(id)
    if (!login || password === null) return
    // Still the same page, and still the origin the credential belongs to.
    if (originOf(anchor.wc.getURL()) !== login.origin) return
    anchor.wc.send(PASSWORD_IPC.fill, login.username, password)
    // A click on a row moved the keyboard to the dropdown; give it back.
    anchor.wc.focus()
    this.store.markUsed(id)
  }

  close(): void {
    this.cancelGrace()
    const anchor = this.anchor
    if (!anchor && this.entries.length === 0) return
    this.anchor = null
    this.entries = []
    this.active = -1
    this.above = false
    if (anchor && !anchor.wc.isDestroyed()) anchor.wc.send(PASSWORD_IPC.state, { open: false, active: -1 } satisfies AutofillState)
    this.host.setDropdownVisible(false)
  }

  /** Where the dropdown goes, given the page card's bounds in the window. */
  place(card: Rect): Rect {
    const anchor = this.anchor
    const cardWidth = clamp((anchor?.rect.width ?? 0) * (anchor?.zoom ?? 1), AUTOFILL_MIN_WIDTH, AUTOFILL_MAX_WIDTH)
    // The surface is the card plus room for its shadow: on both sides, and on
    // the side away from the field — none on the side facing it, where a
    // transparent strip would swallow clicks meant for the field.
    const width = cardWidth + AUTOFILL_INSET * 2
    const height = autofillCardHeight(this.entries.length) + AUTOFILL_INSET
    if (!anchor) return { x: card.x, y: card.y, width, height }
    const { rect, zoom } = anchor
    const below = (rect.y + rect.height) * zoom + GAP
    const above = rect.y * zoom - GAP - height
    // Flip above the field when there is no room under it.
    const flip = below + height > card.height && above >= 0
    if (flip !== this.above) {
      this.above = flip
      this.push()
    }
    return {
      // The card, not the surface, lines up with the field's left edge.
      x: card.x + clamp(rect.x * zoom - AUTOFILL_INSET, 0, Math.max(0, card.width - width)),
      y: card.y + clamp(flip ? above : below, 0, Math.max(0, card.height - height)),
      width: Math.min(width, card.width),
      height: Math.min(height, card.height)
    }
  }

  private push(): void {
    this.host.showEntries(this.entries, this.active, this.above)
    const anchor = this.anchor
    if (anchor && !anchor.wc.isDestroyed()) anchor.wc.send(PASSWORD_IPC.state, { open: true, active: this.active } satisfies AutofillState)
  }

  private cancelGrace(): void {
    if (this.grace) clearTimeout(this.grace)
    this.grace = null
  }

  private onSubmitted(sender: WebContents, submitted: unknown): void {
    if (!this.host.tabIdFor(sender) || !this.store.available) return
    const parsed = asSubmitted(submitted)
    const origin = originOf(sender.getURL())
    if (!parsed || !origin || !parsed.password) return
    // Already saved, password and all: nothing to ask about.
    if (this.store.has(origin, parsed.username, parsed.password)) return
    this.pendingSave = { origin, username: parsed.username, password: parsed.password }
    this.host.offerToSave(origin, parsed.username)
  }

  /** The shell's answer to the save prompt. */
  resolveSave(accept: boolean): void {
    const pending = this.pendingSave
    this.pendingSave = null
    if (!accept || !pending) return
    this.store.save(pending.origin, pending.username, pending.password)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function asRequest(value: unknown): AutofillRequest | null {
  const v = value as Partial<AutofillRequest> | null
  if (!v || typeof v.typed !== 'string' || !isRect(v.rect)) return null
  return { origin: '', rect: v.rect, typed: v.typed.slice(0, 256) }
}

function isRect(value: unknown): value is FieldRect {
  const r = value as Partial<FieldRect> | null
  return !!r && [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n))
}

function asSubmitted(value: unknown): Omit<SubmittedLogin, 'origin'> | null {
  const v = value as Partial<SubmittedLogin> | null
  if (!v || typeof v.username !== 'string' || typeof v.password !== 'string') return null
  // Long values are a sign of something other than a sign-in form.
  if (v.username.length > 256 || v.password.length > 1024) return null
  return { username: v.username, password: v.password }
}
