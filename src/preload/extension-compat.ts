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
//   Nor does chrome.userScripts, which user script managers (Tampermonkey)
//   need. We add it on top of chrome.scripting (see userScriptsShim).
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
const CHANNEL_USER_SCRIPTS = 'arc-compat:userScripts'
const CHANNEL_USER_SCRIPTS_STATE = 'arc-compat:userScriptsState'

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
  installUserScripts()
}

/**
 * chrome.userScripts, for extensions asking for it (Tampermonkey & co). It is
 * there only while the user allows it ("Allow User Scripts" on the Extensions
 * page): extensions test `chrome.userScripts` to tell the user to turn it on.
 * Pages learn that synchronously, before their scripts run. Workers cannot
 * (a synchronous message to a worker without its handler in place hangs it),
 * so there the API appears a moment later, before any extension's own
 * start-up work gets to it.
 */
function installUserScripts(): void {
  let wanted = false
  try {
    wanted =
      runInMainWorld(() => {
        const chrome = (globalThis as { chrome?: any }).chrome
        const permissions = chrome?.runtime?.getManifest?.()?.permissions
        return Array.isArray(permissions) && permissions.includes('userScripts') && Boolean(chrome.scripting)
      }) === true
  } catch {
    return
  }
  if (!wanted) return
  let initial: boolean | null = null
  if (!isWorker) {
    try {
      initial = ipcRenderer.sendSync(CHANNEL_USER_SCRIPTS_STATE) === true
    } catch {
      initial = false
    }
  }
  let deliver: ((allowed: boolean) => void) | null = null
  let pending: boolean | null = null
  if (initial === null) {
    invoke(CHANNEL_USER_SCRIPTS, 'state').then(
      (value) => {
        if (deliver) deliver(value === true)
        else pending = value === true
      },
      () => {
        if (deliver) deliver(false)
        else pending = false
      }
    )
  }
  const bridge = {
    initial,
    call: (method: string, ...args: unknown[]) => invoke(CHANNEL_USER_SCRIPTS, method, ...args),
    onState(cb: (allowed: boolean) => void) {
      deliver = cb
      if (pending !== null) cb(pending)
    }
  }
  try {
    exposeInMainWorld('__arcUserScripts', bridge)
    runInMainWorld(userScriptsShim)
  } catch (error) {
    console.error('[arc] userScripts shim failed', error)
  }
}

/**
 * chrome.userScripts on top of the extension's own chrome.scripting dynamic
 * content scripts (see src/main/extensions/user-scripts.ts). Runs in the
 * extension's JS world and must be self-contained.
 */
function userScriptsShim(): void {
  const g = globalThis as unknown as {
    chrome?: any
    __arcUserScripts?: {
      initial: boolean | null
      call(method: string, ...args: unknown[]): Promise<any>
      onState(cb: (allowed: boolean) => void): void
    }
  }
  const bridge = g.__arcUserScripts
  try {
    delete (g as Record<string, unknown>).__arcUserScripts
  } catch {
    // exposed bindings may be non-configurable
  }
  const chrome = g.chrome
  if (!bridge || !chrome?.runtime?.id || !chrome.scripting || Object.isFrozen(chrome) || 'userScripts' in chrome) return

  // Keep in sync with NATIVE_PREFIX in user-scripts.ts.
  const PREFIX = 'arc-us-'
  const native = chrome.scripting
  const nGet = native.getRegisteredContentScripts.bind(native)
  const nRegister = native.registerContentScripts.bind(native)
  const nUpdate = native.updateContentScripts.bind(native)
  const nUnregister = native.unregisterContentScripts.bind(native)
  const nExecute = native.executeScript.bind(native)
  const ours = (id: unknown) => typeof id === 'string' && id.startsWith(PREFIX)

  const call = (method: string, ...args: unknown[]): Promise<any> =>
    bridge.call(method, ...args).catch((error: unknown) => {
      const message = String((error as Error)?.message ?? error)
      throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''))
    })
  const plain = (v: unknown) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)))
  // One call at a time, in order: register() then unregister() must not race.
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn)
    chain = p.then(
      () => undefined,
      () => undefined
    )
    return p
  }
  /** Promise, or callback when one is given, like every chrome.* method. */
  const finish = (p: Promise<unknown>, cb?: unknown) => {
    if (typeof cb !== 'function') return p
    p.then(
      (result) => (cb as (r: unknown) => void)(result),
      (error) => {
        console.error(error)
        ;(cb as () => void)()
      }
    )
    return undefined
  }

  // Our native scripts are not the extension's own: chrome.scripting does
  // not list them, and unregistering "all" leaves them alone.
  const hidden: Record<string, unknown> = {
    getRegisteredContentScripts(filter?: unknown, cb?: unknown) {
      if (typeof filter === 'function') [cb, filter] = [filter, undefined]
      return finish(
        nGet(filter ?? undefined).then((list: Array<{ id: string }>) => list.filter((s) => !ours(s.id))),
        cb
      )
    },
    unregisterContentScripts(filter?: unknown, cb?: unknown) {
      if (typeof filter === 'function') [cb, filter] = [filter, undefined]
      const ids = (filter as { ids?: unknown } | undefined)?.ids
      const p = Array.isArray(ids)
        ? nUnregister(filter)
        : nGet().then((list: Array<{ id: string }>) => {
            const own = list.filter((s) => !ours(s.id)).map((s) => s.id)
            return own.length > 0 ? nUnregister({ ids: own }) : undefined
          })
      return finish(p, cb)
    }
  }
  const scripting = new Proxy(native, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in hidden) return hidden[prop]
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  try {
    Object.defineProperty(chrome, 'scripting', { value: scripting, enumerable: true, configurable: true, writable: true })
  } catch {
    // Not replaceable: our scripts show in chrome.scripting, which is harmless.
  }

  type Native = { id: string; matches: string[]; excludeMatches?: string[]; js: string[]; allFrames?: boolean; runAt?: string; world?: string }
  const same = (a: Native, b: Native) =>
    a.runAt === b.runAt &&
    (a.world ?? 'ISOLATED') === (b.world ?? 'ISOLATED') &&
    Boolean(a.allFrames) === Boolean(b.allFrames) &&
    JSON.stringify(a.js) === JSON.stringify(b.js) &&
    JSON.stringify(a.matches) === JSON.stringify(b.matches) &&
    JSON.stringify(a.excludeMatches ?? []) === JSON.stringify(b.excludeMatches ?? [])
  // Make the native registrations what main says they should be: the
  // registry, plus the bridge. Electron forgets dynamic content scripts on
  // quit and an update reloads the extension, so this also runs at start.
  const sync = async () => {
    const wanted: Native[] = await call('native')
    const present = new Map<string, Native>((await nGet()).filter((s: Native) => ours(s.id)).map((s: Native) => [s.id, s]))
    const stale = [...present.keys()].filter((id) => !wanted.some((w) => w.id === id))
    if (stale.length > 0) await nUnregister({ ids: stale })
    const changed = wanted.filter((w) => present.has(w.id) && !same(w, present.get(w.id)!))
    if (changed.length > 0) await nUpdate(changed)
    const missing = wanted.filter((w) => !present.has(w.id))
    if (missing.length === 0) return
    try {
      await nRegister(missing)
    } catch {
      // One bad script must not keep the others out.
      for (const s of missing) await nRegister([s]).catch((error: unknown) => console.warn(`[arc] user script '${s.id}'`, error))
    }
  }
  const register = async (scripts: unknown) => {
    const { token, native: list } = await call('prepare', 'register', plain(scripts))
    try {
      // Natively first: Chromium's own checks (match patterns, files) report here.
      if (list.length > 0) await nRegister(list)
    } catch (error) {
      await call('discard', token).catch(() => undefined)
      throw error
    }
    await call('commit', token)
    await sync()
  }
  const update = async (scripts: unknown) => {
    const { token } = await call('prepare', 'update', plain(scripts))
    await call('commit', token)
    await sync()
  }
  const unregister = async (filter: unknown) => {
    await call('unregister', plain(filter))
    await sync()
  }
  const execute = async (injection: any) => {
    const { files, world } = await call('prepareExecute', plain({ js: injection?.js, world: injection?.world, worldId: injection?.worldId }))
    const results = await nExecute({ target: injection?.target, files, world, injectImmediately: injection?.injectImmediately === true })
    return (results ?? []).map((r: any) => {
      const out: Record<string, unknown> = { documentId: r.documentId, frameId: r.frameId, result: r.result }
      if (r.error) out.error = String(r.error?.message ?? r.error)
      return out
    })
  }
  const configure = async (method: string, arg: unknown) => {
    await call(method, arg)
    // The script files carry the world properties.
    await sync()
  }

  const api = {
    register: (scripts: unknown, cb?: unknown) => finish(serial(() => register(scripts)), cb),
    update: (scripts: unknown, cb?: unknown) => finish(serial(() => update(scripts)), cb),
    unregister(filter?: unknown, cb?: unknown) {
      if (typeof filter === 'function') [cb, filter] = [filter, undefined]
      return finish(
        serial(() => unregister(filter)),
        cb
      )
    },
    getScripts(filter?: unknown, cb?: unknown) {
      if (typeof filter === 'function') [cb, filter] = [filter, undefined]
      return finish(
        serial(() => call('get', plain(filter))),
        cb
      )
    },
    configureWorld: (properties: unknown, cb?: unknown) => finish(serial(() => configure('configureWorld', plain(properties))), cb),
    getWorldConfigurations: (cb?: unknown) => finish(serial(() => call('getWorlds')), cb),
    resetWorldConfiguration(worldId?: unknown, cb?: unknown) {
      if (typeof worldId === 'function') [cb, worldId] = [worldId, undefined]
      return finish(
        serial(() => configure('resetWorld', worldId ?? null)),
        cb
      )
    },
    execute: (injection: unknown, cb?: unknown) => finish(serial(() => execute(injection)), cb),
    ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' }
  }

  let allowed = bridge.initial === true
  const setAllowed = (value: boolean) => {
    allowed = value
    if (!value) return
    serial(sync)
      .catch((error) => console.warn('[arc] could not register user scripts', error))
      // Main holds the first page of a launch until this.
      .finally(() => call('hydrated').catch(() => undefined))
  }
  if (bridge.initial === null) bridge.onState(setAllowed)
  else if (allowed) setAllowed(true)
  try {
    Object.defineProperty(chrome, 'userScripts', { get: () => (allowed ? api : undefined), enumerable: true, configurable: true })
  } catch (error) {
    console.error('[arc] could not add chrome.userScripts', error)
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
    runInMainWorld(routeUserScriptMessages)
  } catch (error) {
    console.error('[arc] extension compat shim failed', error)
  }
}

/**
 * User scripts run in the extension's isolated world (see user-scripts.ts),
 * so their messages reach runtime.onMessage / onConnect as a content
 * script's would; Chrome sends them to onUserScriptMessage /
 * onUserScriptConnect instead. Deliver page messages to the listeners of
 * both, each listener once: Tampermonkey adds the same function to both.
 * Runs in the extension's JS world and must be self-contained.
 */
function routeUserScriptMessages(): void {
  const runtime = (globalThis as { chrome?: any }).chrome?.runtime
  const permissions = runtime?.getManifest?.()?.permissions
  if (!Array.isArray(permissions) || !permissions.includes('userScripts')) return
  if (!runtime.onMessage?.addListener || !runtime.onConnect?.addListener || !runtime.onUserScriptMessage) return
  const own = `chrome-extension://${runtime.id}/`
  const fromPage = (sender: any) => sender?.id === runtime.id && typeof sender.url === 'string' && !sender.url.startsWith(own)

  type Fn = (...args: any[]) => unknown
  const event = () => {
    const listeners = new Set<Fn>()
    return {
      listeners,
      api: {
        addListener: (fn: Fn) => void (typeof fn === 'function' && listeners.add(fn)),
        removeListener: (fn: Fn) => void listeners.delete(fn),
        hasListener: (fn: Fn) => listeners.has(fn),
        hasListeners: () => listeners.size > 0
      }
    }
  }
  const message = event()
  const userMessage = event()
  const connect = event()
  const userConnect = event()
  const targets = (main: Set<Fn>, user: Set<Fn>, page: boolean) => (page ? [...new Set([...user, ...main])] : [...main])

  runtime.onMessage.addListener((msg: unknown, sender: any, sendResponse: Fn) => {
    // Chrome's rules across listeners: `true` keeps the channel open for
    // sendResponse; otherwise a returned promise answers.
    let keep = false
    let answer: unknown
    for (const fn of targets(message.listeners, userMessage.listeners, fromPage(sender))) {
      try {
        const r = fn(msg, sender, sendResponse)
        if (r === true) keep = true
        else if (answer === undefined && r && typeof (r as Promise<unknown>).then === 'function') answer = r
      } catch (error) {
        console.error(error)
      }
    }
    return keep ? true : answer
  })
  runtime.onConnect.addListener((port: any) => {
    for (const fn of targets(connect.listeners, userConnect.listeners, fromPage(port?.sender))) {
      try {
        fn(port)
      } catch (error) {
        console.error(error)
      }
    }
  })
  try {
    runtime.onMessage = message.api
    runtime.onUserScriptMessage = userMessage.api
    runtime.onConnect = connect.api
    runtime.onUserScriptConnect = userConnect.api
  } catch {
    // not writable: native routing stays
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

  const same =(a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
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
