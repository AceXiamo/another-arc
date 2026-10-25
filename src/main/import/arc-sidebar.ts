import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Reads Arc's sidebar (StorableSidebar.json, next to its "User Data" folder):
// spaces, their pinned items (tabs and nested folders, Arc's bookmarks) and the
// favorites. Strictly read-only.
//
// The file stores collections as flat alternating lists: [id, object, id, object…].
// Items form a tree through `childrenIds`; each space names its pinned and
// unpinned container items in `containerIDs` (['unpinned', id, 'pinned', id]).

export type ArcNode = ArcFolder | ArcTab

export interface ArcTab {
  kind: 'tab'
  url: string
  title: string
}

export interface ArcFolder {
  kind: 'folder'
  title: string
  children: ArcNode[]
}

export interface ArcSpace {
  id: string
  /** Null for Arc's unnamed default space. */
  title: string | null
  /** Theme color as #rrggbb, when the space has one. */
  color: string | null
  /** The space's background ("Edit Theme" in Arc), when it has one. */
  theme: ArcTheme | null
  /** 'default' or the Chromium profile folder ("Profile 1") the space is tied to. */
  profile: string
  /** Pinned section, in order. */
  pinned: ArcNode[]
  /** Unpinned ("Today") tabs; counted only, never imported. */
  todayCount: number
}

/**
 * Arc's window background: `customInfo.windowTheme.background.single._0
 * .style.color._0`, either `blendedSingleColor._0` ({ color, modifiers }) or
 * `blendedGradient._0` ({ baseColors, modifiers }).
 */
export interface ArcTheme {
  /** Background colors in order (#rrggbb, 1–3): the first is the primary. */
  colors: string[]
  /** `modifiers.intensityFactor`, 0–1. */
  intensity: number | null
  /** `modifiers.noiseFactor`, 0–1. */
  noise: number | null
}

export interface ArcSidebar {
  spaces: ArcSpace[]
  /** Favorites (the icon row) per profile key, as in `ArcSpace.profile`. */
  favorites: Record<string, ArcTab[]>
  /** Items that cannot be imported (notes, easels, unsupported URLs). */
  unsupported: number
}

/** StorableSidebar.json lives next to Arc's "User Data" folder. */
export function arcSidebarPath(userDataRoot: string): string {
  return join(dirname(userDataRoot), 'StorableSidebar.json')
}

export async function readArcSidebar(path: string): Promise<ArcSidebar | null> {
  try {
    return parseArcSidebar(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

/** Only pages that open here; a browser's own internal pages are skipped. */
export const IMPORTABLE_URL = /^(https?|file):/i
/** Guard against a bookmark tree that points at itself. */
export const MAX_DEPTH = 32

export function parseArcSidebar(json: unknown): ArcSidebar | null {
  const containers = asArray(asObject(asObject(json)?.sidebar)?.containers)
  const container = containers?.map(asObject).find((c) => c && Array.isArray(c.spaces) && Array.isArray(c.items))
  if (!container) return null
  const items = pairs(container.items as unknown[])
  const spaceEntries = [...pairs(container.spaces as unknown[])]
  let unsupported = 0

  const nodes = (ids: unknown, depth: number): ArcNode[] => {
    const out: ArcNode[] = []
    for (const id of asArray(ids) ?? []) {
      const item = typeof id === 'string' ? items.get(id) : undefined
      if (!item) continue
      const data = asObject(item.data)
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      const tab = asObject(data?.tab)
      if (tab) {
        const url = typeof tab.savedURL === 'string' ? tab.savedURL : ''
        if (!IMPORTABLE_URL.test(url)) {
          unsupported += 1
          continue
        }
        const savedTitle = typeof tab.savedTitle === 'string' ? tab.savedTitle.trim() : ''
        out.push({ kind: 'tab', url, title: title || savedTitle })
      } else if (data && 'list' in data && depth < MAX_DEPTH) {
        out.push({ kind: 'folder', title, children: nodes(item.childrenIds, depth + 1) })
      } else if (data && 'splitView' in data && depth < MAX_DEPTH) {
        // A split view keeps its tabs as children: import them side by side.
        out.push(...nodes(item.childrenIds, depth + 1))
      } else {
        unsupported += 1
      }
    }
    return out
  }

  const spaces: ArcSpace[] = []
  for (const [id, space] of spaceEntries) {
    const containerIds = pairs(asArray(space.containerIDs) ?? [], true)
    const pinned = items.get(String(containerIds.get('pinned') ?? ''))
    const unpinned = items.get(String(containerIds.get('unpinned') ?? ''))
    spaces.push({
      id,
      title: typeof space.title === 'string' && space.title.trim() ? space.title.trim() : null,
      color: spaceColor(space),
      theme: spaceTheme(space),
      profile: profileKey(space.profile),
      pinned: pinned ? nodes(pinned.childrenIds, 0) : [],
      todayCount: asArray(unpinned?.childrenIds)?.length ?? 0
    })
  }

  const favorites: Record<string, ArcTab[]> = {}
  const top = asArray(container.topAppsContainerIDs) ?? []
  for (let i = 0; i + 1 < top.length; i += 2) {
    const holder = typeof top[i + 1] === 'string' ? items.get(top[i + 1] as string) : undefined
    if (!holder) continue
    const tabs = nodes(holder.childrenIds, 0).filter((n): n is ArcTab => n.kind === 'tab')
    if (tabs.length > 0) favorites[profileKey(top[i])] = tabs
  }
  return { spaces, favorites, unsupported }
}

/** Counts for the confirmation dialog. */
export function summarizeSidebar(sidebar: ArcSidebar): { spaces: number; folders: number; tabs: number; favorites: number } {
  let folders = 0
  let tabs = 0
  const walk = (list: ArcNode[]) => {
    for (const n of list) {
      if (n.kind === 'tab') tabs += 1
      else {
        folders += 1
        walk(n.children)
      }
    }
  }
  const withContent = sidebar.spaces.filter((s) => s.pinned.length > 0)
  for (const s of withContent) walk(s.pinned)
  const favorites = Object.values(sidebar.favorites).reduce((n, list) => n + list.length, 0)
  return { spaces: withContent.length, folders, tabs, favorites }
}

// -- internals ---------------------------------------------------------------

/** [key, value, key, value…] → Map. Keys may be strings or (for `byTag`) single-key tag objects. */
function pairs(list: unknown[], byTag = false): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = list[i]
    const value = list[i + 1]
    if (byTag) {
      // containerIDs: ['pinned', 'ID', …] — the value is the id string.
      if (typeof key === 'string') out.set(key, value as Record<string, unknown>)
      continue
    }
    const object = asObject(value)
    if (typeof key === 'string' && object) out.set(key, object)
  }
  return out
}

function profileKey(spec: unknown): string {
  const custom = asObject(asObject(asObject(spec)?.custom)?._0)
  return typeof custom?.directoryBasename === 'string' ? custom.directoryBasename : 'default'
}

function spaceColor(space: Record<string, unknown>): string | null {
  const palette = asObject(asObject(asObject(space.customInfo)?.windowTheme)?.primaryColorPalette)
  const tone = asObject(palette?.midTone)
  return tone ? arcColor(tone) : null
}

/** { red, green, blue } in extended sRGB (may leave 0–1) → #rrggbb. */
function arcColor(c: Record<string, unknown>): string {
  const channel = (v: unknown) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
    return Math.round(Math.max(0, Math.min(1, n)) * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(c.red)}${channel(c.green)}${channel(c.blue)}`
}

function spaceTheme(space: Record<string, unknown>): ArcTheme | null {
  const background = asObject(asObject(asObject(space.customInfo)?.windowTheme)?.background)
  const style = asObject(asObject(asObject(asObject(asObject(background?.single)?._0)?.style)?.color)?._0)
  const single = asObject(asObject(style?.blendedSingleColor)?._0)
  const gradient = asObject(asObject(style?.blendedGradient)?._0)
  const source = single ?? gradient
  if (!source) return null
  const raw = single ? [single.color] : (asArray(gradient?.baseColors) ?? [])
  const colors = raw
    .map(asObject)
    .filter((c): c is Record<string, unknown> => c !== undefined && c.alpha !== 0)
    .slice(0, 3)
    .map(arcColor)
  if (colors.length === 0) return null
  const modifiers = asObject(source.modifiers)
  const factor = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null)
  return { colors, intensity: factor(modifiers?.intensityFactor), noise: factor(modifiers?.noiseFactor) }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}
