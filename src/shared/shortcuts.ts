// Keyboard shortcuts in Chrome's manifest syntax ("Command+Shift+Y",
// "MacCtrl+Alt+K"), as chrome.commands and the Extensions page use them.
// Read the macOS way: Ctrl and Command are ⌘, MacCtrl is ⌃.

/** The physical key and modifiers of a key press (Electron's Input, a KeyboardEvent). */
export interface KeyPress {
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

export interface Parsed {
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

/** Chrome's key names → KeyboardEvent.code. */
const KEY_CODES: Record<string, string> = {
  Comma: 'Comma',
  Period: 'Period',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Space: 'Space',
  Insert: 'Insert',
  Delete: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight'
}
const CODE_KEYS = Object.fromEntries(Object.entries(KEY_CODES).map(([k, v]) => [v, k]))
const KEY_SYMBOLS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Space: 'Space',
  Delete: '⌦',
  Home: '↖',
  End: '↘',
  PageUp: '⇞',
  PageDown: '⇟'
}

/** Parse Chrome's shortcut syntax (macOS reading: Ctrl and Command are ⌘, MacCtrl is ⌃). */
export function parseShortcut(text: string): Parsed | null {
  const parts = text.split('+').map((p) => p.trim())
  if (parts.length < 2) return null
  const key = parts.pop()!
  const out: Parsed = { code: '', meta: false, control: false, alt: false, shift: false }
  for (const mod of parts) {
    switch (mod) {
      case 'Ctrl':
      case 'Command':
        out.meta = true
        break
      case 'MacCtrl':
        out.control = true
        break
      case 'Alt':
        out.alt = true
        break
      case 'Shift':
        out.shift = true
        break
      default:
        return null
    }
  }
  if (/^[A-Z]$/.test(key)) out.code = `Key${key}`
  else if (/^[0-9]$/.test(key)) out.code = `Digit${key}`
  else if (KEY_CODES[key]) out.code = KEY_CODES[key]
  else return null
  // Chrome: a shortcut needs Ctrl (⌘ / ⌃) or Alt.
  if (!out.meta && !out.control && !out.alt) return null
  return out
}

/** A key press as Chrome syntax, or null when it cannot be a shortcut. */
export function shortcutFromKey(input: KeyPress): string | null {
  let key: string | undefined
  if (/^Key[A-Z]$/.test(input.code)) key = input.code.slice(3)
  else if (/^Digit[0-9]$/.test(input.code)) key = input.code.slice(5)
  else key = CODE_KEYS[input.code]
  if (!key) return null
  const mods = [input.meta && 'Command', input.control && 'MacCtrl', input.alt && 'Alt', input.shift && 'Shift'].filter(Boolean)
  const text = [...mods, key].join('+')
  return parseShortcut(text) ? text : null
}

/** macOS display form, in Apple's modifier order: ⌃⌥⇧⌘Y. */
export function formatShortcut(text: string): string {
  const p = parseShortcut(text)
  if (!p) return ''
  const key = text.split('+').pop()!.trim()
  return `${p.control ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.meta ? '⌘' : ''}${KEY_SYMBOLS[key] ?? key}`
}

export function signature(p: Parsed): string {
  return `${p.meta ? 'M' : ''}${p.control ? 'C' : ''}${p.alt ? 'A' : ''}${p.shift ? 'S' : ''}:${p.code}`
}
