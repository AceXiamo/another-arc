// Per-site switches: the site panel offers each one on the sites it exists for.

/** Page preload → main, synchronous: whether a switch is on for the sender's origin. */
export const SITE_SETTING_IPC = 'arc:site-setting'

export const SITE_SETTINGS = {
  /** Genshin Impact's cloud client: see applyCloudGameLatency. */
  cloudGameLowLatency: { origins: ['https://ys.mihoyo.com'] as readonly string[] }
}

export type SiteSettingId = keyof typeof SITE_SETTINGS

export const SITE_SETTING_IDS = Object.keys(SITE_SETTINGS) as SiteSettingId[]

export interface SiteSettingValue {
  id: SiteSettingId
  on: boolean
}

export function isSiteSettingId(value: unknown): value is SiteSettingId {
  return typeof value === 'string' && Object.hasOwn(SITE_SETTINGS, value)
}

export function isOfferedOn(id: SiteSettingId, origin: string): boolean {
  return SITE_SETTINGS[id].origins.includes(origin)
}

// -- cloud game latency -------------------------------------------------------
//
// In a <video>, Chromium's WebRTC jitter buffer climbs to 60ms or more within
// about 90 seconds of connecting, however clean the network is, and pages can
// only raise its floor. The client also has a pipeline that decodes with
// WebCodecs and draws to a canvas, past that buffer (97ms from input to frame
// against 150ms when measured). It only turns that on by A/B test, and its own
// settings pick the pipeline, so this writes those before its scripts run.

const CLOUD_GAME_SETTINGS = 'clgm_web_app_settings_hk4e_cn'
/** What the client had before: its compatibility mode may be the user's own choice. */
const CLOUD_GAME_BACKUP = 'another_arc_cloud_game_backup'
const CLOUD_GAME_OVERRIDES: Record<string, boolean> = {
  compatibleModeSwitch: false,
  hevcCodecSwitch: false,
  wrappedHevcSwitch: true
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function parseObject(text: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '{}')
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Force the canvas pipeline, or put back what the client had before. */
export function applyCloudGameLatency(storage: Store, on: boolean): void {
  const backup = storage.getItem(CLOUD_GAME_BACKUP)
  if (!on && backup === null) return
  const settings = parseObject(storage.getItem(CLOUD_GAME_SETTINGS))
  const keys = Object.keys(CLOUD_GAME_OVERRIDES)
  if (on) {
    if (backup === null) {
      const before = Object.fromEntries(keys.filter((k) => k in settings).map((k) => [k, settings[k]]))
      storage.setItem(CLOUD_GAME_BACKUP, JSON.stringify(before))
    }
    Object.assign(settings, CLOUD_GAME_OVERRIDES)
  } else {
    const before = parseObject(backup)
    for (const k of keys) {
      if (k in before) settings[k] = before[k]
      else delete settings[k]
    }
    storage.removeItem(CLOUD_GAME_BACKUP)
  }
  storage.setItem(CLOUD_GAME_SETTINGS, JSON.stringify(settings))
}
