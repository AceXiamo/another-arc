import { contextBridge, ipcRenderer } from 'electron'
import { PAGE_PROMPT_IPC } from '@shared/ipc'

// prompt(): Electron's renderer setup replaces it in every page with one that
// throws ("prompt() is not supported"), so the dialog never reaches the
// browser. Put back one that asks main and blocks until the user answers,
// as the real one does; main shows it like alert() and confirm(). One bridge
// call per document, replacing Electron's own override.
//
// Subframes get no preload and keep the native prompt(), which reaches main
// through Chromium's dialog path instead.
contextBridge.executeInMainWorld({
  // Serialized into the page's world: no references to anything out here.
  func: (ask: (message: string, value: string) => string | null) => {
    const text = (value: unknown) => (value === undefined ? '' : String(value))
    // `arguments`, not parameters: the native prompt's length is 0.
    window.prompt = function prompt() {
      return ask(text(arguments[0]), text(arguments[1]))
    }
  },
  args: [(message: string, value: string) => ipcRenderer.sendSync(PAGE_PROMPT_IPC, message, value) as string | null]
})
