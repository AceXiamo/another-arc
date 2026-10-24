import { TAB_SELECT_COMMANDS, type CommandId } from './commands'

export interface KeyLike {
  type: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

interface Binding {
  code: string
  meta?: boolean
  control?: boolean
  alt?: boolean
  shift?: boolean
  command: CommandId
}

/**
 * Browser-critical shortcuts. These are intercepted in `before-input-event`
 * for every page and the shell, so web pages cannot swallow them (same idea
 * as Chrome's "reserved" accelerators). Everything else is a regular menu
 * accelerator that a page may handle first.
 *
 * Matching uses physical key codes so bindings work on any keyboard layout.
 */
const RESERVED: Binding[] = [
  { code: 'KeyT', meta: true, command: 'tab.new' },
  { code: 'KeyW', meta: true, command: 'tab.close' },
  { code: 'KeyT', meta: true, shift: true, command: 'tab.reopen' },
  { code: 'KeyL', meta: true, command: 'address.focus' },
  { code: 'Tab', control: true, command: 'tab.next' },
  { code: 'Tab', control: true, shift: true, command: 'tab.prev' },
  { code: 'ArrowRight', meta: true, alt: true, command: 'tab.next' },
  { code: 'ArrowLeft', meta: true, alt: true, command: 'tab.prev' },
  { code: 'BracketRight', meta: true, shift: true, command: 'space.next' },
  { code: 'BracketLeft', meta: true, shift: true, command: 'space.prev' },
  { code: 'KeyW', meta: true, shift: true, command: 'window.close' },
  ...TAB_SELECT_COMMANDS.map((command, i) => ({ code: `Digit${i + 1}`, meta: true, command }))
]

const index = new Map<string, CommandId>()
for (const b of RESERVED) index.set(signature(b.code, !!b.meta, !!b.control, !!b.alt, !!b.shift), b.command)

function signature(code: string, meta: boolean, control: boolean, alt: boolean, shift: boolean): string {
  return `${meta ? 'M' : ''}${control ? 'C' : ''}${alt ? 'A' : ''}${shift ? 'S' : ''}:${code}`
}

/** The reserved command for a keyDown, if any. */
export function reservedCommandFor(input: KeyLike): CommandId | null {
  if (input.type !== 'keyDown') return null
  // Fast path: every reserved binding needs Cmd or Ctrl.
  if (!input.meta && !input.control) return null
  return index.get(signature(input.code, input.meta, input.control, input.alt, input.shift)) ?? null
}

/** Whether a keyUp belongs to a reserved shortcut (swallowed for symmetry). */
export function isReservedKeyUp(input: KeyLike): boolean {
  if (input.type !== 'keyUp' || (!input.meta && !input.control)) return false
  return index.has(signature(input.code, input.meta, input.control, input.alt, input.shift))
}

/** Menu accelerator labels for reserved commands (display only). */
export const RESERVED_ACCELERATORS: Partial<Record<CommandId, string>> = {
  'tab.new': 'Cmd+T',
  'tab.close': 'Cmd+W',
  'tab.reopen': 'Cmd+Shift+T',
  'address.focus': 'Cmd+L',
  'tab.next': 'Ctrl+Tab',
  'tab.prev': 'Ctrl+Shift+Tab',
  'space.next': 'Cmd+Shift+]',
  'space.prev': 'Cmd+Shift+[',
  'window.close': 'Cmd+Shift+W',
  ...Object.fromEntries(TAB_SELECT_COMMANDS.map((c, i) => [c, `Cmd+${i + 1}`]))
}
