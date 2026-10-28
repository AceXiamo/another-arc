import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

/**
 * Thin wrapper around Node's built-in synchronous SQLite binding. Using
 * `node:sqlite` (bundled with Electron's Node) avoids native module rebuilds
 * and keeps cold start fast. All statements are prepared once and cached.
 */
export class Database {
  readonly raw: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()

  constructor(path: string) {
    this.raw = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -8000;
      PRAGMA busy_timeout = 2000;
    `)
    migrate(this.raw)
  }

  stmt(sql: string): StatementSync {
    let s = this.statements.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.statements.set(sql, s)
    }
    return s
  }

  /** False once closed; late writers (e.g. a download finishing during quit) become no-ops. */
  get isOpen(): boolean {
    return this.raw.isOpen
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    if (!this.raw.isOpen) return
    this.stmt(sql).run(...params)
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    if (!this.raw.isOpen) return undefined
    return this.stmt(sql).get(...params) as T | undefined
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    if (!this.raw.isOpen) return []
    return this.stmt(sql).all(...params) as T[]
  }

  /** Runs `fn` inside a transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (!this.raw.isOpen || this.raw.isTransaction) return fn()
    this.raw.exec('BEGIN')
    try {
      const result = fn()
      this.raw.exec('COMMIT')
      return result
    } catch (error) {
      this.raw.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.statements.clear()
    if (this.raw.isOpen) {
      // Fold the WAL back into the main file so the next launch opens fast.
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      this.raw.close()
    }
  }
}

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    partition TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    profile_id TEXT NOT NULL REFERENCES profiles(id),
    active_tab_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE tabs (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    favicon TEXT,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    nav_state TEXT,
    zoom REAL NOT NULL DEFAULT 1,
    muted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tabs_by_space ON tabs(space_id, is_pinned, sort_order);

  CREATE TABLE extensions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    path TEXT NOT NULL,
    source_path TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 1,
    installed_at INTEGER NOT NULL
  );

  CREATE TABLE history_urls (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    visit_count INTEGER NOT NULL DEFAULT 0,
    typed_count INTEGER NOT NULL DEFAULT 0,
    last_visit_at INTEGER NOT NULL
  );
  CREATE INDEX history_urls_recent ON history_urls(last_visit_at DESC);

  CREATE TABLE visits (
    id INTEGER PRIMARY KEY,
    url_id INTEGER NOT NULL REFERENCES history_urls(id) ON DELETE CASCADE,
    visited_at INTEGER NOT NULL
  );
  CREATE INDEX visits_recent ON visits(visited_at DESC);
  CREATE INDEX visits_by_url ON visits(url_id);

  -- Trigram index: substring search over url/title for omnibox suggestions.
  CREATE VIRTUAL TABLE history_fts USING fts5(
    url, title, content='history_urls', content_rowid='id', tokenize='trigram'
  );
  CREATE TRIGGER history_urls_ai AFTER INSERT ON history_urls BEGIN
    INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
  END;
  CREATE TRIGGER history_urls_ad AFTER DELETE ON history_urls BEGIN
    INSERT INTO history_fts(history_fts, rowid, url, title) VALUES ('delete', old.id, old.url, old.title);
  END;
  CREATE TRIGGER history_urls_au AFTER UPDATE OF url, title ON history_urls BEGIN
    INSERT INTO history_fts(history_fts, rowid, url, title) VALUES ('delete', old.id, old.url, old.title);
    INSERT INTO history_fts(rowid, url, title) VALUES (new.id, new.url, new.title);
  END;

  CREATE TABLE favicons (
    url TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE site_permissions (
    origin TEXT NOT NULL,
    permission TEXT NOT NULL,
    decision TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (origin, permission)
  );

  CREATE TABLE downloads (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    filename TEXT NOT NULL,
    save_path TEXT NOT NULL,
    status TEXT NOT NULL,
    received_bytes INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  `,
  // v2 — sidebar folders (saved tabs)
  `
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    parent_id TEXT,
    name TEXT NOT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX folders_by_space ON folders(space_id);

  ALTER TABLE tabs ADD COLUMN folder_id TEXT;
  ALTER TABLE tabs ADD COLUMN saved_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE tabs ADD COLUMN saved_title TEXT NOT NULL DEFAULT '';
  `,
  // v3 — space themes (gradient, intensity, grain, appearance) as JSON;
  // NULL = the defaults (spaces saved before v3). Sanitized on load.
  `
  ALTER TABLE spaces ADD COLUMN theme TEXT;
  `,
  // v4 — saved logins. `password` holds safeStorage ciphertext, never text:
  // the row is worthless without the login keychain. One credential per
  // (origin, username), so saving the same sign-in again updates it.
  `
  CREATE TABLE logins (
    id TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    username TEXT NOT NULL,
    password BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    times_used INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX logins_by_origin_user ON logins(origin, username);
  `,
  // v5 — the favicon a history page last showed (a key into `favicons`).
  `
  ALTER TABLE history_urls ADD COLUMN favicon TEXT;
  `,
  // v6 — chrome.downloads: a stable integer id per download (extensions keep
  // ids across restarts) and the extension that started it, if any.
  `
  ALTER TABLE downloads ADD COLUMN seq INTEGER;
  ALTER TABLE downloads ADD COLUMN initiator TEXT;
  UPDATE downloads SET seq = rowid;
  `
]

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = row.user_version
  while (version < MIGRATIONS.length) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version]!)
      version += 1
      db.exec(`PRAGMA user_version = ${version}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length
