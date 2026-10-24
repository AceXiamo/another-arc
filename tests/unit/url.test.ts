import { describe, expect, it } from 'vitest'
import {
  displayHost,
  displayUrl,
  isValidSearchTemplate,
  parseInternalUrl,
  resolveInput,
  securityLevel,
  tabPresentsView
} from '@shared/url'

const T = 'https://search.test/?q=%s'
const url = (input: string) => resolveInput(input, T)

describe('resolveInput', () => {
  it('returns null for blank input', () => {
    expect(url('   ')).toBeNull()
  })

  it.each([
    ['example.com', 'https://example.com/'],
    ['github.com/foo/bar?x=1#y', 'https://github.com/foo/bar?x=1#y'],
    ['sub.domain.co.uk', 'https://sub.domain.co.uk/'],
    ['https://example.com/a b'.replace(' ', '%20'), 'https://example.com/a%20b'],
    ['http://example.com', 'http://example.com/'],
    ['localhost', 'http://localhost/'],
    ['localhost:3000/api', 'http://localhost:3000/api'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['192.168.1.1', 'http://192.168.1.1/'],
    ['[::1]:5173', 'http://[::1]:5173/'],
    ['myapp.test', 'http://myapp.test/'],
    ['printer.local/status', 'http://printer.local/status'],
    ['example.com:8443/x', 'https://example.com:8443/x'],
    ['about:blank', 'about:blank'],
    ['file:///Users/me/a.html', 'file:///Users/me/a.html'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
    ['browser://settings', 'browser://settings'],
    ['例子.中国', 'https://xn--fsqu00a.xn--fiqs8s/']
  ])('treats %s as a URL', (input, expected) => {
    expect(url(input)).toEqual({ kind: 'url', url: expected })
  })

  it.each([
    'hello world',
    'next.js',
    'electron',
    'what is example.com',
    'foo/bar',
    'someone@example.com',
    '1.2',
    'javascript:alert(1)',
    'note:buy',
    'browser://nope',
    'C++'
  ])('treats %s as a search', (input) => {
    const result = url(input)
    expect(result?.kind).toBe('search')
    expect(result?.url).toBe(`https://search.test/?q=${encodeURIComponent(input)}`)
  })
})

describe('display helpers', () => {
  it('shortens hosts', () => {
    expect(displayHost('https://www.example.com/path')).toBe('example.com')
    expect(displayHost('browser://history')).toBe('History')
    expect(displayHost('browser://history', 'zh-CN')).toBe('历史记录')
  })

  it('decodes URLs and drops bare trailing slashes', () => {
    expect(displayUrl('https://example.com/')).toBe('https://example.com')
    expect(displayUrl('https://example.com/%E4%B8%AD')).toBe('https://example.com/中')
  })

  it('classifies security', () => {
    expect(securityLevel('https://a.com')).toBe('secure')
    expect(securityLevel('http://a.com')).toBe('insecure')
    expect(securityLevel('http://localhost:3000')).toBe('internal')
    expect(securityLevel('about:blank')).toBe('internal')
  })
})

describe('internal pages', () => {
  it('parses known pages only', () => {
    expect(parseInternalUrl('browser://extensions')).toBe('extensions')
    expect(parseInternalUrl('browser://settings/search')).toBe('settings')
    expect(parseInternalUrl('browser://toString')).toBeNull()
    expect(parseInternalUrl('https://settings')).toBeNull()
  })

  it('decides when a tab is drawn by a web view', () => {
    const base = { live: true, crashed: false, error: null, url: 'https://a.com' }
    expect(tabPresentsView(base)).toBe(true)
    expect(tabPresentsView({ ...base, live: false })).toBe(false)
    expect(tabPresentsView({ ...base, crashed: true })).toBe(false)
    expect(tabPresentsView({ ...base, url: 'browser://settings' })).toBe(false)
  })
})

describe('search templates', () => {
  it('validates custom templates', () => {
    expect(isValidSearchTemplate('https://s.com/?q=%s')).toBe(true)
    expect(isValidSearchTemplate('https://s.com/?q=')).toBe(false)
    expect(isValidSearchTemplate('javascript:%s')).toBe(false)
  })
})
