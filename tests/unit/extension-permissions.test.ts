import { describe, expect, it } from 'vitest'
import { originsCovered, patternCovers } from '../../src/main/extensions/match-pattern'
import { ExtensionShortcuts, formatShortcut, parseShortcut, shortcutFromKey } from '../../src/main/extensions/shortcuts'

describe('match patterns (chrome.permissions.contains)', () => {
  it('lets broad patterns cover narrow ones', () => {
    expect(patternCovers('<all_urls>', 'http://127.0.0.1:8080/')).toBe(true)
    expect(patternCovers('*://*/*', 'https://example.com/*')).toBe(true)
    expect(patternCovers('*://*/*', 'ftp://example.com/*')).toBe(false)
    expect(patternCovers('https://*.example.com/*', 'https://a.b.example.com/x')).toBe(true)
    expect(patternCovers('https://*.example.com/*', 'https://example.com/')).toBe(true)
    expect(patternCovers('https://example.com/*', 'https://*.example.com/*')).toBe(false)
    expect(patternCovers('http://127.0.0.1/*', 'http://127.0.0.1:5173/')).toBe(true)
    expect(patternCovers('http://127.0.0.1:80/*', 'http://127.0.0.1:5173/')).toBe(false)
    expect(patternCovers('https://example.com/*', 'http://example.com/*')).toBe(false)
    expect(patternCovers('https://example.com/*', '<all_urls>')).toBe(false)
  })

  it('needs every requested origin covered', () => {
    expect(originsCovered(['https://a.com/*', 'https://b.com/*'], ['https://a.com/', 'https://b.com/x'])).toBe(true)
    expect(originsCovered(['https://a.com/*'], ['https://a.com/', 'https://c.com/'])).toBe(false)
    expect(originsCovered([], [])).toBe(true)
  })
})

describe('extension shortcuts', () => {
  it('reads and writes Chrome shortcut syntax (macOS)', () => {
    expect(parseShortcut('Ctrl+Shift+Y')).toEqual({ code: 'KeyY', meta: true, control: false, alt: false, shift: true })
    expect(parseShortcut('MacCtrl+Alt+Comma')).toEqual({ code: 'Comma', meta: false, control: true, alt: true, shift: false })
    expect(parseShortcut('Shift+Y')).toBeNull()
    expect(parseShortcut('Command+F13')).toBeNull()
    expect(formatShortcut('Command+Shift+Y')).toBe('⇧⌘Y')
    expect(formatShortcut('MacCtrl+Alt+Up')).toBe('⌃⌥↑')
    expect(shortcutFromKey({ code: 'KeyK', meta: true, control: false, alt: true, shift: false })).toBe('Command+Alt+K')
    expect(shortcutFromKey({ code: 'KeyK', meta: false, control: false, alt: false, shift: true })).toBeNull()
    expect(shortcutFromKey({ code: 'F5', meta: true, control: false, alt: false, shift: false })).toBeNull()
  })

  it('binds suggested keys, moves a taken shortcut, and persists choices', () => {
    const saved: unknown[] = []
    const s = new ExtensionShortcuts(undefined, (all) => saved.push(all))
    s.setCommands('a', [{ name: 'go', description: 'Go', suggested: 'Command+Shift+Y', global: false }])
    s.setCommands('b', [{ name: 'run', description: 'Run', suggested: 'Command+Shift+Y', global: false }])
    const key = { type: 'keyDown', code: 'KeyY', meta: true, control: false, alt: false, shift: true }
    // First come, first served.
    expect(s.match(key)).toEqual({ id: 'a', name: 'go' })
    expect(s.set('b', 'run', 'Command+Shift+Y')).toEqual(['b', 'a'])
    expect(s.match(key)).toEqual({ id: 'b', name: 'run' })
    expect(s.list('a')[0]!.shortcut).toBe('')
    expect(s.set('b', 'run', 'Y')).toBeNull()
    expect(saved.at(-1)).toEqual({ b: { run: 'Command+Shift+Y' }, a: { go: '' } })
    // A restart reads them back; unloading unbinds.
    const again = new ExtensionShortcuts(saved.at(-1), () => undefined)
    again.setCommands('a', [{ name: 'go', description: 'Go', suggested: 'Command+Shift+Y', global: false }])
    expect(again.match(key)).toBeNull()
    again.setCommands('b', [{ name: 'run', description: 'Run', suggested: '', global: false }])
    expect(again.match(key)).toEqual({ id: 'b', name: 'run' })
    again.setCommands('b', [])
    expect(again.match(key)).toBeNull()
  })
})
