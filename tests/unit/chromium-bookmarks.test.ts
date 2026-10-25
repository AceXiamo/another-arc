import { describe, expect, it } from 'vitest'
import { parseChromiumBookmarks } from '../../src/main/import/chromium-bookmarks'
import { summarizeSidebar } from '../../src/main/import/arc-sidebar'

// Chromium's `Bookmarks` file, as Chrome, Edge and the rest write it.

const url = (name: string, href: string) => ({ type: 'url', name, url: href })
const folder = (name: string, children: unknown[]) => ({ type: 'folder', name, children })

const file = (roots: Record<string, unknown>) => ({ checksum: 'x', version: 1, roots })

describe('parseChromiumBookmarks', () => {
  it('puts the bookmarks bar at the top level of one unnamed space', () => {
    const sidebar = parseChromiumBookmarks(
      file({
        bookmark_bar: {
          name: 'Bookmarks Bar',
          children: [url('One', 'https://one.test/'), folder('Reading', [url('Two', 'https://two.test/a')])]
        },
        other: { name: 'Other Bookmarks', children: [] },
        synced: { name: 'Mobile Bookmarks', children: [] }
      })
    )
    expect(sidebar?.spaces).toHaveLength(1)
    const space = sidebar!.spaces[0]!
    // An unnamed space lands in the profile's first space.
    expect(space.title).toBeNull()
    expect(space.pinned).toEqual([
      { kind: 'tab', url: 'https://one.test/', title: 'One' },
      { kind: 'folder', title: 'Reading', children: [{ kind: 'tab', url: 'https://two.test/a', title: 'Two' }] }
    ])
    expect(summarizeSidebar(sidebar!)).toEqual({ spaces: 1, folders: 1, tabs: 2, favorites: 0 })
  })

  it('adds the other roots as folders, named as that browser named them', () => {
    const sidebar = parseChromiumBookmarks(
      file({
        bookmark_bar: { name: 'Bookmarks Bar', children: [url('One', 'https://one.test/')] },
        other: { name: '其他书签', children: [url('Two', 'https://two.test/')] },
        synced: { name: 'Mobile Bookmarks', children: [url('Three', 'https://three.test/')] }
      })
    )
    expect(sidebar!.spaces[0]!.pinned.map((n) => (n.kind === 'folder' ? n.title : n.url))).toEqual([
      'https://one.test/',
      '其他书签',
      'Mobile Bookmarks'
    ])
  })

  it('leaves out an empty root', () => {
    const sidebar = parseChromiumBookmarks(
      file({
        bookmark_bar: { name: 'Bookmarks Bar', children: [url('One', 'https://one.test/')] },
        other: { name: 'Other Bookmarks', children: [] },
        synced: { name: 'Mobile Bookmarks', children: [folder('Empty', [])] }
      })
    )
    expect(sidebar!.spaces[0]!.pinned).toHaveLength(1)
  })

  it('counts the bookmarks it cannot open instead of dropping them silently', () => {
    const sidebar = parseChromiumBookmarks(
      file({
        bookmark_bar: {
          name: 'Bookmarks Bar',
          children: [
            url('Script', 'javascript:void(0)'),
            url('Settings', 'chrome://settings/'),
            url('Keeps', 'https://keeps.test/'),
            url('Local', 'file:///Users/x/notes.html')
          ]
        }
      })
    )
    expect(sidebar!.unsupported).toBe(2)
    expect(sidebar!.spaces[0]!.pinned.map((n) => (n.kind === 'tab' ? n.title : ''))).toEqual(['Keeps', 'Local'])
  })

  it('names what the file left unnamed', () => {
    const sidebar = parseChromiumBookmarks(
      file({ bookmark_bar: { children: [url('', 'https://one.test/'), folder('', [url('x', 'https://two.test/')])] } })
    )
    expect(sidebar!.spaces[0]!.pinned).toEqual([
      { kind: 'tab', url: 'https://one.test/', title: 'https://one.test/' },
      { kind: 'folder', title: 'Folder', children: [{ kind: 'tab', url: 'https://two.test/', title: 'x' }] }
    ])
  })

  it('is null for a file with no bookmarks, and for anything that is not one', () => {
    expect(parseChromiumBookmarks(file({ bookmark_bar: { children: [] } }))).toBeNull()
    expect(parseChromiumBookmarks({})).toBeNull()
    expect(parseChromiumBookmarks(null)).toBeNull()
    expect(parseChromiumBookmarks('nope')).toBeNull()
  })

  it('stops following a tree that points at itself', () => {
    const loop: Record<string, unknown> = { type: 'folder', name: 'Loop' }
    loop.children = [loop]
    expect(() => parseChromiumBookmarks(file({ bookmark_bar: { children: [loop] } }))).not.toThrow()
  })
})
