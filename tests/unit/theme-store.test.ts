import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SPACE_THEME } from '@shared/theme'
import { Database, SCHEMA_VERSION } from '../../src/main/persistence/database'
import { SessionStore } from '../../src/main/persistence/session-store'

const dirs: string[] = []
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-theme-db-'))
  dirs.push(dir)
  return join(dir, 'browser.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const space = {
  id: 's1',
  name: 'Work',
  icon: 'work',
  color: '#3b82f6',
  sortOrder: 0,
  profileId: 'default',
  activeTabId: null,
  createdAt: 1
}

describe('space theme persistence', () => {
  it('migrates a v2 database: existing spaces get the default theme', () => {
    const path = dbPath()
    // Build a v2 profile: the full schema minus everything after v2, with a
    // space saved back then.
    const old = new Database(path)
    old.raw.exec(`
      ALTER TABLE spaces DROP COLUMN theme;
      DROP TABLE logins;
      ALTER TABLE history_urls DROP COLUMN favicon;
      PRAGMA user_version = 2;
      INSERT INTO profiles (id, name, partition, created_at) VALUES ('default', 'Default', 'persist:default', 0);
      INSERT INTO spaces (id, name, icon, color, sort_order, profile_id, active_tab_id, created_at)
        VALUES ('s1', 'Work', 'work', '#3b82f6', 0, 'default', NULL, 1);
    `)
    old.close()

    const db = new Database(path)
    try {
      expect((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
      expect(SCHEMA_VERSION).toBe(5)
      const [loaded] = new SessionStore(db).loadSpaces()
      expect(loaded).toMatchObject({ id: 's1', color: '#3b82f6', theme: DEFAULT_SPACE_THEME })
    } finally {
      db.close()
    }
  })

  it('round-trips a theme and sanitizes what it reads back', () => {
    const db = new Database(dbPath())
    try {
      const store = new SessionStore(db)
      db.run(`INSERT INTO profiles (id, name, partition, created_at) VALUES ('default', 'Default', 'persist:default', 0)`)
      const theme = { gradient: ['#ff0000', '#00ff00'], angle: 45, intensity: 90, noise: 70, appearance: 'dark' as const }
      store.saveSpace({ ...space, theme })
      expect(store.loadSpaces()[0]!.theme).toEqual(theme)

      // A hand-edited or corrupt row never reaches the model unsanitized.
      db.run(`UPDATE spaces SET theme = ? WHERE id = 's1'`, JSON.stringify({ gradient: ['x', '#ABCDEF'], intensity: 900, appearance: 'neon' }))
      expect(store.loadSpaces()[0]!.theme).toEqual({ ...DEFAULT_SPACE_THEME, gradient: ['#abcdef'], intensity: 100 })
      db.run(`UPDATE spaces SET theme = '{nope', color = 'red' WHERE id = 's1'`)
      expect(store.loadSpaces()[0]).toMatchObject({ theme: DEFAULT_SPACE_THEME, color: '#7c6cf2' })
    } finally {
      db.close()
    }
  })
})
