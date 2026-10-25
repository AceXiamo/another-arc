import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IMPORTABLE_URL, MAX_DEPTH, type ArcNode, type ArcSidebar } from './arc-sidebar'

// Chromium's `Bookmarks` file — every browser here except Arc, which keeps
// its own sidebar instead. The result is the same shape Arc's sidebar parses
// to, so one importer places both (see sidebar-import.ts).
//
// The three roots become one unnamed space, which lands in the profile's
// first space: the bookmarks bar at the top level, then "Other bookmarks"
// and "Mobile bookmarks" as folders when they hold anything. Their names
// come from the file, already in the language that browser created them in.

export function chromiumBookmarksPath(profileDir: string): string {
  return join(profileDir, 'Bookmarks')
}

export async function readChromiumBookmarks(path: string): Promise<ArcSidebar | null> {
  try {
    return parseChromiumBookmarks(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export function parseChromiumBookmarks(json: unknown): ArcSidebar | null {
  const roots = asObject(asObject(json)?.roots)
  if (!roots) return null
  let unsupported = 0

  const nodes = (raw: unknown, depth: number): ArcNode[] => {
    const out: ArcNode[] = []
    if (!Array.isArray(raw) || depth > MAX_DEPTH) return out
    for (const entry of raw) {
      const node = asObject(entry)
      if (!node) continue
      const title = typeof node.name === 'string' ? node.name.trim() : ''
      if (node.type === 'folder' || Array.isArray(node.children)) {
        const children = nodes(node.children, depth + 1)
        if (children.length > 0) out.push({ kind: 'folder', title: title || 'Folder', children })
        continue
      }
      const url = typeof node.url === 'string' ? node.url : ''
      // javascript: bookmarklets, chrome://settings and the like.
      if (!IMPORTABLE_URL.test(url)) {
        unsupported += 1
        continue
      }
      out.push({ kind: 'tab', url, title: title || url })
    }
    return out
  }

  const root = (key: string): { name: string; children: ArcNode[] } => {
    const value = asObject(roots[key])
    const name = typeof value?.name === 'string' && value.name.trim() ? value.name.trim() : key
    return { name, children: nodes(value?.children, 0) }
  }

  const bar = root('bookmark_bar')
  const pinned = [...bar.children]
  for (const key of ['other', 'synced']) {
    const { name, children } = root(key)
    if (children.length > 0) pinned.push({ kind: 'folder', title: name, children })
  }
  if (pinned.length === 0) return null

  return {
    spaces: [{ id: 'bookmarks', title: null, color: null, theme: null, profile: 'default', pinned, todayCount: 0 }],
    favorites: {},
    unsupported
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
