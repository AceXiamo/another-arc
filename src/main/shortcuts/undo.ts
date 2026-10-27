import type { WebContents } from 'electron'

// ⌘Z, as in Arc: text undo wherever text is being edited, and otherwise the
// browser's own undo — the window that was closed comes back, or the tab
// that was closed reopens.
//
// Pages that handle ⌘Z themselves (Docs, Figma…) never get here: a menu
// shortcut only reaches the menu when the page leaves the key alone.

export type UndoAction =
  /** Showing the closed window again was the undo (the caller already did). */
  | 'none'
  /** A native panel has the keyboard; hand it the standard `undo:`. */
  | 'native'
  | 'reopen'
  /** Undo in whatever has focus. */
  | 'text'
  /** Depends on whether the focused view is editing text: ask it. */
  | 'probe'

export interface UndoContext {
  /** The window was hidden (closed) when ⌘Z came in. */
  windowWasHidden: boolean
  /** Our window is the key window, rather than a native panel or sheet. */
  windowIsKey: boolean
  /** Some WebContents of ours has the keyboard. */
  hasFocusedContents: boolean
  /** A tab was closed after the last key typed anywhere. */
  closedSinceTyping: boolean
  /** There is a closed tab to bring back. */
  canReopen: boolean
}

export function decideUndo(ctx: UndoContext): UndoAction {
  if (ctx.windowWasHidden) return 'none'
  if (!ctx.hasFocusedContents && !ctx.windowIsKey) return 'native'
  // ⌘W then ⌘Z: nothing has been typed since the close, so this undoes the
  // close — even when the page that took over has a field focused.
  if (ctx.canReopen && ctx.closedSinceTyping) return 'reopen'
  if (ctx.hasFocusedContents) return 'probe'
  return ctx.canReopen ? 'reopen' : 'none'
}

/**
 * Electron's context-isolation world: the page's own scripts cannot reach
 * it or redefine what it reads (`document.activeElement`, `isContentEditable`).
 */
const ISOLATED_WORLD = 999
/** A page too busy to answer this quickly is not one being typed into. */
const PROBE_TIMEOUT_MS = 200

/**
 * Is the keyboard in something that edits text? Follows focus into
 * same-origin frames; a focused cross-origin frame counts as editing, since
 * it may well be an embedded editor and text undo is the harmless guess.
 */
const EDITING_PROBE = `(() => {
  const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'])
  let el = document.activeElement
  for (let depth = 0; el && el.tagName === 'IFRAME' && depth < 8; depth += 1) {
    let inner
    try { inner = el.contentDocument } catch { inner = null }
    if (!inner) return true
    el = inner.activeElement
  }
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled
  if (el.tagName === 'INPUT') return !NOT_TEXT.has(el.type) && !el.readOnly && !el.disabled
  return false
})()`

export async function isEditingText(wc: WebContents): Promise<boolean> {
  try {
    const answer = wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: EDITING_PROBE }])
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PROBE_TIMEOUT_MS))
    return (await Promise.race([answer, timeout])) === true
  } catch {
    return false
  }
}

/** Keys that do not count as typing for `closedSinceTyping`. */
export function isTyping(input: { type: string; key: string; meta: boolean; shift: boolean }): boolean {
  if (input.type !== 'keyDown') return false
  if (MODIFIERS.has(input.key)) return false
  // ⌘Z / ⇧⌘Z are the undo itself.
  if (input.meta && input.key.toLowerCase() === 'z') return false
  return true
}

const MODIFIERS = new Set(['Meta', 'Shift', 'Control', 'Alt', 'CapsLock', 'Fn'])
