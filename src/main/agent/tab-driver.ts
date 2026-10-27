import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { WebContents, WebContentsView } from 'electron'
import type { Rect } from '@shared/layout'
import type { PageDialog } from '@shared/types'
import { outPath } from '../app/environment'
import { ToolError } from './mcp-server'

// One live tab as an agent drives it. Reading goes through the page runtime
// (src/preload/agent-runtime.ts) in its own isolated world; acting goes
// through Chromium's input pipeline (`sendInputEvent`, `insertText`), so the
// page sees trusted events exactly as if the user had clicked or typed. Both
// work on background tabs, which are kept awake while an agent uses them (see
// `wake`). The DevTools protocol is attached only for what nothing else can
// do: waking, network logs, file inputs, file choosers.

/** Isolated world of the page runtime (Electron's context isolation uses 999). */
const AGENT_WORLD = 1001
const PAGE_TIMEOUT_MS = 10_000
const LOAD_TIMEOUT_MS = 15_000
/** Screenshots fit this long edge and pixel count (what vision models take in without downscaling). */
const SHOT_MAX_EDGE = 1440
const SHOT_MAX_PIXELS = 1_150_000
const NETWORK_LIMIT = 500
const CONSOLE_LIMIT = 300
/** A page stays awake this long after the agent last touched it. */
const AWAKE_MS = 3000
/** Longest wait for the first frame after waking (a busy page answers late). */
const FIRST_FRAME_MS = 500
/**
 * The glow around a page an agent works in goes out by itself this long
 * after the agent's last call: a little after the agent service turns it off
 * (see AgentService), in case that never reaches the page.
 */
const PRESENCE_TTL_MS = 50_000

/** What the agent's cursor says it is doing. */
export type CursorVerb = 'click' | 'hover' | 'type' | 'fill' | 'drag' | 'scroll' | 'key' | 'read' | 'find'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Where an action lands, in top-level viewport CSS pixels. */
export interface Target {
  x: number
  y: number
  rect: Box | null
  label: string
  covered: string | null
  disabled: boolean
  file: boolean
}

export interface ConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error'
  text: string
  source: string
  line: number
  at: number
}

interface NetworkEntry {
  id: string
  method: string
  url: string
  type: string
  status: number | null
  mimeType: string
  started: number
  ms: number | null
  bytes: number | null
  error: string | null
  /** Where a cached response came from ("memory cache", "disk cache"...), as DevTools names it. */
  cache: string | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  postData: string | null
}

export interface DriverHost {
  /** The tab is the one on screen (the cursor is drawn only then). */
  isShown(): boolean
  /** Bounds for a view that was never shown (it has no size, so nothing lays out). */
  cardBounds(): Rect | null
  /** Ids of every tab, to notice tabs an action opened. */
  tabIds(): string[]
  describeTab(id: string): string
  /** Native context menus run a nested loop; suppress them around agent right-clicks. */
  suppressContextMenu(wc: WebContents, ms: number): void
  /** The alert / confirm / prompt the page is blocked on, if any. */
  pendingDialog(): PageDialog | undefined
  /** What the cursor's tag says, in the user's language ("Clicking “Sign in”"). */
  cursorText(verb: CursorVerb, target: string): string
}

let runtimeSource: string | null = null

/** How a waiting dialog reads to an agent, and what to do about it. */
export function describeDialog(d: PageDialog): string {
  const answer = d.kind === 'alert' ? 'accept: true' : d.kind === 'prompt' ? 'accept and text, or accept: false' : 'accept: true (OK) or false (Cancel)'
  return `The page is waiting on a ${d.kind} dialog: ${JSON.stringify(d.message)}. Answer it with handle_dialog (${answer}); the page does nothing until then.`
}

function runtimeCode(): string {
  runtimeSource ??= readFileSync(outPath('preload', 'agent-runtime.cjs'), 'utf8')
  return runtimeSource
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ToolError(message)), ms)
    })
  ])
}

export function waitForLoad(wc: WebContents, timeout = LOAD_TIMEOUT_MS): Promise<boolean> {
  if (wc.isDestroyed() || !wc.isLoading()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer)
      wc.off('did-stop-loading', stopped)
      wc.off('destroyed', gone)
      resolve(ok)
    }
    const stopped = () => done(true)
    const gone = () => done(false)
    const timer = setTimeout(() => done(false), timeout)
    wc.on('did-stop-loading', stopped)
    wc.once('destroyed', gone)
  })
}

// -- keys ---------------------------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  ' ': 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  plus: 'Plus'
}

const MODIFIERS: Record<string, 'meta' | 'control' | 'alt' | 'shift'> = {
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift'
}

/** Characters a key press types (Enter submits through its char event). */
const KEY_CHARS: Record<string, string> = { Enter: '\r', Space: ' ' }

/**
 * macOS editing shortcuts reach a page through the menu, not as key events,
 * so a synthesized ⌘A selects nothing. These run the edit command instead.
 */
const EDIT_COMMANDS: Record<string, (wc: WebContents) => void> = {
  'meta+a': (wc) => wc.selectAll(),
  'meta+c': (wc) => wc.copy(),
  'meta+x': (wc) => wc.cut(),
  'meta+v': (wc) => wc.paste(),
  'meta+z': (wc) => wc.undo(),
  'meta+shift+z': (wc) => wc.redo()
}

export function parseKeys(combo: string): { key: string; modifiers: Array<'meta' | 'control' | 'alt' | 'shift'> } {
  const parts = combo.split(/\+(?!$)/).map((p) => p.trim())
  const rawKey = parts.pop() ?? ''
  const modifiers: Array<'meta' | 'control' | 'alt' | 'shift'> = []
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()]
    if (!m) throw new ToolError(`Unknown modifier "${p}" (use Meta, Control, Alt or Shift)`)
    if (!modifiers.includes(m)) modifiers.push(m)
  }
  const named = KEY_NAMES[rawKey.toLowerCase()]
  const key = named ?? (/^f([1-9]|1\d|2[0-4])$/i.test(rawKey) ? rawKey.toUpperCase() : rawKey)
  if (!named && key.length !== 1 && !/^F\d+$/.test(key)) throw new ToolError(`Unknown key "${rawKey}"`)
  return { key, modifiers }
}

// -- evaluate -------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (body: string) => unknown

function parseError(body: string): string | null {
  try {
    new AsyncFunction(body)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The body of an async function that runs `script` and returns its value:
 * an expression is returned as is; for statements, the last line's value
 * is returned when it is an expression (like a console), unless the script
 * returns something itself. Only parsed here, never run.
 */
export function evaluateBody(script: string): string {
  const src = script.trim()
  const asExpression = `return (\n${src}\n)`
  if (!parseError(asExpression)) return asExpression
  const problem = parseError(src)
  if (problem) throw new ToolError(`SyntaxError: ${problem}`)
  if (!/\breturn\b/.test(src)) {
    const lines = src.split('\n')
    const last = lines.pop()!.trim().replace(/;+$/, '')
    const withReturn = `${lines.join('\n')}\nreturn (\n${last}\n)`
    if (last && !parseError(withReturn)) return withReturn
  }
  return src
}

/** Turns any page value into readable text (runs in the page). */
const FORMAT_VALUE = `(value) => {
  const MAX = 50000
  const describeNode = (n) => {
    if (n.nodeType === 1) { const h = n.outerHTML; return h.length > 500 ? h.slice(0, 500) + '…' : h }
    return String(n.nodeValue ?? n.nodeName)
  }
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value.length > MAX ? value.slice(0, MAX) + '…' : value
  if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']'
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value)
  if (value instanceof Node) return describeNode(value)
  if (value instanceof Error) return String(value.stack || value)
  const seen = new WeakSet()
  const text = JSON.stringify(value, (key, v) => {
    if (typeof v === 'bigint') return String(v) + 'n'
    if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']'
    if (v instanceof Node) return describeNode(v)
    if (v instanceof Map) return Object.fromEntries(v)
    if (v instanceof Set) return [...v]
    if (v && typeof v === 'object') { if (seen.has(v)) return '[Circular]'; seen.add(v) }
    if (v && typeof v === 'object' && typeof v.length === 'number' && !Array.isArray(v) && typeof v.item === 'function') return Array.from(v)
    return v
  }, 2)
  if (text === undefined) return String(value)
  return text.length > MAX ? text.slice(0, MAX) + '…' : text
}`

// -- the driver -------------------------------------------------------------------

export class TabDriver {
  /** Image pixels per CSS pixel of the last full screenshot (coordinates agents pass back). */
  private shotScale = 1
  private debuggerAttached = false
  private network: Map<string, NetworkEntry> | null = null
  private networkSince = 0
  private chooser: { backendNodeId: number; multiple: boolean } | null = null
  /** Name on the cursor: the agent acting right now. */
  actor = 'Agent'
  /** Actions on this tab run one after another, even when an agent sends them in parallel. */
  private queue: Promise<unknown> = Promise.resolve()
  private chooserTimer: NodeJS.Timeout | null = null
  /** Settles once the page is awake; null while it sleeps (see wake). */
  private awake: Promise<void> | null = null
  private awakeUntil = 0
  private sleepTimer: NodeJS.Timeout | null = null

  constructor(
    readonly tabId: string,
    readonly view: WebContentsView,
    private readonly host: DriverHost,
    private readonly refs: { next: number },
    readonly console: ConsoleEntry[]
  ) {}

  get wc(): WebContents {
    return this.view.webContents
  }

  get alive(): boolean {
    return !this.wc.isDestroyed()
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Never-shown views are 0×0: give them the card's size so the page lays out and can be clicked. */
  ensureSized(): void {
    const bounds = this.view.getBounds()
    if (bounds.width > 0 && bounds.height > 0) return
    const card = this.host.cardBounds()
    if (card && card.width > 0) this.view.setBounds(card)
  }

  /**
   * Keep the page rendering as if it were on screen until it has been left
   * alone for `ms`. A background tab is hidden: Chromium stops its rAF,
   * IntersectionObserver and CSS transitions and throttles its timers, and a
   * page that has never painted drops input and cannot be captured. Focus
   * emulation counts as a visible capturer, so it wakes the page without
   * putting it on screen; the page also acts focused, as for a user typing
   * into it. Best effort: reads work without it.
   */
  wake(ms = AWAKE_MS): Promise<void> {
    if (!this.alive) return Promise.resolve()
    const until = Date.now() + ms
    if (until > this.awakeUntil) {
      this.awakeUntil = until
      if (this.sleepTimer) clearTimeout(this.sleepTimer)
      this.sleepTimer = setTimeout(() => this.sleep(), ms)
    }
    this.awake ??= this.cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
      .then(() => this.nextFrame())
      .catch(() => undefined)
    return this.awake
  }

  private sleep(): void {
    this.sleepTimer = null
    this.awakeUntil = 0
    if (!this.awake) return
    this.awake = null
    if (this.debuggerAttached && this.alive) {
      void this.wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined)
    }
  }

  /** Wait for a frame: until the page has painted, it ignores input. */
  private async nextFrame(): Promise<void> {
    const code = 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))'
    await withTimeout(this.wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }]), FIRST_FRAME_MS, '').catch(() => undefined)
  }

  /** Call the page runtime, injecting it first into a document that does not have it yet. */
  /** A page showing alert / confirm / prompt is frozen; say so instead of timing out. */
  private checkDialog(): void {
    const dialog = this.host.pendingDialog()
    if (dialog) throw new ToolError(describeDialog(dialog))
  }

  async call<T>(method: string, args: Record<string, unknown> = {}, timeout = PAGE_TIMEOUT_MS): Promise<T> {
    if (!this.alive) throw new ToolError('The tab was closed')
    this.checkDialog()
    await this.wake()
    const code =
      `if (!globalThis.__arcAgent) { (() => { ${runtimeCode()} })(); globalThis.__arcAgent = globalThis.__arcAgentCreate(${this.refs.next}) }\n` +
      `globalThis.__arcAgent.call(${JSON.stringify(method)}, ${JSON.stringify(args)})`
    let reply: { value?: T; error?: string; next: number } | undefined
    try {
      reply = await withTimeout(
        this.wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }]),
        timeout,
        'The page did not answer in time (it may be busy, or still loading)'
      )
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`The page could not run the request: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!reply) throw new ToolError('The page has no document yet (still loading?)')
    this.refs.next = Math.max(this.refs.next, reply.next)
    if (reply.error !== undefined) throw new ToolError(reply.error)
    return reply.value as T
  }

  // -- targets ------------------------------------------------------------------

  /** Resolve a ref (scrolled into view) or a screenshot coordinate to a point on the page. */
  async target(spec: { ref?: unknown; x?: unknown; y?: unknown }): Promise<Target> {
    this.ensureSized()
    if (typeof spec.ref === 'string' && spec.ref) return this.call<Target>('target', { ref: spec.ref })
    if (typeof spec.x === 'number' && typeof spec.y === 'number') {
      return this.call<Target>('pointInfo', { x: spec.x / this.shotScale, y: spec.y / this.shotScale })
    }
    throw new ToolError('Pass a ref (from snapshot or find), or x and y (from a screenshot)')
  }

  // -- what the user sees -----------------------------------------------------------

  private async showCursor(t: Target, verb: CursorVerb): Promise<void> {
    if (!this.host.isShown()) return
    const status = this.host.cursorText(verb, targetName(t.label))
    await this.call('moveCursor', { x: t.x, y: t.y, rect: t.rect, name: this.actor, status }).catch(() => undefined)
  }

  private ripple(t: Target): void {
    if (this.host.isShown()) void this.call('clickRipple', { x: t.x, y: t.y }).catch(() => undefined)
  }

  /** Tell the user what the agent is doing where its cursor already is. */
  say(verb: CursorVerb, target = ''): void {
    if (this.host.isShown()) void this.call('cursorStatus', { status: this.host.cursorText(verb, target) }).catch(() => undefined)
  }

  /** Reading: a scan line sweeps the page (the tag says so if the cursor is out). */
  scan(verb: 'read' | 'find', target = ''): void {
    if (this.host.isShown()) void this.call('scan', { name: this.actor, status: this.host.cursorText(verb, target) }).catch(() => undefined)
  }

  /**
   * The glow around the page while an agent works in it, drawn only while the
   * user can see the tab. Turning it off never injects the page runtime into a
   * page that does not have it (a page the tab has since navigated to).
   */
  presence(on: boolean): void {
    if (!this.alive) return
    if (on) {
      if (this.host.isShown() && !this.host.pendingDialog()) {
        void this.call('presence', { on: true, name: this.actor, ttl: PRESENCE_TTL_MS }).catch(() => undefined)
      }
      return
    }
    const code = "globalThis.__arcAgent?.call('presence', { on: false })"
    void this.wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }]).catch(() => undefined)
  }

  // -- mouse ----------------------------------------------------------------------

  private mouse(
    type: 'mouseMove' | 'mouseDown' | 'mouseUp',
    x: number,
    y: number,
    extra: { button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: string[] } = {}
  ): void {
    const zoom = this.wc.getZoomFactor()
    this.wc.sendInputEvent({ type, x: Math.round(x * zoom), y: Math.round(y * zoom), ...extra } as Electron.MouseInputEvent)
  }

  async click(
    t: Target,
    opts: { button?: 'left' | 'right' | 'middle'; count?: number; modifiers?: string[]; verb?: CursorVerb } = {}
  ): Promise<void> {
    const button = opts.button ?? 'left'
    const modifiers = opts.modifiers ?? []
    await this.showCursor(t, opts.verb ?? 'click')
    if (button === 'right') this.host.suppressContextMenu(this.wc, 1500)
    // File pickers would open a native dialog nobody is there to answer: catch them.
    await this.interceptFileChooser(true)
    this.mouse('mouseMove', t.x, t.y, { modifiers })
    for (let i = 1; i <= (opts.count ?? 1); i += 1) {
      this.mouse('mouseDown', t.x, t.y, { button, clickCount: i, modifiers })
      this.mouse('mouseUp', t.x, t.y, { button, clickCount: i, modifiers })
    }
    this.ripple(t)
  }

  async hover(t: Target, verb: CursorVerb = 'hover'): Promise<void> {
    await this.showCursor(t, verb)
    this.mouse('mouseMove', t.x, t.y)
  }

  async drag(from: Target, to: Target): Promise<void> {
    await this.showCursor(from, 'drag')
    this.mouse('mouseMove', from.x, from.y)
    this.mouse('mouseDown', from.x, from.y, { button: 'left', clickCount: 1 })
    const steps = 12
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps
      const y = from.y + ((to.y - from.y) * i) / steps
      this.mouse('mouseMove', x, y, { button: 'left', modifiers: ['leftButtonDown'] })
      await sleep(16)
    }
    await this.showCursor({ ...to, rect: null }, 'drag')
    this.mouse('mouseUp', to.x, to.y, { button: 'left', clickCount: 1 })
  }

  /** Wheel at a point; falls back to scrolling the container in the page when the wheel moved nothing. */
  async scroll(at: { x: number; y: number }, dx: number, dy: number) {
    type State = { container: string | null; top: number; left: number; height: number; view: number }
    const before = await this.call<State>('scrollState', at)
    await this.showCursor({ x: at.x, y: at.y, rect: null, label: '', covered: null, disabled: false, file: false }, 'scroll')
    const zoom = this.wc.getZoomFactor()
    this.wc.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(at.x * zoom),
      y: Math.round(at.y * zoom),
      deltaX: -dx,
      deltaY: -dy,
      canScroll: true,
      hasPreciseScrollingDeltas: true
    } as Electron.MouseWheelInputEvent)
    await sleep(150)
    let after = await this.call<State>('scrollState', at)
    if (after.top === before.top && after.left === before.left) after = await this.call<State>('scrollBy', { ...at, dx, dy })
    return after
  }

  // -- keyboard -----------------------------------------------------------------------

  async typeText(text: string, slowly = false): Promise<void> {
    this.checkDialog()
    if (!slowly) {
      await this.wc.insertText(text)
      return
    }
    for (const ch of text) {
      if (ch === '\n') await this.pressKey('Enter')
      else if (/^[\x20-\x7e]$/.test(ch)) {
        this.wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
        this.wc.sendInputEvent({ type: 'char', keyCode: ch })
        this.wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
      } else await this.wc.insertText(ch)
      await sleep(30)
    }
  }

  async pressKey(combo: string, count = 1): Promise<void> {
    this.checkDialog()
    const { key, modifiers } = parseKeys(combo)
    const id = [...modifiers.slice().sort(), key.toLowerCase()].join('+')
    const edit = EDIT_COMMANDS[id]
    for (let i = 0; i < count; i += 1) {
      if (edit) {
        edit(this.wc)
      } else {
        this.wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
        const typesChar = !modifiers.some((m) => m === 'meta' || m === 'control' || m === 'alt')
        const ch = KEY_CHARS[key] ?? (key.length === 1 ? key : null)
        if (typesChar && ch) this.wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers })
        this.wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
      }
      if (count > 1) await sleep(20)
    }
  }

  // -- watching what an action does -------------------------------------------------------

  /** Start watching; the returned function waits for the page to settle and says what changed. */
  watch(): () => Promise<string[]> {
    const wc = this.wc
    const startUrl = wc.getURL()
    const tabsBefore = new Set(this.host.tabIds())
    const dialogBefore = this.host.pendingDialog()?.id
    let navigated = false
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) navigated = true
    }
    wc.on('did-start-navigation', onNavigation)
    return async () => {
      await sleep(150)
      let stillLoading = false
      if (!wc.isDestroyed() && (navigated || wc.isLoading())) stillLoading = !(await waitForLoad(wc))
      await this.interceptFileChooser(false)
      if (wc.isDestroyed()) return ['The tab closed itself.']
      wc.off('did-start-navigation', onNavigation)
      const notes: string[] = []
      const url = wc.getURL()
      if (url !== startUrl) notes.push(`The page is now ${JSON.stringify(wc.getTitle())} ${url}${stillLoading ? ' (still loading)' : ''}`)
      else if (stillLoading) notes.push('The page is still loading.')
      for (const id of this.host.tabIds()) if (!tabsBefore.has(id)) notes.push(`It opened a new tab: ${this.host.describeTab(id)}`)
      const dialog = this.host.pendingDialog()
      if (dialog && dialog.id !== dialogBefore) notes.push(describeDialog(dialog).replace('The page is waiting on', 'It opened'))
      if (this.chooser) notes.push('It opened a file chooser (not shown); call upload_file with the paths to choose.')
      return notes
    }
  }

  // -- screenshots ------------------------------------------------------------------------

  async screenshot(opts: { ref?: string; format: 'jpeg' | 'png' }): Promise<{ data: string; mimeType: string; text: string }> {
    this.ensureSized()
    await this.wake()
    const zoom = this.wc.getZoomFactor()
    let rect: Box | null = null
    let clipped = false
    if (opts.ref) {
      const shot = await this.call<{ rect: Box; clipped: boolean }>('shotBox', { ref: opts.ref })
      rect = shot.rect
      clipped = shot.clipped
    }
    const bounds = this.view.getBounds()
    const css = rect ?? { x: 0, y: 0, width: bounds.width / zoom, height: bounds.height / zoom }
    const hidOverlay = await this.call<boolean>('overlayVisible', { visible: false }).catch(() => false)
    let image: Electron.NativeImage
    try {
      image = rect
        ? await this.wc.capturePage({
            x: Math.max(0, Math.floor(rect.x * zoom)),
            y: Math.max(0, Math.floor(rect.y * zoom)),
            width: Math.ceil(rect.width * zoom),
            height: Math.ceil(rect.height * zoom)
          })
        : await this.wc.capturePage()
    } finally {
      if (hidOverlay) void this.call('overlayVisible', { visible: true }).catch(() => undefined)
    }
    if (image.isEmpty()) throw new ToolError('The page has not painted anything yet')
    const scale = Math.min(1, SHOT_MAX_EDGE / css.width, SHOT_MAX_EDGE / css.height, Math.sqrt(SHOT_MAX_PIXELS / (css.width * css.height)))
    const width = Math.max(1, Math.round(css.width * scale))
    const height = Math.max(1, Math.round(css.height * scale))
    const sized = image.resize({ width, height, quality: 'good' })
    if (!rect) this.shotScale = scale
    const data = opts.format === 'png' ? sized.toPNG() : sized.toJPEG(80)
    const text = rect
      ? `Element screenshot, ${width}×${height}${clipped ? ' (cut to the viewport: the element is larger)' : ''}.`
      : `Viewport screenshot, ${width}×${height} px${scale < 1 ? ` (page is ${Math.round(css.width)}×${Math.round(css.height)} CSS px)` : ''}. ` +
        'Pass x/y in these image coordinates to click, hover or drag.'
    return { data: data.toString('base64'), mimeType: opts.format === 'png' ? 'image/png' : 'image/jpeg', text }
  }

  // -- JavaScript ---------------------------------------------------------------------------

  /** Run `script` in the page's own world (so it sees the page's globals). */
  async evaluate(script: string, timeout = 15_000): Promise<{ ok: boolean; text: string }> {
    this.checkDialog()
    const body = evaluateBody(script)
    const code =
      `(async () => { try { const value = await (async () => {\n${body}\n})(); return { ok: true, text: (${FORMAT_VALUE})(value) } }` +
      ` catch (error) { return { ok: false, text: String((error && error.stack) || error) } } })()`
    await this.wake()
    const result = (await withTimeout(
      this.wc.executeJavaScript(code, true),
      timeout,
      `The script did not finish within ${timeout / 1000} s`
    )) as { ok: boolean; text: string } | undefined
    return result ?? { ok: true, text: 'undefined' }
  }

  // -- DevTools protocol ------------------------------------------------------------------------

  /** Attach the DevTools protocol once. Synchronous, so commands sent right after reach the page before it loads. */
  private attachDebugger(): void {
    if (this.debuggerAttached) return
    const dbg = this.wc.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
    } catch (error) {
      throw new ToolError(`Cannot inspect this tab (${error instanceof Error ? error.message : String(error)}). Close its DevTools and retry.`)
    }
    this.debuggerAttached = true
    dbg.on('message', (_event, method: string, params: Record<string, unknown>) => this.onProtocolEvent(method, params))
    dbg.on('detach', () => {
      this.debuggerAttached = false
      this.network = null
      // Focus emulation went with the session.
      this.awake = null
    })
    void dbg.sendCommand('Page.enable').catch(() => undefined)
  }

  private async cdp(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.attachDebugger()
    return (await this.wc.debugger.sendCommand(method, params)) as Record<string, unknown>
  }

  private onProtocolEvent(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case 'Page.fileChooserOpened':
        this.chooser = { backendNodeId: Number(p.backendNodeId), multiple: p.mode === 'selectMultiple' }
        return
    }
    const log = this.network
    if (!log) return
    const id = String(p.requestId ?? '')
    switch (method) {
      case 'Network.requestWillBeSent': {
        const request = p.request as { url: string; method: string; headers: Record<string, string>; postData?: string }
        if (request.url.startsWith('data:')) return
        log.delete(id)
        log.set(id, {
          id,
          method: request.method,
          url: request.url,
          type: String(p.type ?? 'Other'),
          status: null,
          mimeType: '',
          started: Number(p.timestamp ?? 0),
          ms: null,
          bytes: null,
          error: null,
          cache: null,
          requestHeaders: request.headers ?? {},
          responseHeaders: {},
          postData: request.postData ?? null
        })
        if (log.size > NETWORK_LIMIT) log.delete(log.keys().next().value!)
        return
      }
      case 'Network.requestServedFromCache': {
        const entry = log.get(id)
        if (entry) entry.cache = 'memory cache'
        return
      }
      case 'Network.responseReceived': {
        const entry = log.get(id)
        const response = p.response as {
          status: number
          mimeType: string
          headers: Record<string, string>
          fromDiskCache?: boolean
          fromServiceWorker?: boolean
          fromPrefetchCache?: boolean
        }
        if (!entry) return
        Object.assign(entry, { status: response.status, mimeType: response.mimeType, responseHeaders: response.headers ?? {} })
        entry.cache ??= response.fromDiskCache
          ? 'disk cache'
          : response.fromServiceWorker
            ? 'service worker'
            : response.fromPrefetchCache
              ? 'prefetch cache'
              : null
        return
      }
      case 'Network.loadingFinished': {
        const entry = log.get(id)
        if (entry) Object.assign(entry, { ms: Math.round((Number(p.timestamp) - entry.started) * 1000), bytes: Number(p.encodedDataLength ?? 0) })
        return
      }
      case 'Network.loadingFailed': {
        const entry = log.get(id)
        if (entry) Object.assign(entry, { error: p.canceled ? 'canceled' : String(p.errorText ?? 'failed'), ms: Math.round((Number(p.timestamp) - entry.started) * 1000) })
      }
    }
  }

  /**
   * While on, file inputs the page opens report to us instead of showing a
   * dialog. Only around an agent's click: left on, the user's own clicks on
   * file inputs in this tab would do nothing. A timer turns it off whatever happens.
   */
  private async interceptFileChooser(on: boolean): Promise<void> {
    if (this.chooserTimer) clearTimeout(this.chooserTimer)
    this.chooserTimer = on ? setTimeout(() => void this.interceptFileChooser(false), 5000) : null
    if (on) this.chooser = null
    if (!on && !this.debuggerAttached) return
    if (!this.alive) return
    // The command waits on the page, which a JS dialog freezes; never hang an action on it.
    const sent = this.cdp('Page.setInterceptFileChooserDialog', { enabled: on }).catch(() => undefined)
    if (!this.host.pendingDialog()) await withTimeout(sent, 1000, '').catch(() => undefined)
  }

  /** Start recording network requests (idempotent). */
  async recordNetwork(): Promise<void> {
    if (this.network) return
    this.attachDebugger()
    this.network = new Map()
    this.networkSince = Date.now()
    try {
      await this.wc.debugger.sendCommand('Network.enable', { maxResourceBufferSize: 10 << 20, maxTotalBufferSize: 50 << 20 })
    } catch (error) {
      this.network = null
      throw error
    }
  }

  get recordingNetwork(): boolean {
    return this.network !== null
  }

  networkLog(filter: string, clear: boolean): string {
    const log = this.network
    if (!log) return ''
    const needle = filter.toLowerCase()
    // Query strings often carry other URLs (trackers, redirects): search them only when the filter looks like one.
    const searchQuery = /[?=&]/.test(needle)
    const matches = (url: string) => (searchQuery ? url : url.replace(/[?#].*$/s, '')).toLowerCase().includes(needle)
    const entries = [...log.values()].filter((e) => !needle || matches(e.url) || e.type.toLowerCase() === needle)
    if (clear) log.clear()
    const since = new Date(this.networkSince).toLocaleTimeString('en-GB')
    if (entries.length === 0) return `No requests${needle ? ` matching "${filter}"` : ''} recorded since ${since}.`
    const lines = entries.slice(-150).map((e) => {
      const status = e.error ? `ERR(${e.error})` : (e.status ?? '…')
      // A cache hit transfers nothing: say where it came from instead of "0 B".
      const size = e.cache && !e.bytes ? ` (${e.cache})` : e.bytes === null ? '' : e.bytes > 1024 ? ` ${(e.bytes / 1024).toFixed(1)} KB` : ` ${e.bytes} B`
      const time = e.ms === null ? '' : ` ${e.ms} ms`
      return `[${e.id}] ${e.method} ${status} ${e.type.toLowerCase()} ${e.url.length > 200 ? `${e.url.slice(0, 199)}…` : e.url}${size}${time}`
    })
    const head = `${entries.length} request${entries.length === 1 ? '' : 's'} since ${since}${entries.length > 150 ? ' (latest 150 shown)' : ''}:`
    return [head, ...lines].join('\n')
  }

  async networkDetail(id: string): Promise<string> {
    const entry = this.network?.get(id)
    if (!entry) throw new ToolError(`No recorded request ${id}`)
    const headers = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `  ${k}: ${v.length > 300 ? `${v.slice(0, 299)}…` : v}`)
    const lines = [
      `${entry.method} ${entry.url}`,
      `Status: ${entry.error ?? entry.status ?? 'pending'}  Type: ${entry.type}  MIME: ${entry.mimeType || '?'}${entry.cache ? `  From: ${entry.cache}` : ''}`,
      'Request headers:',
      ...headers(entry.requestHeaders)
    ]
    if (entry.postData) lines.push('Request body:', entry.postData.length > 8000 ? `${entry.postData.slice(0, 8000)}…` : entry.postData)
    lines.push('Response headers:', ...headers(entry.responseHeaders))
    if (entry.status !== null && !entry.error) {
      try {
        const { body, base64Encoded } = (await this.cdp('Network.getResponseBody', { requestId: id })) as { body: string; base64Encoded: boolean }
        const textual = /json|text|javascript|xml|html|css|svg|x-www-form/.test(entry.mimeType)
        const text = base64Encoded ? (textual ? Buffer.from(body, 'base64').toString('utf8') : null) : body
        if (text === null) lines.push(`Response body: (binary, ${Buffer.from(body, 'base64').length} bytes)`)
        else lines.push('Response body:', text.length > 20_000 ? `${text.slice(0, 20_000)}… (${text.length} chars)` : text)
      } catch {
        lines.push('Response body: (no longer available)')
      }
    }
    return lines.join('\n')
  }

  // -- file inputs -----------------------------------------------------------------------------

  async upload(ref: string | undefined, files: string[]): Promise<string> {
    for (const f of files) {
      if (!isAbsolute(f)) throw new ToolError(`Use absolute paths: ${f}`)
      if (!existsSync(f)) throw new ToolError(`No such file: ${f}`)
    }
    if (!ref) {
      const chooser = this.chooser
      if (!chooser) throw new ToolError('Pass the ref of a file input (type=file in snapshots), or click the upload button first')
      await this.cdp('DOM.getDocument', { depth: 0 })
      await this.cdp('DOM.setFileInputFiles', { files: chooser.multiple ? files : files.slice(0, 1), backendNodeId: chooser.backendNodeId })
      this.chooser = null
      return `Chose ${files.length} file${files.length === 1 ? '' : 's'} in the file chooser`
    }
    const nonce = randomUUID()
    const input = await this.call<{ label: string; multiple: boolean }>('markUpload', { ref, nonce })
    try {
      await this.cdp('DOM.getDocument', { depth: -1, pierce: true })
      const search = (await this.cdp('DOM.performSearch', { query: `[data-arc-agent-upload="${nonce}"]`, includeUserAgentShadowDOM: false })) as {
        searchId: string
        resultCount: number
      }
      const found = search.resultCount
        ? ((await this.cdp('DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: search.resultCount })) as { nodeIds: number[] })
        : { nodeIds: [] }
      await this.cdp('DOM.discardSearchResults', { searchId: search.searchId }).catch(() => undefined)
      const nodeId = found.nodeIds[0]
      if (!nodeId) throw new ToolError('Could not reach that file input')
      await this.cdp('DOM.setFileInputFiles', { files: input.multiple ? files : files.slice(0, 1), nodeId })
    } finally {
      await this.call('unmarkUpload', { nonce }).catch(() => undefined)
    }
    return `Set ${input.label} to ${files.map((f) => f.split('/').pop()).join(', ')}`
  }

  detach(): void {
    if (this.chooserTimer) clearTimeout(this.chooserTimer)
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    this.awake = null
    this.awakeUntil = 0
    if (this.debuggerAttached && this.alive) {
      try {
        this.wc.debugger.detach()
      } catch {
        // Already gone.
      }
    }
    this.debuggerAttached = false
    this.network = null
  }
}

/** The name in a target's label (`button "Sign in" [e12]` → “Sign in”), short enough for the cursor's tag. */
export function targetName(label: string): string {
  const quoted = /"((?:[^"\\]|\\.)*)"/.exec(label)?.[1]
  if (quoted === undefined) return ''
  let name: string
  try {
    name = JSON.parse(`"${quoted}"`) as string
  } catch {
    name = quoted
  }
  return `“${name.length > 32 ? `${name.slice(0, 31)}…` : name}”`
}

export function pushConsole(buffer: ConsoleEntry[], entry: ConsoleEntry): void {
  buffer.push(entry)
  if (buffer.length > CONSOLE_LIMIT) buffer.splice(0, buffer.length - CONSOLE_LIMIT)
}
