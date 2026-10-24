// Extension compatibility shims, loaded into every extension context after
// electron-chrome-extensions' own preload. Electron 44 has two gaps that many
// real extensions trip over:
//
//   1. chrome.runtime.onInstalled / onStartup never fire.
//   2. chrome.storage.onChanged never fires inside the background service
//      worker (it does fire in extension pages).
//
// In service workers we replace those events with emulated ones fed by the
// main process (onInstalled/onStartup) and by storage writes we observe
// ourselves (SW writes locally; extension-page writes are forwarded through
// main). Content-script writes are not observed — a documented limitation.
//
// Web pages share the session, so this file also runs there; it bails out
// immediately for anything that is not a chrome-extension:// context.
import { contextBridge, ipcRenderer } from 'electron'

const CHANNEL_EVENT = 'arc-compat:event'
const CHANNEL_STORAGE = 'arc-compat:storage'
const CHANNEL_LISTENER = 'arc-compat:listener'
const CHANNEL_CONTEXTS = 'arc-compat:getContexts'

type Deliver = (name: string, ...args: unknown[]) => void

const isWorker = process.type === 'service-worker'
const href = (globalThis as { location?: { href: string } }).location?.href ?? ''
const isExtensionFrame = !isWorker && href.startsWith('chrome-extension:')

if (isWorker || isExtensionFrame) install()

function install(): void {
  let deliver: Deliver | null = null
  const queue: Array<[string, unknown[]]> = []
  if (isWorker) {
    ipcRenderer.on(CHANNEL_EVENT, (_event, name: string, ...args: unknown[]) => {
      if (deliver) deliver(name, ...args)
      else queue.push([name, args])
    })
  }

  const bridge = {
    worker: isWorker,
    subscribe(cb: Deliver) {
      deliver = cb
      for (const [name, args] of queue.splice(0)) cb(name, ...args)
    },
    /** A storage change made by this context (pages forward it to the worker). */
    storageChanged(area: string, changes: unknown) {
      if (!isWorker) ipcRenderer.send(CHANNEL_STORAGE, area, changes)
    },
    /** Lets main remember which extensions want to be woken on startup. */
    listenerAdded(name: string) {
      if (isWorker) ipcRenderer.send(CHANNEL_LISTENER, name)
    },
    /** runtime.getContexts answered by main (see compat.ts for why). */
    getContexts(filter: unknown): Promise<unknown> {
      return ipcRenderer.invoke(CHANNEL_CONTEXTS, filter ?? {})
    }
  }

  try {
    contextBridge.exposeInMainWorld('__arcExtensionCompat', bridge)
    contextBridge.executeInMainWorld({ func: mainWorldShim })
  } catch (error) {
    console.error('[arc] extension compat shim failed', error)
  }
}

/** Runs in the extension's own JS world. Must be self-contained. */
function mainWorldShim(): void {
  const g = globalThis as unknown as {
    chrome?: any
    __arcExtensionCompat?: {
      worker: boolean
      subscribe(cb: (name: string, ...args: unknown[]) => void): void
      storageChanged(area: string, changes: unknown): void
      listenerAdded(name: string): void
      getContexts(filter: unknown): Promise<unknown>
    }
  }
  const bridge = g.__arcExtensionCompat
  const chrome = g.chrome
  try {
    delete (g as Record<string, unknown>).__arcExtensionCompat
  } catch {
    // exposed bindings may be non-configurable
  }
  if (!bridge || !chrome?.runtime?.id || !chrome.storage) return

  function makeEvent() {
    const listeners = new Set<(...args: unknown[]) => void>()
    return {
      addListener: (fn: (...args: unknown[]) => void) => void listeners.add(fn),
      removeListener: (fn: (...args: unknown[]) => void) => void listeners.delete(fn),
      hasListener: (fn: (...args: unknown[]) => void) => listeners.has(fn),
      hasListeners: () => listeners.size > 0,
      dispatch(...args: unknown[]) {
        for (const fn of [...listeners]) {
          try {
            fn(...args)
          } catch (error) {
            console.error(error)
          }
        }
      }
    }
  }

  // Electron leaves extension popups and extension pages in tabs without a
  // proper view type; Chromium's native getContexts() hits a fatal assertion
  // enumerating them and takes the whole browser down. Answer from main.
  if (typeof chrome.runtime.getContexts === 'function') {
    try {
      chrome.runtime.getContexts = (filter: unknown, cb?: (r: unknown) => void) => {
        const p = bridge.getContexts(filter)
        if (typeof cb === 'function') {
          p.then(cb, () => cb([]))
          return undefined
        }
        return p
      }
    } catch {
      // not writable: keep native
    }
  }

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

  const onChanged = makeEvent()
  const areaEvents: Record<string, ReturnType<typeof makeEvent>> = {}
  const emit = (area: string, changes: Record<string, unknown>) => {
    if (Object.keys(changes).length === 0) return
    if (bridge.worker) {
      onChanged.dispatch(changes, area)
      areaEvents[area]?.dispatch(changes)
    } else {
      // Pages already get native events; just tell the worker.
      bridge.storageChanged(area, changes)
    }
  }

  // Wrap mutating calls to compute { key: { oldValue, newValue } }. Supports
  // both promise and callback styles.
  for (const area of ['local', 'session', 'sync']) {
    const native = chrome.storage[area]
    if (!native) continue
    const finish = (p: Promise<unknown>, cb?: unknown) => {
      if (typeof cb === 'function') {
        p.then(() => (cb as () => void)(), () => (cb as () => void)())
        return undefined
      }
      return p
    }
    const wrapped: Record<string, unknown> = {
      set(items: Record<string, unknown>, cb?: unknown) {
        const keys = Object.keys(items ?? {})
        const p = native.get(keys).then(async (before: Record<string, unknown>) => {
          await native.set(items)
          const changes: Record<string, unknown> = {}
          for (const k of keys) {
            if (same(before[k], items[k])) continue
            changes[k] = before[k] === undefined ? { newValue: clone(items[k]) } : { oldValue: before[k], newValue: clone(items[k]) }
          }
          emit(area, changes)
        })
        return finish(p, cb)
      },
      remove(keys: string | string[], cb?: unknown) {
        const list = Array.isArray(keys) ? keys : [keys]
        const p = native.get(list).then(async (before: Record<string, unknown>) => {
          await native.remove(list)
          const changes: Record<string, unknown> = {}
          for (const k of list) if (before[k] !== undefined) changes[k] = { oldValue: before[k] }
          emit(area, changes)
        })
        return finish(p, cb)
      },
      clear(cb?: unknown) {
        const p = native.get(null).then(async (before: Record<string, unknown>) => {
          await native.clear()
          const changes: Record<string, unknown> = {}
          for (const k of Object.keys(before)) changes[k] = { oldValue: before[k] }
          emit(area, changes)
        })
        return finish(p, cb)
      }
    }
    if (bridge.worker) {
      areaEvents[area] = makeEvent()
      wrapped.onChanged = areaEvents[area]
    }
    const proxy = new Proxy(native, {
      get(target, prop) {
        if (typeof prop === 'string' && prop in wrapped) return wrapped[prop]
        // Native getters must see the real StorageArea as `this`, not the proxy.
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    try {
      chrome.storage[area] = proxy
    } catch {
      // chrome.storage not writable: leave native behaviour in place
    }
  }

  if (!bridge.worker) return

  const onInstalled = makeEvent()
  const onStartup = makeEvent()
  const addStartup = onStartup.addListener
  onStartup.addListener = (fn: (...args: unknown[]) => void) => {
    addStartup(fn)
    bridge.listenerAdded('runtime.onStartup')
  }
  try {
    chrome.storage.onChanged = onChanged
    chrome.runtime.onInstalled = onInstalled
    chrome.runtime.onStartup = onStartup
  } catch {
    return
  }
  bridge.subscribe((name, ...args) => {
    if (name === 'runtime.onInstalled') onInstalled.dispatch(...args)
    else if (name === 'runtime.onStartup') onStartup.dispatch()
    else if (name === 'storage.onChanged') {
      const [changes, area] = args as [Record<string, unknown>, string]
      onChanged.dispatch(changes, area)
      areaEvents[area]?.dispatch(changes)
    }
  })
}
