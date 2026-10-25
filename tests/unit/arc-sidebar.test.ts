import { describe, expect, it } from 'vitest'
import { parseArcSidebar, summarizeSidebar } from '../../src/main/import/arc-sidebar'
import { applySidebar, arcSpaceLook, nearestSpaceColor } from '../../src/main/import/sidebar-import'
import { BrowserModel, type ModelListener, type SpaceData } from '../../src/main/tabs/model'
import type { TabManager } from '../../src/main/tabs/tab-manager'
import type { SpaceInput } from '@shared/ipc'
import { DEFAULT_SPACE, SPACE_COLORS } from '@shared/defaults'
import { DEFAULT_SPACE_THEME, sanitizeSpaceTheme } from '@shared/theme'
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
    expect(summarizeSidebar(parseArcSidebar(fixture())!)).toEqual({ spaces: 2, folders: 2, tabs: 6, favorites: 1 })
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

describe('Arc space themes', () => {
  const rgb = (red: number, green: number, blue: number, alpha = 1) => ({ red, green, blue, alpha, colorSpace: 'extendedSRGB' })
  /** The fixture with Arc's `windowTheme.background` set on two spaces, shaped as Arc writes it. */
  function themed() {
    const json = fixture()
    const spaces = json.sidebar.containers[1]!.spaces as unknown[]
    const personal = spaces[1] as { customInfo: { windowTheme: Record<string, unknown> } }
    personal.customInfo.windowTheme.background = {
      single: {
        _0: {
          style: {
            color: {
              _0: {
                blendedSingleColor: {
                  _0: { color: rgb(0.4, 0.4, 0.5372), modifiers: { overlay: 'tweed', noiseFactor: 0.95, intensityFactor: 0.7247 } }
                }
              }
            }
          }
        }
      }
    }
    const work = spaces[3] as Record<string, unknown>
    work.customInfo = {
      windowTheme: {
        background: {
          single: {
            _0: {
              style: {
                color: {
                  _0: {
                    blendedGradient: {
                      _0: {
                        // Extended sRGB can leave 0–1; overlay colors are not part of the look.
                        baseColors: [rgb(0.9725, 0.8349, 0.3457), rgb(0.6419, 0.9583, -0.05), rgb(1.02, 0.45, 0.4)],
                        overlayColors: [rgb(0, 0, 0, 0), rgb(1, 0.46, 0.4)],
                        modifiers: { intensityFactor: 0.2006, noiseFactor: 0.5, overlay: 'grain' },
                        wheel: { analogous: {} }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return json
  }

  it('reads single colors and gradients with their intensity and grain', () => {
    const [personal, work, empty] = parseArcSidebar(themed())!.spaces
    expect(personal!.theme).toEqual({ colors: ['#666689'], intensity: 0.7247, noise: 0.95 })
    expect(work!.theme).toEqual({ colors: ['#f8d558', '#a4f400', '#ff7366'], intensity: 0.2006, noise: 0.5 })
    expect(empty!.theme).toBeNull()
    // The palette color stays as before (it was the only color Arc's file gave).
    expect(personal!.color).toBe('#3380f2')
  })

  it('maps Arc factors onto the space theme scale', () => {
    const [personal, work] = parseArcSidebar(themed())!.spaces
    const single = arcSpaceLook(personal!.theme!)
    expect(single).toEqual({ color: '#666689', theme: { gradient: [], intensity: 72.47, noise: 95 } })
    expect(sanitizeSpaceTheme(single.theme)).toMatchObject({ gradient: [], intensity: 72, noise: 95, angle: DEFAULT_SPACE_THEME.angle })
    const gradient = arcSpaceLook(work!.theme!)
    expect(gradient.color).toBe('#f8d558')
    expect(sanitizeSpaceTheme(gradient.theme)).toMatchObject({ gradient: ['#a4f400', '#ff7366'], intensity: 20, noise: 50 })
    // Missing factors keep the defaults.
    expect(arcSpaceLook({ colors: ['#123456'], intensity: null, noise: null })).toEqual({ color: '#123456', theme: { gradient: [] } })
  })

  it("gives created and never-customized spaces Arc's look, and leaves customized ones alone", () => {
    const noop = new Proxy({}, { get: () => () => undefined }) as ModelListener
    const space = (id: string, name: string, color: string, theme = sanitizeSpaceTheme(null)): SpaceData => ({
      id,
      name,
      icon: 'home',
      color,
      theme,
      profileId: 'default',
      pinnedTabIds: [],
      savedIds: [],
      tabIds: [],
      activeTabId: null,
      createdAt: 0
    })
    const run = (spaces: SpaceData[]) => {
      const model = new BrowserModel(noop)
      for (const s of spaces) model.addSpace(s)
      const created: SpaceInput[] = []
      const updated: Array<[string, Partial<SpaceInput>]> = []
      const tabs = {
        model,
        createSpace: (input: SpaceInput) => {
          created.push(input)
          const id = `created-${created.length}`
          model.addSpace(space(id, input.name, input.color))
          return id
        },
        updateSpace: (id: string, input: Partial<SpaceInput>) => updated.push([id, input]),
        createFolder: () => null,
        setFolderCollapsed: () => undefined,
        addUnloadedTab: () => 'tab'
      } as unknown as TabManager
      applySidebar(tabs, parseArcSidebar(themed())!)
      return { created, updated }
    }

    // Fresh profile: the default space takes the unnamed Arc space's look; "Work" is created with its gradient.
    const fresh = run([space('first', 'Personal', DEFAULT_SPACE.color)])
    expect(fresh.updated).toEqual([['first', { color: '#666689', theme: { gradient: [], intensity: 72.47, noise: 95 } }]])
    expect(fresh.created).toEqual([
      expect.objectContaining({ name: 'Work', color: '#f8d558', theme: { gradient: ['#a4f400', '#ff7366'], intensity: 20.06, noise: 50 } })
    ])

    // Spaces whose color or theme were chosen keep them.
    const customized = run([
      space('first', 'Personal', DEFAULT_SPACE.color, sanitizeSpaceTheme({ noise: 0 })),
      space('work', 'Work', '#3b82f6')
    ])
    expect(customized.updated).toEqual([])
    expect(customized.created).toEqual([])
  })
})
