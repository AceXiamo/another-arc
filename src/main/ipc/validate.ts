// Minimal runtime validators for IPC arguments. Deliberately tiny: the main
// bundle stays small and every check is explicit at the call site.

export class ValidationError extends Error {
  constructor(path: string, expected: string) {
    super(`Invalid IPC argument at ${path}: expected ${expected}`)
  }
}

export type Validator<T> = (value: unknown, path: string) => T

export type Infer<V> = V extends Validator<infer T> ? T : never

export const v = {
  string(opts: { min?: number; max?: number } = {}): Validator<string> {
    const { min = 0, max = 4096 } = opts
    return (value, path) => {
      if (typeof value !== 'string' || value.length < min || value.length > max) {
        throw new ValidationError(path, `string(${min}..${max})`)
      }
      return value
    }
  },

  /** Opaque identifiers (UUIDs, extension ids, download ids). */
  id(): Validator<string> {
    return (value, path) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        throw new ValidationError(path, 'id')
      }
      return value
    }
  },

  number(opts: { int?: boolean; min?: number; max?: number } = {}): Validator<number> {
    const { int = false, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts
    return (value, path) => {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (int && !Number.isInteger(value)) ||
        value < min ||
        value > max
      ) {
        throw new ValidationError(path, `number(${min}..${max})`)
      }
      return value
    }
  },

  boolean(): Validator<boolean> {
    return (value, path) => {
      if (typeof value !== 'boolean') throw new ValidationError(path, 'boolean')
      return value
    }
  },

  oneOf<const T extends readonly (string | number)[]>(values: T): Validator<T[number]> {
    return (value, path) => {
      if (!values.includes(value as T[number])) throw new ValidationError(path, values.join('|'))
      return value as T[number]
    }
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (value, path) => (value === undefined ? undefined : inner(value, path))
  },

  nullable<T>(inner: Validator<T>): Validator<T | null> {
    return (value, path) => (value === null ? null : inner(value, path))
  },

  array<T>(inner: Validator<T>, max = 1000): Validator<T[]> {
    return (value, path) => {
      if (!Array.isArray(value) || value.length > max) throw new ValidationError(path, `array(<=${max})`)
      return value.map((item, i) => inner(item, `${path}[${i}]`))
    }
  },

  object<S extends Record<string, Validator<unknown>>>(shape: S): Validator<{ [K in keyof S]: Infer<S[K]> }> {
    return (value, path) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(path, 'object')
      const raw = value as Record<string, unknown>
      for (const key of Object.keys(raw)) {
        if (!Object.hasOwn(shape, key)) throw new ValidationError(`${path}.${key}`, 'no such field')
      }
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(shape)) {
        const parsed = shape[key]!(raw[key], `${path}.${key}`)
        if (parsed !== undefined) out[key] = parsed
      }
      return out as { [K in keyof S]: Infer<S[K]> }
    }
  },

  /** Plain JSON-ish object; the receiver validates fields itself. */
  record(): Validator<Record<string, unknown>> {
    return (value, path) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(path, 'object')
      return value as Record<string, unknown>
    }
  }
}

/** Validate a positional argument list. */
export function tuple<const V extends readonly Validator<unknown>[]>(
  ...validators: V
): Validator<{ -readonly [K in keyof V]: Infer<V[K]> }> {
  return (value, path) => {
    const args = value as unknown[]
    if (!Array.isArray(args) || args.length > validators.length) {
      throw new ValidationError(path, `${validators.length} arguments`)
    }
    return validators.map((fn, i) => fn(args[i], `${path}[${i}]`)) as { -readonly [K in keyof V]: Infer<V[K]> }
  }
}
