import { describe, expect, it } from 'vitest'
import { decideUndo, isTyping, type UndoContext } from '../../src/main/shortcuts/undo'

const base: UndoContext = {
  windowWasHidden: false,
  windowIsKey: true,
  hasFocusedContents: true,
  closedSinceTyping: false,
  canReopen: true
}
const decide = (patch: Partial<UndoContext>) => decideUndo({ ...base, ...patch })

describe('decideUndo', () => {
  it('brings a closed window back, and does nothing else', () => {
    expect(decide({ windowWasHidden: true })).toBe('none')
    expect(decide({ windowWasHidden: true, closedSinceTyping: true })).toBe('none')
  })

  it('reopens the tab right after it was closed, even over a focused field', () => {
    expect(decide({ closedSinceTyping: true })).toBe('reopen')
  })

  it('asks the focused view whether it is editing once the user has typed since', () => {
    expect(decide({ closedSinceTyping: false })).toBe('probe')
  })

  it('reopens when nothing of ours has the keyboard', () => {
    expect(decide({ hasFocusedContents: false })).toBe('reopen')
  })

  it('does nothing with nothing to reopen and nothing focused', () => {
    expect(decide({ hasFocusedContents: false, canReopen: false })).toBe('none')
  })

  it('still asks for text undo when there is nothing to reopen', () => {
    expect(decide({ canReopen: false, closedSinceTyping: true })).toBe('probe')
  })

  it('leaves a native panel its own undo', () => {
    expect(decide({ hasFocusedContents: false, windowIsKey: false })).toBe('native')
    expect(decide({ hasFocusedContents: false, windowIsKey: false, closedSinceTyping: true })).toBe('native')
  })
})

describe('isTyping', () => {
  const key = (k: string, extra: Partial<{ type: string; meta: boolean; shift: boolean }> = {}) =>
    isTyping({ type: 'keyDown', key: k, meta: false, shift: false, ...extra })

  it('counts characters, editing keys and other shortcuts', () => {
    expect(key('a')).toBe(true)
    expect(key('Backspace')).toBe(true)
    expect(key('v', { meta: true })).toBe(true)
  })

  it('does not count modifiers alone, key releases, or the undo itself', () => {
    expect(key('Meta')).toBe(false)
    expect(key('Shift')).toBe(false)
    expect(key('a', { type: 'keyUp' })).toBe(false)
    expect(key('z', { meta: true })).toBe(false)
    expect(key('Z', { meta: true, shift: true })).toBe(false)
  })
})
