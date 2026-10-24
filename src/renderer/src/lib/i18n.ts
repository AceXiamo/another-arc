import { useMemo } from 'react'
import { translator, type Locale, type Translate } from '@shared/i18n'
import { useBrowser } from '../stores/browser'

export function useLocale(): Locale {
  return useBrowser((s) => s.settings.language)
}

/**
 * `t()` for components. Only components that call it re-render when the
 * language changes.
 */
export function useT(): Translate {
  const locale = useLocale()
  return useMemo(() => translator(locale), [locale])
}

/** `t()` outside React (event handlers, module-level helpers). */
export function getT(): Translate {
  return translator(useBrowser.getState().settings.language)
}
