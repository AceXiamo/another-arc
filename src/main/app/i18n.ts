import type { MessageKey, Translate, TranslateParams } from '@shared/i18n'

/** An error whose message is a message key, translated where it is shown. */
export class LocalizedError extends Error {
  constructor(
    readonly key: MessageKey,
    readonly params?: TranslateParams
  ) {
    super(key)
  }
}

export function describeError(error: unknown, t: Translate): string {
  if (error instanceof LocalizedError) return t(error.key, error.params)
  return error instanceof Error ? error.message : String(error)
}
