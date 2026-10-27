// The USER_SCRIPT world of chrome.userScripts, shared by main (which writes
// the script files, see src/main/extensions/user-scripts.ts) and the page
// preload (which runs them, see src/preload/user-script-world.ts).
//
// Chrome runs user scripts in a world of their own whose CSP the extension
// sets (configureWorld): Tampermonkey turns on 'unsafe-eval' and
// 'unsafe-inline' there and evaluates scripts with them. Electron can only
// register content scripts for the extension's isolated world, whose MV3 CSP
// forbids both. So each user script is a native content script (Chromium
// keeps doing the timing and the frames) that hands its code to the page
// preload, which runs it in a world it creates with the configured CSP:
//
//   isolated world                      preload                user script world
//   bridge ── HELLO (document_start) ──▶ learns the channel
//   script ── run(world, code) ────────▶ creates the world ──▶ code runs (synchronously)
//   bridge ◀──── send / connect ─────── chrome.runtime ◀──── sendMessage / connect
//      └─ native chrome.runtime ▶ the extension (onUserScriptMessage / onUserScriptConnect)
//
// The channel's name is random and announced at document_start, before any
// page script runs, so a page can neither listen in nor talk on it. Where
// the preload does not run (subframes), the script runs in the isolated
// world as before: everything but eval and inline scripts works there.

/** Announced by the bridge once per document and extension. */
export const HELLO_EVENT = 'arc-user-script-world'

/** Per-world properties (chrome.userScripts.WorldProperties without the id). */
export interface WorldConfig {
  csp?: string
  messaging?: boolean
}

/** What the bridge announces. */
export interface WorldHello {
  ext: string
  channel: string
  /** World id ('' for the default world) → properties. */
  worlds: Record<string, WorldConfig>
}

/** Messages on the channel: `up` from the isolated world, `down` to it. */
export type UpMessage =
  | { op: 'run'; world: string; code: string }
  | { op: 'reply'; id: number; response?: unknown; error?: string }
  | { op: 'portMessage'; port: number; message: unknown }
  | { op: 'portClosed'; port: number; error?: string }

export type DownMessage =
  | { op: 'send'; id: number; message: unknown }
  | { op: 'connect'; port: number; name: string }
  | { op: 'post'; port: number; message: unknown }
  | { op: 'disconnect'; port: number }

export function channelEvents(channel: string): { up: string; down: string } {
  return { up: `arc-usw-${channel}:up`, down: `arc-usw-${channel}:down` }
}

/** Chrome's default USER_SCRIPT world CSP: the isolated world's (MV3). */
export const DEFAULT_WORLD_CSP = "script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules'; object-src 'self';"

/**
 * Source of the bridge, run in the extension's isolated world before its
 * user scripts. It defines `__arcUSB(world, code)`: true when the preload
 * ran the code in the user script world, false when the caller should run
 * it itself. Idempotent: every script file starts with it.
 */
export function bridgeSource(worlds: Record<string, WorldConfig>): string {
  return `(${bridge.toString()})(${JSON.stringify(HELLO_EVENT)}, ${JSON.stringify(worlds)});\n`
}

/** A USER_SCRIPT world script file: run in the user script world, else here. */
export function wrapForWorld(bridge: string, world: string, code: string): string {
  return `${bridge}if (!globalThis.__arcUSB(${JSON.stringify(world)}, ${JSON.stringify(code)})) {\n${code}\n}\n`
}

/* eslint-disable */
// Runs in the extension's isolated world (Chromium content script). Self-contained.
function bridge(hello: string, worlds: Record<string, WorldConfig>): void {
  const g = globalThis as any
  if (g.__arcUSB) return
  // Through globalThis: this file also compiles for main, which has no DOM types.
  const document = g.document
  const CustomEvent = g.CustomEvent
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const channel = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  const up = `arc-usw-${channel}:up`
  const down = `arc-usw-${channel}:down`
  const chrome = g.chrome
  const present = !document.dispatchEvent(
    new CustomEvent(hello, { cancelable: true, detail: { ext: chrome.runtime.id, channel, worlds } })
  )
  if (!present) {
    g.__arcUSB = () => false
    return
  }
  const send = (detail: unknown) => document.dispatchEvent(new CustomEvent(up, { detail }))
  const ports = new Map<number, any>()
  document.addEventListener(
    down,
    (event: any) => {
      event.stopImmediatePropagation()
      const d = event.detail
      if (!d || typeof d !== 'object') return
      if (d.op === 'send') {
        chrome.runtime.sendMessage(d.message).then(
          (response: unknown) => send({ op: 'reply', id: d.id, response }),
          (error: any) => send({ op: 'reply', id: d.id, error: String(error?.message ?? error) })
        )
      } else if (d.op === 'connect') {
        const port = chrome.runtime.connect({ name: d.name })
        ports.set(d.port, port)
        port.onMessage.addListener((message: unknown) => send({ op: 'portMessage', port: d.port, message }))
        port.onDisconnect.addListener(() => {
          ports.delete(d.port)
          send({ op: 'portClosed', port: d.port, error: chrome.runtime.lastError?.message })
        })
      } else if (d.op === 'post') {
        ports.get(d.port)?.postMessage(d.message)
      } else if (d.op === 'disconnect') {
        ports.get(d.port)?.disconnect()
        ports.delete(d.port)
      }
    },
    true
  )
  g.__arcUSB = (world: string, code: string) =>
    !document.dispatchEvent(new CustomEvent(up, { cancelable: true, detail: { op: 'run', world, code } }))
}

/**
 * chrome.runtime in the user script world (when the world has messaging),
 * built on what the preload exposes there. Source run in that world.
 */
export const RUNTIME_SHIM = `(${runtimeShim.toString()})();\n`

function runtimeShim(): void {
  const g = globalThis as any
  const api = g.__arcUserScriptRuntime
  try {
    delete g.__arcUserScriptRuntime
  } catch {}
  if (!api) return
  const fires = new WeakMap<object, (...args: unknown[]) => void>()
  const event = () => {
    const listeners = new Set<(...args: unknown[]) => void>()
    const e = {
      addListener: (fn: any) => void (typeof fn === 'function' && listeners.add(fn)),
      removeListener: (fn: any) => void listeners.delete(fn),
      hasListener: (fn: any) => listeners.has(fn),
      hasListeners: () => listeners.size > 0
    }
    fires.set(e, (...args) => {
      for (const fn of [...listeners]) {
        try {
          fn(...args)
        } catch (error) {
          console.error(error)
        }
      }
    })
    return e
  }
  let lastError: { message: string } | undefined
  const withError = (message: string | undefined, fn: () => void) => {
    lastError = message ? { message } : undefined
    try {
      fn()
    } finally {
      lastError = undefined
    }
  }
  const runtime = {
    id: api.id,
    get lastError() {
      return lastError
    },
    getURL: (path: unknown) => `chrome-extension://${api.id}/${String(path).replace(/^\//, '')}`,
    // sendMessage([extensionId,] message [, options] [, callback]): only to its own extension here.
    sendMessage(...args: any[]) {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
      const message = args.length > 1 && args[0] === api.id ? args[1] : args[0]
      const p: Promise<unknown> = api.sendMessage(message)
      if (!cb) return p
      p.then(
        (r) => withError(undefined, () => cb(r)),
        (e: any) => withError(String(e?.message ?? e), () => cb())
      )
      return undefined
    },
    // connect([extensionId,] [connectInfo])
    connect(...args: any[]) {
      const info = typeof args[0] === 'string' ? args[1] : args[0]
      const name = info && typeof info === 'object' && info.name !== undefined ? String(info.name) : ''
      const onMessage = event()
      const onDisconnect = event()
      let open = true
      const port: any = {
        name,
        onMessage,
        onDisconnect,
        postMessage(message: unknown) {
          if (!open) throw new Error('Attempting to use a disconnected port object')
          api.post(id, message)
        },
        disconnect() {
          if (!open) return
          open = false
          api.disconnect(id)
        }
      }
      const id = api.connect(
        name,
        (message: unknown) => fires.get(onMessage)!(message, port),
        (error: string | undefined) => {
          if (!open) return
          open = false
          withError(error, () => fires.get(onDisconnect)!(port))
        }
      )
      return port
    },
    // Not delivered to user scripts in Chrome either; there so feature checks pass.
    onMessage: event(),
    onConnect: event()
  }
  const chrome = g.chrome && typeof g.chrome === 'object' ? g.chrome : (g.chrome = {})
  try {
    Object.defineProperty(chrome, 'runtime', { value: runtime, configurable: true, enumerable: true, writable: true })
  } catch {}
}
