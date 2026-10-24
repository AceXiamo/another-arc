import type { Persister } from '../persistence/persister'

/** Chrome's zoom steps. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const

export function nextZoomFactor(current: number, delta: -1 | 0 | 1): number {
  if (delta === 0) return 1
  if (delta > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i]! < current - 0.001) return ZOOM_STEPS[i]!
  }
  return ZOOM_STEPS[0]
}

const KEY = 'zoom.hosts'

/** Per-host zoom, persisted (Chromium only keeps it for the session). */
export class ZoomStore {
  private readonly hosts: Map<string, number>

  constructor(
    stored: unknown,
    private readonly persister: Persister
  ) {
    this.hosts = new Map()
    if (stored && typeof stored === 'object') {
      for (const [host, factor] of Object.entries(stored as Record<string, unknown>)) {
        if (typeof factor === 'number' && factor > 0) this.hosts.set(host, factor)
      }
    }
  }

  get(url: string): number {
    const host = hostOf(url)
    return (host && this.hosts.get(host)) || 1
  }

  set(url: string, factor: number): void {
    const host = hostOf(url)
    if (!host) return
    if (Math.abs(factor - 1) < 0.001) this.hosts.delete(host)
    else this.hosts.set(host, factor)
    this.persister.setSetting(KEY, Object.fromEntries(this.hosts))
  }
}

export const ZOOM_SETTINGS_KEY = KEY

function hostOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null
  } catch {
    return null
  }
}
