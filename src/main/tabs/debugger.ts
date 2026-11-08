import type { WebContents } from 'electron'

// A WebContents has one `debugger` (one DevTools protocol session) in
// Electron, and detaching it drops whatever its holders set up: device
// emulation, an agent's network log. So the session is shared: each user
// holds it under its own name, and it is detached once nobody holds it.

const holders = new WeakMap<WebContents, Set<string>>()

/** Attach (if needed) and hold the session. Throws when it cannot be attached. */
export function holdDebugger(wc: WebContents, holder: string): void {
  let set = holders.get(wc)
  if (!set) {
    set = new Set()
    holders.set(wc, set)
    // A session that goes away by itself (the page closed) is held by no one.
    wc.debugger.on('detach', () => holders.get(wc)?.clear())
  }
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  set.add(holder)
}

/** Let go of the session; the last holder detaches it. */
export function releaseDebugger(wc: WebContents, holder: string): void {
  const set = holders.get(wc)
  if (!set?.delete(holder) || set.size > 0 || wc.isDestroyed()) return
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach()
  } catch {
    // Already gone.
  }
}

/** Others still use the session (so a holder leaving must undo what it turned on). */
export function debuggerShared(wc: WebContents, holder: string): boolean {
  const set = holders.get(wc)
  return !!set && [...set].some((h) => h !== holder)
}
