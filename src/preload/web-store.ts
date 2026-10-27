import { contextBridge, ipcRenderer } from 'electron'
import {
  ExtensionInstallStatus,
  MV2DeprecationStatus,
  WEB_STORE_IPC,
  WEB_STORE_METHODS,
  WEB_STORE_ORIGIN,
  WebGlStatus,
  WebStoreResult,
  type WebStoreReply
} from '@shared/web-store'

// The Chrome Web Store installs through chrome.webstorePrivate and lists
// what is installed through chrome.management, which only Chrome has: its
// "Add to Chrome" button does nothing anywhere else. On the store's own
// origin (and nowhere else), stand both in, each call answered by main
// (src/main/extensions/web-store.ts), which asks the user before installing.

type Event = 'installed' | 'uninstalled'

if (location.origin === WEB_STORE_ORIGIN) {
  const listeners: Record<Event, Set<(value: unknown) => void>> = { installed: new Set(), uninstalled: new Set() }
  ipcRenderer.on(WEB_STORE_IPC.installed, (_e, info: unknown) => listeners.installed.forEach((l) => l(info)))
  ipcRenderer.on(WEB_STORE_IPC.uninstalled, (_e, id: unknown) => listeners.uninstalled.forEach((l) => l(id)))

  contextBridge.executeInMainWorld({
    // Serialized into the page's world: no references to anything out here.
    func: (
      call: (method: string, args: unknown[]) => Promise<{ value: unknown; error?: string }>,
      listen: (event: 'installed' | 'uninstalled', listener: (value: unknown) => void) => () => void,
      methods: string[],
      enums: Record<string, Record<string, string>>
    ) => {
      const w = window as unknown as { chrome?: Record<string, Record<string, unknown>> }
      const chrome = (w.chrome ??= {})
      const runtime = (chrome.runtime ??= {})
      const management = (chrome.management ??= {})
      // Chrome style: an optional trailing callback, `runtime.lastError` set
      // while it runs, and a promise either way.
      const wrap = (method: string) =>
        function (...args: unknown[]) {
          const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as (value: unknown) => void) : null
          return call(method, args).then((reply) => {
            if (callback) {
              runtime.lastError = reply.error ? { message: reply.error } : undefined
              try {
                callback(reply.value)
              } finally {
                runtime.lastError = undefined
              }
            }
            if (reply.error && !callback) throw new Error(reply.error)
            return reply.value
          })
        }
      const store: Record<string, unknown> = { ...enums }
      for (const method of methods) {
        if (method.startsWith('management.')) management[method.slice('management.'.length)] = wrap(method)
        else store[method] = wrap(method)
      }
      const event = (name: 'installed' | 'uninstalled') => {
        const subscriptions = new Map<unknown, () => void>()
        return {
          addListener: (fn: (value: unknown) => void) => {
            if (!subscriptions.has(fn)) subscriptions.set(fn, listen(name, fn))
          },
          removeListener: (fn: unknown) => {
            subscriptions.get(fn)?.()
            subscriptions.delete(fn)
          },
          hasListener: (fn: unknown) => subscriptions.has(fn)
        }
      }
      management.onInstalled = event('installed')
      management.onUninstalled = event('uninstalled')
      chrome.webstorePrivate = store
    },
    args: [
      (method: string, args: unknown[]) => ipcRenderer.invoke(WEB_STORE_IPC.call, method, args) as Promise<WebStoreReply>,
      (event: Event, listener: (value: unknown) => void) => {
        listeners[event].add(listener)
        return () => listeners[event].delete(listener)
      },
      [...WEB_STORE_METHODS],
      { Result: WebStoreResult, ExtensionInstallStatus, MV2DeprecationStatus, WebGlStatus }
    ]
  })
}
