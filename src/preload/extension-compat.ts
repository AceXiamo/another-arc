// Extension compatibility shims for every extension context (service workers
// and chrome-extension:// pages). This file is registered twice, around
// electron-chrome-extensions' own preload (see compat.ts):
//
// Early pass, before the library (which freezes `chrome` when it is done):
//
//   chrome.sidePanel does not exist in Electron. Wallets call
//   `chrome.sidePanel.setPanelBehavior()` at the top of their service
//   worker, and the TypeError kills the whole worker. We add the API and
//   forward it to main, which shows the panel in an extension window.
//
// Late pass, after the library. Electron 44 has more gaps that many real
// extensions trip over:
//
//   1. chrome.runtime.onInstalled / onStartup never fire.
//   2. chrome.storage.onChanged never fires inside the background service
//      worker (it does fire in extension pages).
//   3. chrome.runtime.getContexts can hit a fatal Chromium assertion.
//   4. The native `browser` namespace lacks everything the library adds.
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
const CHANNEL_SIDE_PANEL = 'arc-compat:sidePanel'
const CHANNEL_SIDE_PANEL_EVENT = 'arc-compat:sidePanelEvent'

type Deliver = (name: string, ...args: unknown[]) => void

const isWorker = process.type === 'service-worker'
const href = (globalThis as { location?: { href: string } }).location?.href ?? ''
const isExtensionFrame = !isWorker && href.startsWith('chrome-extension:')

// Offscreen documents run without context isolation: the preload shares the
// page's world, so the "main world" is our own.
const isolated = process.contextIsolated

if (isWorker || isExtensionFrame) {
  if (isEarlyPass()) installEarly()
  else install()
}

function exposeInMainWorld(key: string, api: unknown): void {
  if (isolated) contextBridge.exposeInMainWorld(key, api)
  else (globalThis as Record<string, unknown>)[key] = api
}

function runInMainWorld<T>(func: () => T): T {
  return isolated ? (contextBridge.executeInMainWorld({ func }) as T) : func()
}

/**
 * True on the first run in this context, while `chrome` is still open. The
 * mark lives on the main world's global object until the late pass clears it.
 */
function isEarlyPass(): boolean {
  try {
    return (
      runInMainWorld(() => {
        const g = globalThis as unknown as Record<string, unknown> & { chrome?: object }
        const mark = '__arcCompatEarlyPass'
        if (g[mark]) {
          try {
            delete g[mark]
          } catch {
            // ignore
          }
          return false
        }
        // The library already froze it: run the late pass (no side panel).
        if (g.chrome && Object.isFrozen(g.chrome)) return false
        Object.defineProperty(g, mark, { value: true, configurable: true, enumerable: false })
        return true
      }) === true
    )
  } catch {
    return false
  }
}

/** ipcRenderer.invoke, retried briefly: a worker's very first call can beat main's handler registration. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ipcRenderer.invoke(channel, ...args)
    } catch (error) {
      if (attempt >= 4 || !/No handler registered/i.test(String(error))) throw error
      await new Promise((r) => setTimeout(r, 50 * 2 ** attempt))
    }
  }
}

function installEarly(): void {
  let deliver: ((name: string, payload: unknown) => void) | null = null
  ipcRenderer.on(CHANNEL_SIDE_PANEL_EVENT, (_event, name: string, payload: unknown) => deliver?.(name, payload))
  const bridge = {
    call: (method: string, arg: unknown) => invoke(CHANNEL_SIDE_PANEL, method, arg ?? null),
    subscribe(cb: (name: string, payload: unknown) => void) {
      deliver = cb
    }
  }
  try {
    exposeInMainWorld('__arcSidePanel', bridge)
    runInMainWorld(sidePanelShim)
  } catch (error) {
    console.error('[arc] sidePanel shim failed', error)
  }
}

/**
 * chrome.sidePanel, in the extension's own JS world. Must be self-contained.
 * Like Chrome, it is only there for extensions with the "sidePanel"
 * permission. Every method takes a callback or returns a promise, and never
 * throws or rejects: a failure resolves with Chrome's defaults.
 */
function sidePanelShim(): void {
  const g = globalThis as unknown as {
    chrome?: any
    __arcSidePanel?: {
      call(method: string, arg: unknown): Promise<unknown>
      subscribe(cb: (name: string, payload: unknown) => void): void
    }
  }
  const bridge = g.__arcSidePanel
  try {
    delete (g as Record<string, unknown>).__arcSidePanel
  } catch {
    // exposed bindings may be non-configurable
  }
  const chrome = g.chrome
  if (!bridge || !chrome?.runtime?.id || Object.isFrozen(chrome)) return
  if (typeof chrome.sidePanel?.setOptions === 'function') return
  let manifest: { permissions?: unknown; side_panel?: { default_path?: unknown } } = {}
  try {
    manifest = chrome.runtime.getManifest() ?? {}
  } catch {
    return
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('sidePanel')) return
  const defaultPath = typeof manifest.side_panel?.default_path === 'string' ? manifest.side_panel.default_path : undefined

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
  const onOpened = makeEvent()
  const onClosed = makeEvent()
  bridge.subscribe((name, payload) => {
    if (name === 'onOpened') onOpened.dispatch(payload)
    else if (name === 'onClosed') onClosed.dispatch(payload)
  })

  const call = (method: string, arg: unknown, fallback: unknown, cb?: unknown) => {
    const p = Promise.resolve()
      .then(() => bridge.call(method, arg == null || typeof arg !== 'object' ? null : JSON.parse(JSON.stringify(arg))))
      .then(
        (result) => result ?? fallback,
        (error) => {
          console.warn(`chrome.sidePanel.${method} failed`, error)
          return fallback
        }
      )
    if (typeof cb === 'function') {
      p.then((result) => (cb as (r: unknown) => void)(result))
      return undefined
    }
    return p
  }
  const optionsFallback = { enabled: true, ...(defaultPath ? { path: defaultPath } : {}) }
  const api = {
    setPanelBehavior: (behavior: unknown, cb?: unknown) => call('setPanelBehavior', behavior, undefined, cb),
    getPanelBehavior: (cb?: unknown) => call('getPanelBehavior', null, { openPanelOnActionClick: false }, cb),
    setOptions: (options: unknown, cb?: unknown) => call('setOptions', options, undefined, cb),
    getOptions: (options: unknown, cb?: unknown) =>
      typeof options === 'function'
        ? call('getOptions', null, optionsFallback, options)
        : call('getOptions', options, optionsFallback, cb),
    open: (options: unknown, cb?: unknown) => call('open', options, undefined, cb),
    close: (options: unknown, cb?: unknown) => call('close', options, undefined, cb),
    getLayout: (cb?: unknown) => call('getLayout', null, { side: 'right' }, cb),
    onOpened,
    onClosed,
    Side: { LEFT: 'left', RIGHT: 'right' }
  }
  try {
    Object.defineProperty(chrome, 'sidePanel', { value: api, enumerable: true, configurable: true, writable: true })
  } catch (error) {
    console.error('[arc] could not add chrome.sidePanel', error)
  }
}

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
    exposeInMainWorld('__arcExtensionCompat', bridge)
    runInMainWorld(mainWorldShim)
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
  if (!bridge || !chrome?.runtime?.id) return

  // Chromium 152 also exposes the `browser` namespace, but as a separate
  // native object: none of electron-chrome-extensions' APIs (tabs, windows,
  // action, …) nor these shims are on it. webextension-polyfill, used by
  // most wallets, prefers a native `browser`, so those extensions lost
  // tabs.create, action.onClicked, onInstalled and more, and OKX Wallet's
  // worker died at the top level. Point `browser` at the full `chrome`.
  if ('browser' in g && (g as { browser?: unknown }).browser !== chrome) {
    try {
      Object.defineProperty(g, 'browser', { value: chrome, writable: true, configurable: true, enumerable: true })
    } catch {
      // not configurable: leave the native one
    }
  }

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

  if (!chrome.storage) return

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
