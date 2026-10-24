import { performance } from 'node:perf_hooks'

// Startup timeline. performance.now() counts from process start, so the
// first mark already includes Electron's own boot.
const marks: Record<string, number> = {}

export function mark(name: string): void {
  marks[name] ??= Math.round(performance.now())
}

export function startupMarks(): Record<string, number> {
  return { ...marks }
}
