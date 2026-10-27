import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOFILL_INSET, autofillCardHeight, PASSWORD_IPC, type AutofillEntry } from '@shared/passwords'

const SEAL = 'v1:'
const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
vi.mock('electron', () => ({
  ipcMain: { on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => listeners.set(channel, fn) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(SEAL + Buffer.from(text, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buffer: Buffer) => Buffer.from(buffer.toString('utf8').slice(SEAL.length), 'base64').toString('utf8')
  }
}))

const { Database } = await import('../../src/main/persistence/database')
const { PasswordStore } = await import('../../src/main/passwords/password-store')
const { PasswordManager, BLUR_GRACE_MS } = await import('../../src/main/passwords/password-manager')

/** Just enough WebContents for the manager. */
function fakePage(url: string, zoom = 1) {
  return {
    url,
    zoom,
    focused: 0,
    sent: [] as unknown[][],
    isDestroyed: () => false,
    getURL() {
      return this.url
    },
    getZoomFactor() {
      return this.zoom
    },
    focus() {
      this.focused += 1
    },
    send(...args: unknown[]) {
      this.sent.push(args)
    },
    on(channel: string) {
      return this.sent.filter(([c]) => c === channel).map(([, ...rest]) => rest)
    }
  }
}
type Page = ReturnType<typeof fakePage>

const CARD = { x: 100, y: 50, width: 800, height: 600 }
const rect = (y: number, extra: Partial<{ x: number; width: number; height: number }> = {}) => ({
  x: extra.x ?? 20,
  y,
  width: extra.width ?? 300,
  height: extra.height ?? 24
})

let dir: string
let db: InstanceType<typeof Database>
let store: InstanceType<typeof PasswordStore>
let manager: InstanceType<typeof PasswordManager>
let shown: Array<{ entries: AutofillEntry[]; active: number; above: boolean }> = []
let visible: boolean[] = []
let repositions = 0
let dropdownFocused = false
let offers: Array<[string, string]> = []
let isTab = true

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'password-manager-test-'))
  db = new Database(join(dir, 'browser.db'))
  store = new PasswordStore(db)
  shown = []
  visible = []
  repositions = 0
  dropdownFocused = false
  offers = []
  isTab = true
  manager = new PasswordManager(store, {
    tabIdFor: () => (isTab ? 'tab-1' : null),
    setDropdownVisible: (v) => visible.push(v),
    reposition: () => (repositions += 1),
    showEntries: (entries, active, above) => shown.push({ entries, active, above }),
    dropdownFocused: () => dropdownFocused,
    offerToSave: (origin, username) => offers.push([origin, username])
  })
  manager.attach()
})

afterEach(() => {
  vi.useRealTimers()
  db.raw.close()
  rmSync(dir, { recursive: true, force: true })
})

const emit = (channel: string, page: Page, body?: unknown) => listeners.get(channel)!({ sender: page }, body)
const focus = (page: Page, body: unknown) => emit(PASSWORD_IPC.focus, page, body)
const blur = (page: Page, left: boolean) => emit(PASSWORD_IPC.blur, page, { left })
const key = (page: Page, k: string) => emit(PASSWORD_IPC.key, page, k)
const submit = (page: Page, body: unknown) => emit(PASSWORD_IPC.submitted, page, body)
const isOpen = () => manager.current().length > 0

/** A page on a.test with the dropdown open over its password field. */
function openOn(...usernames: string[]): Page {
  for (const name of usernames) store.save('https://a.test', name, `pw-${name}`)
  const page = fakePage('https://a.test/login')
  focus(page, { rect: rect(100), typed: '' })
  return page
}

describe('offering logins', () => {
  it('lists the logins of the page that asked', () => {
    store.save('https://b.test', 'elsewhere', 'p3')
    openOn('ace', 'other')
    expect(shown.at(-1)!.entries.map((e) => e.username).sort()).toEqual(['ace', 'other'])
    expect(visible).toEqual([true])
  })

  it('takes the origin from the page, not from the message', () => {
    store.save('https://b.test', 'victim', 'p')
    focus(fakePage('https://a.test/login'), { origin: 'https://b.test', rect: rect(100), typed: '' })
    expect(shown).toEqual([])
    expect(isOpen()).toBe(false)
  })

  it('narrows the list to what has been typed', () => {
    store.save('https://a.test', 'ace', 'p1')
    store.save('https://a.test', 'other', 'p2')
    focus(fakePage('https://a.test/login'), { rect: rect(100), typed: 'AC' })
    expect(shown.at(-1)!.entries.map((e) => e.username)).toEqual(['ace'])
  })

  it('stays shut for a page with nothing saved, and for anything not a tab', () => {
    focus(fakePage('https://a.test/login'), { rect: rect(100), typed: '' })
    expect(shown).toEqual([])
    store.save('https://a.test', 'ace', 'p')
    isTab = false
    focus(fakePage('https://a.test/login'), { rect: rect(100), typed: '' })
    expect(shown).toEqual([])
  })

  it('ignores a malformed report', () => {
    store.save('https://a.test', 'ace', 'p')
    focus(fakePage('https://a.test/login'), { rect: { x: 'nope' }, typed: '' })
    expect(shown).toEqual([])
  })

  it('tells the page it is open', () => {
    const page = openOn('ace')
    expect(page.on(PASSWORD_IPC.state).at(-1)).toEqual([{ open: true, active: -1 }])
  })
})

describe('staying put', () => {
  it('moves to another field, or narrows, without hiding and showing again', () => {
    const page = openOn('ace', 'other')
    focus(page, { rect: rect(160), typed: '' })
    focus(page, { rect: rect(160), typed: 'a' })
    expect(visible).toEqual([true])
    expect(repositions).toBe(2)
    expect(shown.at(-1)!.entries.map((e) => e.username)).toEqual(['ace'])
  })

  it('follows the field when the page scrolls', () => {
    const page = openOn('ace')
    const before = manager.place(CARD)
    emit(PASSWORD_IPC.move, page, rect(40))
    expect(repositions).toBe(1)
    expect(manager.place(CARD).y).toBe(before.y - 60)
    expect(visible).toEqual([true])
  })

  it('ignores a move from another page, or a bad one', () => {
    openOn('ace')
    emit(PASSWORD_IPC.move, fakePage('https://a.test/other'), rect(40))
    emit(PASSWORD_IPC.move, fakePage('https://a.test/login'), { y: 'x' })
    expect(repositions).toBe(0)
  })
})

describe('closing', () => {
  it('closes at once when focus moves on inside the page', () => {
    const page = openOn('ace')
    blur(page, false)
    expect(isOpen()).toBe(false)
    expect(visible).toEqual([true, false])
    expect(page.on(PASSWORD_IPC.state).at(-1)).toEqual([{ open: false, active: -1 }])
  })

  it('waits a moment when focus left the page, then closes', () => {
    vi.useFakeTimers()
    const page = openOn('ace')
    blur(page, true)
    vi.advanceTimersByTime(BLUR_GRACE_MS - 1)
    expect(isOpen()).toBe(true)
    vi.advanceTimersByTime(2)
    expect(isOpen()).toBe(false)
  })

  it('lets a click on a row win when the page reports losing focus first', () => {
    vi.useFakeTimers()
    const page = openOn('ace')
    const id = manager.current()[0]!.id
    blur(page, true)
    manager.fill(id)
    expect(page.on(PASSWORD_IPC.fill)).toEqual([['ace', 'pw-ace']])
    vi.advanceTimersByTime(BLUR_GRACE_MS * 2)
    expect(visible).toEqual([true, false])
  })

  it('keeps it open, and gives the field the keyboard back, after a click that missed every row', () => {
    vi.useFakeTimers()
    const page = openOn('ace')
    dropdownFocused = true
    blur(page, true)
    vi.advanceTimersByTime(BLUR_GRACE_MS + 1)
    expect(isOpen()).toBe(true)
    expect(page.focused).toBe(1)
  })

  it('keeps it when the user comes straight back into a field', () => {
    vi.useFakeTimers()
    const page = openOn('ace')
    blur(page, true)
    focus(page, { rect: rect(100), typed: '' })
    vi.advanceTimersByTime(BLUR_GRACE_MS * 2)
    expect(isOpen()).toBe(true)
    expect(visible).toEqual([true])
  })

  it('ignores a blur from a page it is not open on', () => {
    openOn('ace')
    blur(fakePage('https://a.test/other'), false)
    expect(isOpen()).toBe(true)
  })
})

describe('filling', () => {
  it('sends the credential to the page, gives it the keyboard back, and counts the use', () => {
    const page = openOn('ace')
    const id = manager.current()[0]!.id
    manager.fill(id)
    expect(page.on(PASSWORD_IPC.fill)).toEqual([['ace', 'pw-ace']])
    expect(page.focused).toBe(1)
    expect(store.list()[0]!.timesUsed).toBe(1)
    expect(isOpen()).toBe(false)
  })

  it('refuses once the page has navigated somewhere else', () => {
    const page = openOn('ace')
    const id = manager.current()[0]!.id
    page.url = 'https://evil.test/'
    manager.fill(id)
    expect(page.on(PASSWORD_IPC.fill)).toEqual([])
  })

  it('refuses an id it did not offer', () => {
    const other = store.save('https://a.test', 'hidden', 'secret')!
    const page = openOn('ace')
    focus(page, { rect: rect(100), typed: 'ac' })
    manager.fill(other.id)
    expect(page.on(PASSWORD_IPC.fill)).toEqual([])
  })
})

describe('the keyboard', () => {
  it('picks a row with the arrows and fills it with Enter', () => {
    const page = openOn('ace', 'bob', 'cat')
    const names = manager.current().map((e) => e.username)
    key(page, 'down')
    key(page, 'down')
    key(page, 'up')
    expect(shown.at(-1)!.active).toBe(0)
    expect(page.on(PASSWORD_IPC.state).at(-1)).toEqual([{ open: true, active: 0 }])
    key(page, 'enter')
    expect(page.on(PASSWORD_IPC.fill)).toEqual([[names[0], `pw-${names[0]}`]])
  })

  it('wraps around at either end', () => {
    const page = openOn('ace', 'bob')
    key(page, 'up')
    expect(shown.at(-1)!.active).toBe(1)
    key(page, 'down')
    expect(shown.at(-1)!.active).toBe(0)
  })

  it('does nothing on Enter with no row picked', () => {
    const page = openOn('ace')
    key(page, 'enter')
    expect(page.on(PASSWORD_IPC.fill)).toEqual([])
    expect(isOpen()).toBe(true)
  })

  it('ignores keys from another page, and keys it does not know', () => {
    const page = openOn('ace')
    key(fakePage('https://a.test/other'), 'down')
    key(page, 'sideways')
    expect(shown.at(-1)!.active).toBe(-1)
  })
})

describe('offering to save', () => {
  it('asks about a sign-in it has not seen', () => {
    submit(fakePage('https://a.test/login'), { username: 'ace', password: 'hunter2' })
    expect(offers).toEqual([['https://a.test', 'ace']])
    manager.resolveSave(true)
    expect(store.forOrigin('https://a.test').map((l) => l.username)).toEqual(['ace'])
  })

  it('stores nothing when the prompt is waved off', () => {
    submit(fakePage('https://a.test/login'), { username: 'ace', password: 'hunter2' })
    manager.resolveSave(false)
    expect(store.list()).toEqual([])
  })

  it('stays quiet when that exact sign-in is already saved', () => {
    store.save('https://a.test', 'ace', 'hunter2')
    submit(fakePage('https://a.test/login'), { username: 'ace', password: 'hunter2' })
    expect(offers).toEqual([])
  })

  it('asks again when the password changed', () => {
    store.save('https://a.test', 'ace', 'old')
    submit(fakePage('https://a.test/login'), { username: 'ace', password: 'new' })
    expect(offers).toHaveLength(1)
    manager.resolveSave(true)
    expect(store.password(store.list()[0]!.id)).toBe('new')
  })

  it('ignores an empty password and absurd values', () => {
    submit(fakePage('https://a.test/login'), { username: 'ace', password: '' })
    submit(fakePage('https://a.test/login'), { username: 'ace', password: 'x'.repeat(2000) })
    expect(offers).toEqual([])
  })
})

describe('where the dropdown goes', () => {
  const open = (fieldRect: ReturnType<typeof rect>, zoom = 1, names = ['ace']) => {
    for (const name of names) store.save('https://a.test', name, 'p')
    focus(fakePage('https://a.test/login', zoom), { rect: fieldRect, typed: '' })
    return manager.place(CARD)
  }

  it('puts the card just under the field, its left edge on the field’s', () => {
    const box = open(rect(100))
    // The surface reaches past the card on each side, for the shadow.
    expect(box.x + AUTOFILL_INSET).toBe(CARD.x + 20)
    expect(box.y).toBe(CARD.y + 100 + 24 + 2)
    expect(box.width).toBe(300 + AUTOFILL_INSET * 2)
  })

  it('is exactly as tall as the card it holds, plus the shadow below', () => {
    expect(open(rect(100), 1, ['a']).height).toBe(autofillCardHeight(1) + AUTOFILL_INSET)
  })

  it('stops growing at four rows; the rest scroll', () => {
    expect(open(rect(100), 1, ['a', 'b', 'c', 'd', 'e', 'f']).height).toBe(autofillCardHeight(4) + AUTOFILL_INSET)
  })

  it('follows the page zoom', () => {
    const box = open(rect(100), 2)
    expect(box.x + AUTOFILL_INSET).toBe(CARD.x + 40)
    expect(box.y).toBe(CARD.y + (100 + 24) * 2 + 2)
  })

  it('flips above a field near the bottom, and tells the shell which side it is on', () => {
    const box = open(rect(570))
    expect(box.y + box.height).toBe(CARD.y + 570 - 2)
    expect(shown.at(-1)!.above).toBe(true)
  })

  it('stays below when there is room, and says so', () => {
    open(rect(100))
    expect(shown.at(-1)!.above).toBe(false)
  })

  it('keeps a narrow field readable and a wide one in hand', () => {
    expect(open(rect(100, { width: 40 })).width).toBe(240 + AUTOFILL_INSET * 2)
    expect(open(rect(100, { width: 2000 })).width).toBe(360 + AUTOFILL_INSET * 2)
  })

  it('never leaves the page card', () => {
    const box = open(rect(100, { x: 790, width: 300 }))
    expect(box.x + box.width).toBeLessThanOrEqual(CARD.x + CARD.width)
    expect(box.y + box.height).toBeLessThanOrEqual(CARD.y + CARD.height)
  })
})
