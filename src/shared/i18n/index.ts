// UI strings for every part of the app (main-process menus and dialogs as
// well as the shell). English is the source of truth: each zh-CN module is
// typed against its English twin, so a missing translation fails the build.
//
// Keys are namespaced by module (`sidebar.*`, `palette.*`, …) and live in
// one file per module so modules can be translated independently.
// Placeholders use `{name}` and are filled by `translate`.
import enCommon from './locales/en/common'
import enExtImport from './locales/en/ext-import'
import enMain from './locales/en/main'
import enShellPages from './locales/en/shell-pages'
import enShellPalette from './locales/en/shell-palette'
import enShellSettings from './locales/en/shell-settings'
import enShellSidebar from './locales/en/shell-sidebar'
import zhCommon from './locales/zh-CN/common'
import zhExtImport from './locales/zh-CN/ext-import'
import zhMain from './locales/zh-CN/main'
import zhShellPages from './locales/zh-CN/shell-pages'
import zhShellPalette from './locales/zh-CN/shell-palette'
import zhShellSettings from './locales/zh-CN/shell-settings'
import zhShellSidebar from './locales/zh-CN/shell-sidebar'

export const LOCALES = [
  { id: 'en', name: 'English' },
  { id: 'zh-CN', name: '简体中文' }
] as const

export type Locale = (typeof LOCALES)[number]['id']

export const DEFAULT_LOCALE: Locale = 'en'

const en = {
  ...enCommon,
  ...enMain,
  ...enShellSidebar,
  ...enShellPalette,
  ...enShellSettings,
  ...enShellPages,
  ...enExtImport
}

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
export type TranslateParams = Record<string, string | number>
export type Translate = (key: MessageKey, params?: TranslateParams) => string

const zhCN: Messages = {
  ...zhCommon,
  ...zhMain,
  ...zhShellSidebar,
  ...zhShellPalette,
  ...zhShellSettings,
  ...zhShellPages,
  ...zhExtImport
}

const DICTIONARIES: Record<Locale, Messages> = { en, 'zh-CN': zhCN }

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.id === value)
}

export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const text = DICTIONARIES[locale]?.[key] ?? en[key] ?? key
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** A `t()` bound to one locale. */
export function translator(locale: Locale): Translate {
  return (key, params) => translate(locale, key, params)
}
