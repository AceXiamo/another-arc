import { DEFAULT_SPACE } from '@shared/defaults'
import { isHexColor, parseStoredTheme } from '@shared/theme'
import type { Database } from './database'
import type { ExtensionRecord, FolderRecord, NavState, ProfileRecord, SpaceRecord, TabRecord } from './records'

interface TabRow {
  id: string
  space_id: string
  url: string
  title: string
  favicon: string | null
  is_pinned: number
  sort_order: number
  created_at: number
  last_active_at: number
  nav_state: string | null
  zoom: number
  muted: number
  folder_id: string | null
  saved_url: string
  saved_title: string
}

interface FolderRow {
  id: string
  space_id: string
  parent_id: string | null
  name: string
  collapsed: number
  sort_order: number
  created_at: number
}

interface SpaceRow {
  id: string
  name: string
  icon: string
  color: string
  /** JSON (SpaceTheme); NULL before v3. */
  theme: string | null
  sort_order: number
  profile_id: string
  active_tab_id: string | null
  created_at: number
}

interface ExtensionRow {
  id: string
  name: string
  version: string
  path: string
  source_path: string
  enabled: number
  pinned: number
  installed_at: number
}

/** Persistence for browsing session state: profiles, spaces, tabs, settings, extensions. */
export class SessionStore {
  constructor(private readonly db: Database) {}

  // -- profiles ------------------------------------------------------------

  loadProfiles(): ProfileRecord[] {
    return this.db
      .all<{ id: string; name: string; partition: string; created_at: number }>(
        'SELECT id, name, partition, created_at FROM profiles ORDER BY created_at'
      )
      .map((r) => ({ id: r.id, name: r.name, partition: r.partition, createdAt: r.created_at }))
  }

  saveProfile(p: ProfileRecord): void {
    this.db.run(
      `INSERT INTO profiles (id, name, partition, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      p.id,
      p.name,
      p.partition,
      p.createdAt
    )
  }

  // -- spaces --------------------------------------------------------------

  loadSpaces(): SpaceRecord[] {
    return this.db.all<SpaceRow>('SELECT * FROM spaces ORDER BY sort_order').map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      color: isHexColor(r.color) ? r.color : DEFAULT_SPACE.color,
      theme: parseStoredTheme(r.theme),
      sortOrder: r.sort_order,
      profileId: r.profile_id,
      activeTabId: r.active_tab_id,
      createdAt: r.created_at
    }))
  }

  saveSpace(s: SpaceRecord): void {
    this.db.run(
      `INSERT INTO spaces (id, name, icon, color, theme, sort_order, profile_id, active_tab_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, icon = excluded.icon, color = excluded.color, theme = excluded.theme,
         sort_order = excluded.sort_order, profile_id = excluded.profile_id,
         active_tab_id = excluded.active_tab_id`,
      s.id,
      s.name,
      s.icon,
      s.color,
      JSON.stringify(s.theme),
      s.sortOrder,
      s.profileId,
      s.activeTabId,
      s.createdAt
    )
  }

  deleteSpace(id: string): void {
    this.db.run('DELETE FROM spaces WHERE id = ?', id)
  }

  // -- tabs ----------------------------------------------------------------

  loadTabs(): TabRecord[] {
    return this.db
      .all<TabRow>('SELECT * FROM tabs ORDER BY space_id, is_pinned DESC, sort_order')
      .map((r) => ({
        id: r.id,
        spaceId: r.space_id,
        url: r.url,
        title: r.title,
        favicon: r.favicon,
        pinned: r.is_pinned === 1,
        sortOrder: r.sort_order,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        navState: parseNavState(r.nav_state),
        zoom: r.zoom,
        muted: r.muted === 1,
        folderId: r.folder_id,
        savedUrl: r.saved_url,
        savedTitle: r.saved_title
      }))
  }

  saveTab(t: TabRecord): void {
    this.db.run(
      `INSERT INTO tabs (id, space_id, url, title, favicon, is_pinned, sort_order, created_at,
                         last_active_at, nav_state, zoom, muted, folder_id, saved_url, saved_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         space_id = excluded.space_id, url = excluded.url, title = excluded.title,
         favicon = excluded.favicon, is_pinned = excluded.is_pinned,
         sort_order = excluded.sort_order, last_active_at = excluded.last_active_at,
         nav_state = excluded.nav_state, zoom = excluded.zoom, muted = excluded.muted,
         folder_id = excluded.folder_id, saved_url = excluded.saved_url, saved_title = excluded.saved_title`,
      t.id,
      t.spaceId,
      t.url,
      t.title,
      t.favicon,
      t.pinned ? 1 : 0,
      t.sortOrder,
      t.createdAt,
      t.lastActiveAt,
      t.navState ? JSON.stringify(t.navState) : null,
      t.zoom,
      t.muted ? 1 : 0,
      t.folderId,
      t.savedUrl,
      t.savedTitle
    )
  }

  deleteTab(id: string): void {
    this.db.run('DELETE FROM tabs WHERE id = ?', id)
  }

  // -- folders -------------------------------------------------------------

  loadFolders(): FolderRecord[] {
    return this.db.all<FolderRow>('SELECT * FROM folders ORDER BY space_id, sort_order').map((r) => ({
      id: r.id,
      spaceId: r.space_id,
      parentId: r.parent_id,
      name: r.name,
      collapsed: r.collapsed === 1,
      sortOrder: r.sort_order,
      createdAt: r.created_at
    }))
  }

  saveFolder(f: FolderRecord): void {
    this.db.run(
      `INSERT INTO folders (id, space_id, parent_id, name, collapsed, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         space_id = excluded.space_id, parent_id = excluded.parent_id, name = excluded.name,
         collapsed = excluded.collapsed, sort_order = excluded.sort_order`,
      f.id,
      f.spaceId,
      f.parentId,
      f.name,
      f.collapsed ? 1 : 0,
      f.sortOrder,
      f.createdAt
    )
  }

  deleteFolder(id: string): void {
    this.db.run('DELETE FROM folders WHERE id = ?', id)
  }

  // -- settings ------------------------------------------------------------

  loadSettings(): Map<string, unknown> {
    const out = new Map<string, unknown>()
    for (const row of this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      try {
        out.set(row.key, JSON.parse(row.value))
      } catch {
        // Ignore corrupt values; defaults apply.
      }
    }
    return out
  }

  saveSetting(key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value)
    )
  }

  // -- extensions ----------------------------------------------------------

  loadExtensions(): ExtensionRecord[] {
    return this.db.all<ExtensionRow>('SELECT * FROM extensions ORDER BY installed_at').map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      path: r.path,
      sourcePath: r.source_path,
      enabled: r.enabled === 1,
      pinned: r.pinned === 1,
      installedAt: r.installed_at
    }))
  }

  saveExtension(e: ExtensionRecord): void {
    this.db.run(
      `INSERT INTO extensions (id, name, version, path, source_path, enabled, pinned, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, version = excluded.version, path = excluded.path,
         source_path = excluded.source_path, enabled = excluded.enabled, pinned = excluded.pinned`,
      e.id,
      e.name,
      e.version,
      e.path,
      e.sourcePath,
      e.enabled ? 1 : 0,
      e.pinned ? 1 : 0,
      e.installedAt
    )
  }

  deleteExtension(id: string): void {
    this.db.run('DELETE FROM extensions WHERE id = ?', id)
  }
}

function parseNavState(raw: string | null): NavState | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as NavState
    if (!Array.isArray(parsed.entries) || typeof parsed.index !== 'number') return null
    return parsed
  } catch {
    return null
  }
}
