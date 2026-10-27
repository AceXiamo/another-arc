import { BaseWindow, screen, systemPreferences, WebContentsView, type Rectangle, type WebContents } from 'electron'
import { LAYOUT, pageBounds, pageRadius, type LayoutInput, type Rect } from '@shared/layout'

export interface WindowLayout extends LayoutInput {}

export interface FloatingSurface {
  view: WebContentsView
  /** Bounds relative to the page card. */
  place(card: Rect): Rectangle
  visible: boolean
  /** Stays above the shell even while the shell is raised over the page. */
  topmost?: boolean
}

export interface BrowserWindowOptions {
  bounds: Partial<Rectangle> | null
  layout: WindowLayout
  preload: string
  backgroundColor: string
  devTools: boolean
}

/**
 * One native window: a full-size shell view (sidebar + chrome) with the
 * active page's WebContentsView laid over the content card. Only the active
 * tab's view is attached; background tabs are detached, which lets Chromium
 * throttle them.
 */
/** Title-bar drag: cursor polling interval, click slop and a safety cap if the release is never reported. */
const DRAG_POLL_MS = 8
const DRAG_THRESHOLD = 3
const DRAG_MAX_MS = 60_000

export class BrowserWindowController {
  private dragTimer: NodeJS.Timeout | null = null
  readonly win: BaseWindow
  readonly shell: WebContentsView
  private page: WebContentsView | null = null
  private readonly surfaces = new Map<string, FloatingSurface>()
  private overlay = false
  private layout: WindowLayout
  private onRelayout: (() => void) | null = null

  constructor(opts: BrowserWindowOptions) {
    this.layout = { ...opts.layout }
    this.win = new BaseWindow({
      width: opts.bounds?.width ?? 1280,
      height: opts.bounds?.height ?? 820,
      ...(opts.bounds?.x !== undefined && opts.bounds?.y !== undefined ? { x: opts.bounds.x, y: opts.bounds.y } : {}),
      minWidth: 640,
      minHeight: 420,
      show: false,
      title: 'Another Arc',
      titleBarStyle: 'hiddenInset',
      // Like Chrome: the first click on an inactive window already reaches the
      // shell, so its title-bar areas drag and its sidebar responds right away.
      acceptFirstMouse: true,
      trafficLightPosition: LAYOUT.trafficLights,
      backgroundColor: opts.backgroundColor,
      fullscreenable: true
    })

    this.shell = new WebContentsView({
      webPreferences: {
        preload: opts.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        devTools: opts.devTools,
        // Eagerly cache compiled shell code: it is all ours and all used.
        v8CacheOptions: 'bypassHeatCheckAndEagerCompile',
        enableWebSQL: false,
        backgroundThrottling: false
      }
    })
    // Transparent so that, when the shell is raised above the page for modal
    // overlays, the page stays visible underneath.
    this.shell.setBackgroundColor('#00000000')
    this.win.contentView.addChildView(this.shell)

    this.win.on('resize', () => this.relayout())
    this.win.on('enter-full-screen', () => this.relayout())
    this.win.on('leave-full-screen', () => this.relayout())
    this.relayout()
  }

  get shellContents(): WebContents {
    return this.shell.webContents
  }

  /** True once the native window is gone (app quitting). Every mutator checks it. */
  get destroyed(): boolean {
    return this.win.isDestroyed()
  }

  get isOverlayOpen(): boolean {
    return this.overlay
  }

  get currentPage(): WebContentsView | null {
    return this.page
  }

  setRelayoutListener(fn: () => void): void {
    this.onRelayout = fn
  }

  getLayout(): WindowLayout {
    return this.layout
  }

  setLayout(patch: Partial<WindowLayout>): void {
    this.layout = { ...this.layout, ...patch }
    if (!this.destroyed) this.relayout()
  }

  cardBounds(): Rect {
    if (this.destroyed) return { x: 0, y: 0, width: 0, height: 0 }
    const { width, height } = this.win.getContentBounds()
    return pageBounds({ width, height }, this.layout)
  }

  relayout(): void {
    if (this.win.isDestroyed()) return
    const { width, height } = this.win.getContentBounds()
    this.shell.setBounds({ x: 0, y: 0, width, height })
    const card = pageBounds({ width, height }, this.layout)
    if (this.page) {
      this.page.setBounds(card)
      this.page.setBorderRadius(pageRadius(this.layout))
    }
    for (const surface of this.surfaces.values()) {
      if (surface.visible) surface.view.setBounds(surface.place(card))
    }
    this.onRelayout?.()
  }

  /**
   * Swap the visible page. The new view is attached before the old one is
   * removed so there is never a frame with no page at all.
   */
  showPage(view: WebContentsView | null): void {
    if (view === this.page || this.destroyed) return
    const previous = this.page
    this.page = view
    const children = this.win.contentView
    if (view) {
      view.setBounds(this.cardBounds())
      view.setBorderRadius(pageRadius(this.layout))
      children.addChildView(view)
      this.raiseFloating()
    }
    if (previous) children.removeChildView(previous)
  }

  /** Raise the shell over the page (modal overlays) or put it back below. */
  setOverlay(open: boolean): void {
    if (open === this.overlay || this.destroyed) return
    this.overlay = open
    if (open) {
      this.win.contentView.addChildView(this.shell)
      this.raiseTopmost()
      this.shell.webContents.focus()
    } else {
      if (this.page) this.win.contentView.addChildView(this.page)
      this.raiseFloating()
    }
  }

  addSurface(id: string, surface: FloatingSurface): void {
    this.surfaces.set(id, surface)
    if (surface.visible && !this.destroyed) this.attachSurface(surface)
  }

  setSurfaceVisible(id: string, visible: boolean): void {
    const surface = this.surfaces.get(id)
    if (!surface || surface.visible === visible || this.destroyed) return
    surface.visible = visible
    if (visible) this.attachSurface(surface)
    else this.win.contentView.removeChildView(surface.view)
  }

  /** Move a surface that is already showing, e.g. to another form field. */
  repositionSurface(id: string): void {
    const surface = this.surfaces.get(id)
    if (surface?.visible && !this.destroyed) surface.view.setBounds(surface.place(this.cardBounds()))
  }

  getSurface(id: string): FloatingSurface | undefined {
    return this.surfaces.get(id)
  }

  private attachSurface(surface: FloatingSurface): void {
    surface.view.setBounds(surface.place(this.cardBounds()))
    this.win.contentView.addChildView(surface.view)
    if (this.overlay && !surface.topmost) this.win.contentView.addChildView(this.shell)
    this.raiseTopmost()
  }

  private raiseFloating(): void {
    for (const surface of this.surfaces.values()) {
      if (surface.visible && !surface.topmost) this.win.contentView.addChildView(surface.view)
    }
    if (this.overlay) this.win.contentView.addChildView(this.shell)
    this.raiseTopmost()
  }

  private raiseTopmost(): void {
    for (const surface of this.surfaces.values()) {
      if (surface.visible && surface.topmost) this.win.contentView.addChildView(surface.view)
    }
  }

  // -- title bar -------------------------------------------------------------

  /**
   * Shell-driven title-bar drag. `app-region: drag` is not honoured for the
   * shell's WebContentsView everywhere, so the title-bar areas also report
   * pointer down/up and main moves the window with the cursor in between.
   * Positions are absolute (start position + cursor delta): when the native
   * drag does run, both land on the same spot. The cursor is polled because
   * the page stops seeing pointer moves once the window follows the pointer.
   */
  beginDrag(): void {
    this.endDrag()
    if (this.destroyed || this.win.isFullScreen()) return
    const cursor = screen.getCursorScreenPoint()
    const [x, y] = this.win.getPosition() as [number, number]
    const startedAt = Date.now()
    let moving = false
    this.dragTimer = setInterval(() => {
      if (this.destroyed || Date.now() - startedAt > DRAG_MAX_MS) return this.endDrag()
      const p = screen.getCursorScreenPoint()
      const dx = p.x - cursor.x
      const dy = p.y - cursor.y
      // A click (or the first half of a double-click) never nudges the window.
      if (!moving && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      moving = true
      this.win.setPosition(x + dx, y + dy)
    }, DRAG_POLL_MS)
  }

  endDrag(): void {
    if (this.dragTimer) clearInterval(this.dragTimer)
    this.dragTimer = null
  }

  /** Double-click on a title-bar area: the system setting (zoom by default, minimize, or nothing). */
  titleBarDoubleClick(): void {
    if (this.destroyed || this.win.isFullScreen()) return
    const action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string')
    if (action === 'None') return
    if (action === 'Minimize') this.win.minimize()
    else if (this.win.isMaximized()) this.win.unmaximize()
    else this.win.maximize()
  }

  focusPage(): void {
    if (this.destroyed) return
    if (this.page && !this.overlay) this.page.webContents.focus()
    else this.shell.webContents.focus()
  }
}
