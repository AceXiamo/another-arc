import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_PROMPT_IPC } from '@shared/ipc'
import type { PageDialog } from '@shared/types'

const ipc = new Map<string, (event: unknown, ...args: unknown[]) => void>()
vi.mock('electron', () => ({
  ipcMain: { on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => ipc.set(channel, fn) }
}))

const { PageDialogs } = await import('../../src/main/tabs/page-dialogs')

/** Just enough WebContents: Electron's own `-run-dialog` handler is there to be replaced. */
function fakePage(tabId: string, prefs: Electron.WebPreferences = { safeDialogs: true }) {
  const wc = Object.assign(new EventEmitter(), {
    tabId,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    getLastWebPreferences: () => prefs
  })
  wc.on('-run-dialog', () => {
    throw new Error("Electron's handler should have been replaced")
  })
  return wc
}
type FakePage = ReturnType<typeof fakePage>

const frame = (origin: string, url = `${origin}/`) => ({ origin, url, isDestroyed: () => false })

function setup() {
  let shown: FakePage | null = null
  const agentTabs = new Set<string>()
  const changes: PageDialog[][] = []
  const dialogs = new PageDialogs({
    tabIdFor: (wc) => (wc as unknown as FakePage).tabId,
    isShown: (wc) => (wc as unknown) === shown,
    heldForAgent: (wc) => agentTabs.has((wc as unknown as FakePage).tabId),
    changed: (list) => changes.push(list)
  })
  const page = (tabId: string, prefs?: Electron.WebPreferences) => {
    const wc = fakePage(tabId, prefs)
    dialogs.attach(wc as unknown as Electron.WebContents)
    return wc
  }
  const show = (wc: FakePage | null) => {
    shown = wc
  }
  return { dialogs, changes, page, show, agentTabs }
}

/** What Chromium does when a page calls alert / confirm / prompt. */
function run(wc: FakePage, kind: PageDialog['kind'], message: string, origin = 'https://example.com', defaultText = '') {
  const answers: Array<[boolean, string]> = []
  wc.emit(
    '-run-dialog',
    { frame: frame(origin), dialogType: kind, messageText: message, defaultPromptText: defaultText },
    (ok: boolean, text: string) => answers.push([ok, text])
  )
  return answers
}

beforeEach(() => ipc.clear())

describe('PageDialogs', () => {
  it('keeps the dialogs of a background tab an agent drives until the agent lets go', () => {
    const { dialogs, page, show, agentTabs } = setup()
    const shown = page('shown')
    const agent = page('agent')
    show(shown)
    agentTabs.add('agent')
    const answers = run(agent, 'confirm', 'Delete?')
    expect(answers).toEqual([])
    expect(dialogs.list()).toHaveLength(1)

    // Switching tabs does not take it away from the agent…
    dialogs.dismissHidden()
    expect(dialogs.list()).toHaveLength(1)
    dialogs.respond(dialogs.list()[0]!.id, true, '', false)
    expect(answers).toEqual([[true, '']])

    // …but once the agent goes quiet, a waiting dialog is cancelled like any hidden tab's.
    const later = run(agent, 'confirm', 'Again?')
    agentTabs.delete('agent')
    dialogs.dismissHidden()
    expect(later).toEqual([[false, '']])
    expect(dialogs.list()).toEqual([])
  })

  it('shows a dialog from the tab on screen and passes the answer back', () => {
    const { dialogs, page, show } = setup()
    const a = page('a')
    show(a)
    const answers = run(a, 'confirm', 'Delete?')
    expect(answers).toEqual([])
    const [open] = dialogs.list()
    expect(open).toMatchObject({ tabId: 'a', kind: 'confirm', origin: 'https://example.com', message: 'Delete?', canSuppress: false })

    dialogs.respond(open!.id, true, 'ignored', false)
    expect(answers).toEqual([[true, '']])
    expect(dialogs.list()).toEqual([])
  })

  it('returns prompt text only when accepted', () => {
    const { dialogs, page, show } = setup()
    const a = page('a')
    show(a)
    const first = run(a, 'prompt', 'Name?', 'https://example.com', 'Ada')
    expect(dialogs.list()[0]!.defaultText).toBe('Ada')
    dialogs.respond(dialogs.list()[0]!.id, true, 'Grace', false)
    const second = run(a, 'prompt', 'Name?', 'https://example.com', 'Ada')
    dialogs.respond(dialogs.list()[0]!.id, false, 'typed then cancelled', false)
    expect(first).toEqual([[true, 'Grace']])
    expect(second).toEqual([[false, '']])
  })

  it('cancels at once for a tab that is not on screen', () => {
    const { dialogs, page, show } = setup()
    const a = page('a')
    show(page('b'))
    expect(run(a, 'alert', 'hi')).toEqual([[false, '']])
    expect(dialogs.list()).toEqual([])
  })

  it('cancels the open dialog when its tab leaves the screen, navigates or closes', () => {
    const { dialogs, page, show } = setup()
    const a = page('a')
    show(a)
    const switched = run(a, 'confirm', '1')
    show(page('b'))
    dialogs.dismissHidden()
    expect(switched).toEqual([[false, '']])

    show(a)
    const navigated = run(a, 'confirm', '2')
    a.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(navigated).toEqual([[false, '']])

    const closed = run(a, 'confirm', '3')
    dialogs.dismissTab('a')
    expect(closed).toEqual([[false, '']])

    const cancelled = run(a, 'confirm', '4')
    a.emit('-cancel-dialogs', { resetState: false })
    expect(cancelled).toEqual([[false, '']])
    expect(dialogs.list()).toEqual([])
  })

  it('offers to block an origin from its second dialog, and honours it until a fresh start', () => {
    const { dialogs, page, show } = setup()
    const a = page('a')
    show(a)
    run(a, 'alert', 'one')
    expect(dialogs.list()[0]!.canSuppress).toBe(false)
    dialogs.respond(dialogs.list()[0]!.id, true, '', true) // too early to block: ignored
    run(a, 'alert', 'two')
    expect(dialogs.list()[0]!.canSuppress).toBe(true)
    dialogs.respond(dialogs.list()[0]!.id, true, '', true)

    expect(run(a, 'confirm', 'three')).toEqual([[false, '']])
    expect(dialogs.list()).toEqual([])
    // Other origins on the same page are unaffected.
    run(a, 'confirm', 'elsewhere', 'https://other.test')
    expect(dialogs.list()).toHaveLength(1)
    dialogs.respond(dialogs.list()[0]!.id, false, '', false)

    // A user-initiated or cross-site navigation starts over.
    a.emit('-cancel-dialogs', { resetState: true })
    run(a, 'confirm', 'four')
    expect(dialogs.list()).toHaveLength(1)
  })

  it('never offers blocking without safeDialogs, and shows nothing with disableDialogs', () => {
    const { dialogs, page, show } = setup()
    const a = page('a', { safeDialogs: false })
    show(a)
    run(a, 'alert', 'one')
    dialogs.respond(dialogs.list()[0]!.id, true, '', false)
    run(a, 'alert', 'two')
    expect(dialogs.list()[0]!.canSuppress).toBe(false)

    const quiet = page('q', { disableDialogs: true })
    show(quiet)
    expect(run(quiet, 'confirm', 'x')).toEqual([[false, '']])
  })

  it('drops dialogs of a page that is gone without answering it', () => {
    const { dialogs, page, show, changes } = setup()
    const a = page('a')
    show(a)
    const answers = run(a, 'confirm', 'x')
    a.destroyed = true
    a.emit('destroyed')
    expect(answers).toEqual([])
    expect(dialogs.list()).toEqual([])
    expect(changes.at(-1)).toEqual([])
  })

  it('answers prompt() from the page preload over sync IPC', () => {
    const { dialogs, page, show } = setup()
    const a = page('a')
    show(a)
    const event = { sender: a, senderFrame: frame('https://example.com'), returnValue: undefined as unknown }
    ipc.get(PAGE_PROMPT_IPC)!(event, 'Name?', 'Ada')
    expect(dialogs.list()[0]).toMatchObject({ kind: 'prompt', message: 'Name?', defaultText: 'Ada' })
    dialogs.respond(dialogs.list()[0]!.id, true, 'Grace', false)
    expect(event.returnValue).toBe('Grace')

    ipc.get(PAGE_PROMPT_IPC)!(event, 'Name?', '')
    dialogs.respond(dialogs.list()[0]!.id, false, '', false)
    expect(event.returnValue).toBeNull()

    // Not a tab we know, or a malformed message: null, nothing shown.
    const stranger = { sender: fakePage('x'), senderFrame: frame('https://example.com'), returnValue: undefined as unknown }
    ipc.get(PAGE_PROMPT_IPC)!(stranger, 'Name?', '')
    expect(stranger.returnValue).toBeNull()
    ipc.get(PAGE_PROMPT_IPC)!(event, { toString: () => 'x' }, '')
    expect(event.returnValue).toBeNull()
    expect(dialogs.list()).toEqual([])
  })
})
