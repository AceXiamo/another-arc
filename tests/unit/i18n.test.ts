import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, isLocale, LOCALES, translate, type MessageKey } from '@shared/i18n'
import enCommon from '@shared/i18n/locales/en/common'
import enExtImport from '@shared/i18n/locales/en/ext-import'
import enTheme from '@shared/i18n/locales/en/theme'
import enMain from '@shared/i18n/locales/en/main'
import enShellPages from '@shared/i18n/locales/en/shell-pages'
import enShellPalette from '@shared/i18n/locales/en/shell-palette'
import enShellSettings from '@shared/i18n/locales/en/shell-settings'
import enShellSidebar from '@shared/i18n/locales/en/shell-sidebar'
import zhCommon from '@shared/i18n/locales/zh-CN/common'
import zhExtImport from '@shared/i18n/locales/zh-CN/ext-import'
import zhTheme from '@shared/i18n/locales/zh-CN/theme'
import zhMain from '@shared/i18n/locales/zh-CN/main'
import zhShellPages from '@shared/i18n/locales/zh-CN/shell-pages'
import zhShellPalette from '@shared/i18n/locales/zh-CN/shell-palette'
import zhShellSettings from '@shared/i18n/locales/zh-CN/shell-settings'
import zhShellSidebar from '@shared/i18n/locales/zh-CN/shell-sidebar'

const EN: Record<string, Record<string, string>> = {
  common: enCommon,
  main: enMain,
  'shell-sidebar': enShellSidebar,
  'shell-palette': enShellPalette,
  'shell-settings': enShellSettings,
  'shell-pages': enShellPages,
  'ext-import': enExtImport,
  theme: enTheme
}
const ZH: Record<string, Record<string, string>> = {
  common: zhCommon,
  main: zhMain,
  'shell-sidebar': zhShellSidebar,
  'shell-palette': zhShellPalette,
  'shell-settings': zhShellSettings,
  'shell-pages': zhShellPages,
  'ext-import': zhExtImport,
  theme: zhTheme
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('i18n dictionaries', () => {
  it('module files never define the same key twice (spreads would silently override)', () => {
    const seen = new Map<string, string>()
    for (const [file, dict] of Object.entries(EN)) {
      for (const key of Object.keys(dict)) {
        expect(seen.get(key), `${key} in ${file} and ${seen.get(key)}`).toBeUndefined()
        seen.set(key, file)
      }
    }
  })

  it('zh-CN has exactly the English keys, with the same placeholders and no empty values', () => {
    for (const [file, en] of Object.entries(EN)) {
      const zh = ZH[file]!
      expect(Object.keys(zh).sort(), file).toEqual(Object.keys(en).sort())
      for (const key of Object.keys(en)) {
        expect(zh[key]!.trim(), key).not.toBe('')
        expect(placeholders(zh[key]!), key).toEqual(placeholders(en[key]!))
      }
    }
  })
})

describe('translate', () => {
  it('defaults to English and fills placeholders', () => {
    expect(DEFAULT_LOCALE).toBe('en')
    expect(translate('en', 'menu.tabN', { n: 3 })).toBe('Tab 3')
    expect(translate('zh-CN', 'menu.tabN', { n: 3 })).toBe('标签页 3')
    expect(translate('en', 'dialog.deleteSpace.title', { name: 'Work' })).toBe('Delete space “Work”?')
  })

  it('leaves unknown placeholders intact and falls back to the key', () => {
    expect(translate('en', 'menu.tabN')).toBe('Tab {n}')
    expect(translate('en', 'nope.missing' as MessageKey)).toBe('nope.missing')
  })

  it('validates locale ids', () => {
    for (const l of LOCALES) expect(isLocale(l.id)).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })
})
