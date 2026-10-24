import { BaseWindow, WebContentsView, type Rectangle, type WebContents } from 'electron'
import { LAYOUT, pageBounds, pageRadius, type LayoutInput, type Rect } from '@shared/layout'

export interface WindowLayout extends LayoutInput {}

export interface FloatingSurface {
  view: WebContentsView
  /** Bounds relative to the page card. */
  place(card: Rect): Rectangle
  visible: boolean
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
export class BrowserWindowController {
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

  getSurface(id: string): FloatingSurface | undefined {
    return this.surfaces.get(id)
  }

  private attachSurface(surface: FloatingSurface): void {
    surface.view.setBounds(surface.place(this.cardBounds()))
    this.win.contentView.addChildView(surface.view)
    if (this.overlay) this.win.contentView.addChildView(this.shell)
  }

  private raiseFloating(): void {
    for (const surface of this.surfaces.values()) {
      if (surface.visible) this.win.contentView.addChildView(surface.view)
    }
    if (this.overlay) this.win.contentView.addChildView(this.shell)
  }

  focusPage(): void {
    if (this.destroyed) return
    if (this.page && !this.overlay) this.page.webContents.focus()
    else this.shell.webContents.focus()
  }
}
