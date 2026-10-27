// The user script world: runs chrome.userScripts code handed over by the
// extension's bridge in a world of its own, with the CSP the extension
// configured. See src/shared/user-script-world.ts for the whole picture.
//
// Costs nothing until an extension with user scripts announces itself: one
// capturing listener.
import { contextBridge, webFrame } from 'electron'
import {
  channelEvents,
  DEFAULT_WORLD_CSP,
  HELLO_EVENT,
  RUNTIME_SHIM,
  type DownMessage,
  type UpMessage,
  type WorldConfig,
  type WorldHello
} from '@shared/user-script-world'

/** Our world ids: below Chromium's extension worlds (1 << 20 and up), above Electron's (999) and the agent's (1001). */
const WORLD_BASE = 10_000
const WORLD_SPAN = 1_000_000 - WORLD_BASE

const channels = new Map<string, Channel>()

document.addEventListener(
  HELLO_EVENT,
  (event) => {
    const hello = (event as CustomEvent<WorldHello>).detail
    if (!isHello(hello) || channels.has(hello.ext)) return
    // First announcement wins: the bridge's, at document_start.
    event.preventDefault()
    event.stopImmediatePropagation()
    channels.set(hello.ext, new Channel(hello))
  },
  true
)

class Channel {
  private readonly events: { up: string; down: string }
  private readonly worlds = new Map<string, number>()
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private readonly ports = new Map<number, { message(m: unknown): void; closed(error?: string): void }>()
  private next = 1

  constructor(private readonly hello: WorldHello) {
    this.events = channelEvents(hello.channel)
    document.addEventListener(this.events.up, (event) => this.onUp(event as CustomEvent<UpMessage>), true)
  }

  private onUp(event: CustomEvent<UpMessage>): void {
    event.stopImmediatePropagation()
    const d = event.detail
    if (!d || typeof d !== 'object') return
    switch (d.op) {
      case 'run':
        if (typeof d.code === 'string' && typeof d.world === 'string' && this.run(d.world, d.code)) event.preventDefault()
        return
      case 'reply': {
        const p = this.pending.get(d.id)
        this.pending.delete(d.id)
        if (d.error !== undefined) p?.reject(new Error(d.error))
        else p?.resolve(d.response)
        return
      }
      case 'portMessage':
        this.ports.get(d.port)?.message(d.message)
        return
      case 'portClosed':
        this.ports.get(d.port)?.closed(d.error)
        this.ports.delete(d.port)
        return
    }
  }

  private down(message: DownMessage): void {
    document.dispatchEvent(new CustomEvent(this.events.down, { detail: message }))
  }

  /** Runs synchronously, so a document_start script still runs before the page's own. */
  private run(world: string, code: string): boolean {
    let id: number
    try {
      id = this.world(world)
    } catch (error) {
      console.error('[arc] user script world', error)
      return false
    }
    webFrame.executeJavaScriptInIsolatedWorld(id, [{ code }]).catch((error) => console.error(error))
    return true
  }

  private world(key: string): number {
    const existing = this.worlds.get(key)
    if (existing !== undefined) return existing
    const id = worldId(this.hello.ext, key)
    const config: WorldConfig = this.hello.worlds[key] ?? this.hello.worlds[''] ?? {}
    // The page's origin, not the extension's: what user scripts fetch is
    // subject to the page's CORS, as in Chrome, and a page faking a bridge
    // gains nothing but a world of its own origin.
    webFrame.setIsolatedWorldInfo(id, {
      securityOrigin: location.origin === 'null' ? 'null' : location.origin,
      csp: config.csp || DEFAULT_WORLD_CSP,
      name: `User scripts (${this.hello.ext})`
    })
    if (config.messaging) {
      contextBridge.exposeInIsolatedWorld(id, '__arcUserScriptRuntime', {
        id: this.hello.ext,
        sendMessage: (message: unknown) => this.send(message),
        connect: (name: string, message: (m: unknown) => void, closed: (error?: string) => void) => this.connect(name, message, closed),
        post: (port: number, message: unknown) => this.down({ op: 'post', port, message }),
        disconnect: (port: number) => {
          this.ports.delete(port)
          this.down({ op: 'disconnect', port })
        }
      })
      void webFrame.executeJavaScriptInIsolatedWorld(id, [{ code: RUNTIME_SHIM }])
    }
    this.worlds.set(key, id)
    return id
  }

  private send(message: unknown): Promise<unknown> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.down({ op: 'send', id, message })
    })
  }

  private connect(name: string, message: (m: unknown) => void, closed: (error?: string) => void): number {
    const port = this.next++
    this.ports.set(port, { message, closed })
    this.down({ op: 'connect', port, name: String(name ?? '') })
    return port
  }
}

function isHello(v: unknown): v is WorldHello {
  const h = v as WorldHello
  return (
    !!h &&
    typeof h.ext === 'string' &&
    /^[a-p]{32}$/.test(h.ext) &&
    typeof h.channel === 'string' &&
    /^[0-9a-f]{32}$/.test(h.channel) &&
    !!h.worlds &&
    typeof h.worlds === 'object'
  )
}

/** A stable world id per extension and world, the same in every frame of the process. */
function worldId(ext: string, key: string): number {
  let h = 2166136261
  for (const c of `${ext}|${key}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return WORLD_BASE + ((h >>> 0) % WORLD_SPAN)
}
