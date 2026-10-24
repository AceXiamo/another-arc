// Preload for the shell (sidebar / chrome UI). Exposes a minimal, typed API on
// `window.arc`. Web pages never get a preload of ours.
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { ShellCommand, StatePatch } from '@shared/types'
import type { ArcApi } from './api'

// Start fetching the snapshot before the page's own scripts even parse, and
// buffer any patches that arrive before React subscribes.
const snapshot = ipcRenderer.invoke(IPC.invoke, 'shell.snapshot')

function channel<T>(name: string) {
  let listener: ((value: T) => void) | null = null
  const buffer: T[] = []
  ipcRenderer.on(name, (_event, value: T) => {
    if (listener) listener(value)
    else buffer.push(value)
  })
  return (cb: (value: T) => void) => {
    listener = cb
    for (const value of buffer.splice(0)) cb(value)
    return () => {
      if (listener === cb) listener = null
    }
  }
}

const api: ArcApi = {
  invoke: (method, ...args) => ipcRenderer.invoke(IPC.invoke, method, ...args),
  snapshot: () => snapshot,
  onPatch: channel<StatePatch>(IPC.patch),
  onCommand: channel<ShellCommand>(IPC.command),
  actions: {
    // Bridge to electron-chrome-extensions' browserAction API so the shell can
    // render extension buttons with its own UI.
    invoke: (partition, name, ...args) => {
      if (!name.startsWith('browserAction.')) return Promise.reject(new Error('Unsupported action call'))
      return ipcRenderer.invoke('crx-msg-remote', partition, name, ...args)
    },
    onUpdate: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('browserAction.update', handler)
      return () => {
        ipcRenderer.removeListener('browserAction.update', handler)
      }
    }
  }
}

contextBridge.exposeInMainWorld('arc', api)
