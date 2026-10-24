import { describe, expect, it } from 'vitest'
import { parseArcSidebar, summarizeArcSidebar } from '../../src/main/import/arc-sidebar'
import { nearestSpaceColor } from '../../src/main/import/arc-sidebar-import'
import { SPACE_COLORS } from '@shared/defaults'
import { fixture } from '../fixtures/arc-sidebar'


describe('parseArcSidebar', () => {
  it('reads spaces, nested folders, pinned tabs and favorites', () => {
    const sidebar = parseArcSidebar(fixture())!
    expect(sidebar.spaces.map((s) => [s.title, s.profile])).toEqual([
      [null, 'default'],
      ['Work', 'Profile 1'],
      ['Empty', 'default']
    ])
    const personal = sidebar.spaces[0]!
    expect(personal.color).toBe('#3380f2')
    expect(personal.todayCount).toBe(2)
    expect(personal.pinned).toEqual([
      {
        kind: 'folder',
        title: 'Reading',
        children: [
          { kind: 'tab', url: 'https://two.test/', title: 'saved t2' },
          { kind: 'folder', title: 'Papers', children: [{ kind: 'tab', url: 'https://three.test/a?b=c', title: 'saved t3' }] }
        ]
      },
      // A renamed tab keeps the user's title.
      { kind: 'tab', url: 'https://one.test/', title: 'Renamed One' },
      // Split views contribute their tabs.
      { kind: 'tab', url: 'https://left.test/', title: 'saved s1' },
      { kind: 'tab', url: 'https://right.test/', title: 'saved s2' }
    ])
    // The easel and the arc:// page are not importable.
    expect(sidebar.unsupported).toBe(2)
    expect(sidebar.favorites).toEqual({ default: [{ kind: 'tab', url: 'https://fav.test/', title: 'Fav' }] })
  })

  it('summarizes only spaces with pinned items', () => {
    expect(summarizeArcSidebar(parseArcSidebar(fixture())!)).toEqual({ spaces: 2, folders: 2, tabs: 6, favorites: 1 })
  })

  it('rejects files that are not an Arc sidebar', () => {
    expect(parseArcSidebar({})).toBeNull()
    expect(parseArcSidebar({ sidebar: { containers: [{ global: {} }] } })).toBeNull()
    expect(parseArcSidebar(null)).toBeNull()
  })

  it('snaps Arc theme colors to the space palette', () => {
    expect(nearestSpaceColor('#3380f2')).toBe('#3b82f6')
    expect(nearestSpaceColor(null)).toBe(SPACE_COLORS[0])
    expect(nearestSpaceColor('nope')).toBe(SPACE_COLORS[0])
  })
})
