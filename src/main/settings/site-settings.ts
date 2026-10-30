import { ipcMain } from 'electron'
import {
  isOfferedOn,
  isSiteSettingId,
  SITE_SETTING_IDS,
  SITE_SETTING_IPC,
  type SiteSettingId,
  type SiteSettingValue
} from '@shared/site-settings'
import type { Database } from '../persistence/database'

/** Per-site switches, in SQLite and read from memory: pages ask while they load. */
export class SiteSettings {
  private readonly enabled = new Set<string>()

  constructor(private readonly db: Database) {
    for (const r of db.all<{ origin: string; setting: string }>('SELECT origin, setting FROM site_settings')) {
      this.enabled.add(key(r.origin, r.setting))
    }
    ipcMain.on(SITE_SETTING_IPC, (event, id: unknown) => {
      // The frame's own origin, never one the page could claim.
      const origin = event.senderFrame?.origin
      event.returnValue = origin !== undefined && isSiteSettingId(id) && this.isOn(origin, id)
    })
  }

  isOn(origin: string, id: SiteSettingId): boolean {
    return this.enabled.has(key(origin, id))
  }

  /** The switches this site is offered. */
  list(origin: string): SiteSettingValue[] {
    return SITE_SETTING_IDS.filter((id) => isOfferedOn(id, origin)).map((id) => ({ id, on: this.isOn(origin, id) }))
  }

  set(origin: string, id: SiteSettingId, on: boolean): void {
    if (!isOfferedOn(id, origin)) return
    if (on) {
      this.enabled.add(key(origin, id))
      this.db.run(
        'INSERT INTO site_settings (origin, setting, updated_at) VALUES (?, ?, ?) ON CONFLICT(origin, setting) DO UPDATE SET updated_at = excluded.updated_at',
        origin,
        id,
        Date.now()
      )
    } else {
      this.enabled.delete(key(origin, id))
      this.db.run('DELETE FROM site_settings WHERE origin = ? AND setting = ?', origin, id)
    }
  }
}

function key(origin: string, id: string): string {
  return `${origin}|${id}`
}
