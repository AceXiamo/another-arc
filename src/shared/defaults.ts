import { DEFAULT_LOCALE, type MessageKey } from './i18n'
import { LAYOUT } from './layout'
import type { Settings, WindowState } from './types'

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  customSearchUrl: '',
  downloadAskWhere: false,
  downloadDir: '',
  discardAfterMinutes: 30,
  memoryBudgetMB: 0,
  theme: 'system',
  language: DEFAULT_LOCALE
}

export const DEFAULT_WINDOW_STATE: Omit<WindowState, 'activeSpaceId'> = {
  sidebarWidth: LAYOUT.sidebarDefault,
  sidebarCollapsed: false,
  fullscreen: false,
  htmlFullscreen: false,
  focused: true
}

/** Palette offered when creating a space. */
export const SPACE_COLORS = [
  '#7c6cf2',
  '#3b82f6',
  '#14b8a6',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#64748b'
] as const

/**
 * Space icons (generated artwork in src/renderer/public/space-icons). A
 * space stores the id; unknown values are shown as plain text for older data.
 * `label` is a message key.
 */
export const SPACE_ICONS = [
  { id: 'home', label: 'spaceIcon.home' },
  { id: 'work', label: 'spaceIcon.work' },
  { id: 'code', label: 'spaceIcon.code' },
  { id: 'book', label: 'spaceIcon.book' },
  { id: 'game', label: 'spaceIcon.game' },
  { id: 'design', label: 'spaceIcon.design' },
  { id: 'shopping', label: 'spaceIcon.shopping' },
  { id: 'travel', label: 'spaceIcon.travel' },
  { id: 'music', label: 'spaceIcon.music' },
  { id: 'finance', label: 'spaceIcon.finance' },
  { id: 'heart', label: 'spaceIcon.heart' },
  { id: 'camera', label: 'spaceIcon.camera' },
  { id: 'chat', label: 'spaceIcon.chat' },
  { id: 'video', label: 'spaceIcon.video' },
  { id: 'lab', label: 'spaceIcon.lab' },
  { id: 'star', label: 'spaceIcon.star' }
] as const satisfies ReadonlyArray<{ id: string; label: MessageKey }>

export type SpaceIconId = (typeof SPACE_ICONS)[number]['id']

export function isSpaceIconId(value: string): value is SpaceIconId {
  return SPACE_ICONS.some((i) => i.id === value)
}

/** First space created on a fresh profile; its name is localized at creation. */
export const DEFAULT_SPACE = { nameKey: 'space.defaultName', icon: 'home', color: SPACE_COLORS[0] } as const

export const DEFAULT_PROFILE_ID = 'default'

/** Upper bounds that keep persisted state small. */
export const LIMITS = {
  closedTabs: 25,
  navEntriesPerTab: 50,
  spaceName: 40,
  spaceIcon: 32,
  folderName: 60,
  urlLength: 1 << 16
} as const
