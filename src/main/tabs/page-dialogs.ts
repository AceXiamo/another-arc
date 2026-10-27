import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { PAGE_PROMPT_IPC } from '@shared/ipc'
import type { PageDialog, TabId } from '@shared/types'

/**
 * What Electron passes the JavaScript dialog handler it installs on every
 * WebContents (`-run-dialog`, lib/browser/api/web-contents.ts). `answer`
 * unblocks the page: confirm() returns `success`, prompt() returns `userInput`
 * when `success` (null otherwise), alert() ignores both.
 */
interface RunDialogInfo {
  frame: Electron.WebFrameMain | null
  dialogType: PageDialog['kind']
  messageText: string
  defaultPromptText: string
}
type Answer = (success: boolean, userInput: string) => void

interface OpenDialog {
  dialog: PageDialog
  wc: WebContents
  /** safeDialogs bookkeeping key: the origin, or the file for file:// pages. */
  key: string
  answer: Answer
}

export interface PageDialogHost {
  tabIdFor(wc: WebContents): TabId | undefined
  /** True for the page on screen; only it may interrupt the user. */
  isShown(wc: WebContents): boolean
  /** An agent is working in this tab: its dialogs wait for the agent's answer, on screen or not. */
  heldForAgent(wc: WebContents): boolean
  changed(dialogs: PageDialog[]): void
}

/** Count meaning the user ticked "no more dialogs" for that origin. */
const BLOCKED = -1

let warned = false

/**
 * alert() / confirm() / prompt() for tabs, drawn by the shell as a sheet on
 * the page card. Electron's own handler opens a native sheet over the whole
 * window — from background tabs too, without saying which site asks, and in
 * English only — so it is replaced. Electron also takes prompt() away from
 * pages; the page preload puts it back (src/preload/page-prompt.ts) and asks
 * here over sync IPC.
 *
 * Dialogs are tab-modal, as in Chrome: a tab that is not on screen gets
 * "cancel" at once, and switching tabs, navigating or closing the tab
 * cancels the one showing. Tabs an agent is driving are the exception: their
 * dialogs wait for the agent (or for the user, who sees the sheet on
 * switching there) until the agent goes quiet. Nothing here waits: the page
 * stays blocked in its renderer until `respond`, main keeps running.
 */
export class PageDialogs {
  private readonly open = new Map<string, OpenDialog>()
  /** Dialogs per origin, per page: from the second one the user can block the rest (safeDialogs). */
  private readonly counts = new WeakMap<WebContents, Map<string, number>>()
  private readonly attached = new WeakSet<WebContents>()

  constructor(private readonly host: PageDialogHost) {
    ipcMain.on(PAGE_PROMPT_IPC, (event, message: unknown, value: unknown) => {
      const answer: Answer = (success, userInput) => {
        event.returnValue = success ? userInput : null
      }
      const wc = event.sender
      if (!this.attached.has(wc) || typeof message !== 'string' || typeof value !== 'string') return answer(false, '')
      this.run(wc, { frame: event.senderFrame, dialogType: 'prompt', messageText: message, defaultPromptText: value }, answer)
    })
  }

  /** Take over a tab's dialogs. Call before the page loads. */
  attach(wc: WebContents): void {
    const events = wc as unknown as NodeJS.EventEmitter
    if (events.listenerCount('-run-dialog') === 0) {
      // Electron changed how dialogs reach JS; its default stays in charge.
      if (!warned) console.warn('[dialogs] no -run-dialog handler to replace; page dialogs use Electron defaults')
      warned = true
      return
    }
    this.attached.add(wc)
    events.removeAllListeners('-run-dialog')
    events.on('-run-dialog', (info: RunDialogInfo, answer: Answer) => this.run(wc, info, answer))
    // Chromium cancels on commit and when the renderer goes; `resetState` on
    // user-initiated and cross-site navigations, which start with a clean slate.
    events.on('-cancel-dialogs', (info?: { resetState?: boolean }) => {
      if (info?.resetState) this.counts.delete(wc)
      this.settle((o) => o.wc === wc)
    })
    // The page is blocked until the commit, so cancel as soon as a new document
    // starts loading (⌘R, a typed URL). Chromium never hears of a preload
    // prompt(), so a crash has to cancel that one here too.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.settle((o) => o.wc === wc)
    })
    wc.on('render-process-gone', () => this.settle((o) => o.wc === wc))
    wc.once('destroyed', () => this.forget((o) => o.wc === wc))
  }

  list(): PageDialog[] {
    return [...this.open.values()].map((o) => o.dialog)
  }

  /** The user's answer. `suppress`: block further dialogs from this origin on this page. */
  respond(id: string, accept: boolean, text: string, suppress: boolean): void {
    const o = this.open.get(id)
    if (!o) return
    this.open.delete(id)
    if (suppress && o.dialog.canSuppress) this.countsFor(o.wc).set(o.key, BLOCKED)
    if (!o.wc.isDestroyed()) o.answer(accept, accept && o.dialog.kind === 'prompt' ? text : '')
    this.notify()
  }

  /** Another tab came on screen, or an agent let go of one: cancel what the hidden ones were asking. */
  dismissHidden(): void {
    this.settle((o) => !this.host.isShown(o.wc) && !this.host.heldForAgent(o.wc))
  }

  /** The tab is closing: let it go without an answer from the user. */
  dismissTab(tabId: TabId): void {
    this.settle((o) => o.dialog.tabId === tabId)
  }

  private run(wc: WebContents, info: RunDialogInfo, answer: Answer): void {
    const frame = info.frame
    const origin = frame && !frame.isDestroyed() ? frame.origin : 'null'
    const key = origin === 'file://' && frame ? frame.url : origin
    // Electron's private getter, as its own handler uses; tabs are created with safeDialogs.
    const prefs = (wc as unknown as { getLastWebPreferences?(): Electron.WebPreferences | null }).getLastWebPreferences?.() ?? {
      safeDialogs: true
    }
    const counts = this.countsFor(wc)
    const seen = counts.get(key) ?? 0
    const tabId = this.host.tabIdFor(wc)
    const reachable = this.host.isShown(wc) || this.host.heldForAgent(wc)
    if (!tabId || prefs.disableDialogs || seen === BLOCKED || !reachable) return answer(false, '')
    counts.set(key, seen + 1)
    const dialog: PageDialog = {
      id: randomUUID(),
      tabId,
      kind: info.dialogType,
      origin,
      message: info.messageText,
      defaultText: info.dialogType === 'prompt' ? info.defaultPromptText : '',
      canSuppress: seen > 0 && prefs.safeDialogs === true
    }
    this.open.set(dialog.id, { dialog, wc, key, answer })
    this.notify()
  }

  private countsFor(wc: WebContents): Map<string, number> {
    let counts = this.counts.get(wc)
    if (!counts) this.counts.set(wc, (counts = new Map()))
    return counts
  }

  /** Answer "cancel" for the matching dialogs. */
  private settle(match: (o: OpenDialog) => boolean): void {
    const gone = this.forget(match)
    for (const o of gone) if (!o.wc.isDestroyed()) o.answer(false, '')
  }

  private forget(match: (o: OpenDialog) => boolean): OpenDialog[] {
    const gone = [...this.open.values()].filter(match)
    if (gone.length === 0) return gone
    for (const o of gone) this.open.delete(o.dialog.id)
    this.notify()
    return gone
  }

  private notify(): void {
    this.host.changed(this.list())
  }
}
