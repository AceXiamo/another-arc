import {
  BrowserWindow,
  clipboard,
  Menu,
  screen,
  type BaseWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents
} from 'electron'
import type { Translate } from '@shared/i18n'
import { fitPopup, POPUP_FALLBACK, POPUP_MIN } from './popup-fit'
import { clampToArea, placeWindow, type Rect } from './window-placement'

/** An action popup, or a chrome.sidePanel page. */
export type ExtensionSurface = 'popup' | 'panel'

/** Remembered per extension: where its window was, and the side panel's size. */
export interface StoredPlacement {
  x: number
  y: number
  panelWidth?: number
  panelHeight?: number
}

/** Side panels open at about the width of Chrome's side panel. */
export const PANEL_DEFAULT = { width: 380, height: 640 }
const PANEL_MIN = { width: 260, height: 320 }
/** Show the window even if its page never paints, loads or can be measured. */
const PANEL_SHOW_FALLBACK_MS = 1500
const POPUP_SHOW_FALLBACK_MS = 4000
/** `move` fires continuously while dragging; write the position once it settles. */
const SAVE_DELAY_MS = 400

export interface ExtensionWindowHost {
  readonly session: Session
  /** The browser window extension windows belong to. */
  parent(): BaseWindow | null
  /** Titlebar text: the extension's name. */
  title(id: string): string
  readonly t: Translate
  /** Show windows without taking focus (integration tests never take focus). */
  readonly inactive: boolean
  placement(id: string): StoredPlacement | undefined
  savePlacement(id: string, placement: StoredPlacement): void
  openTab(url: string, background: boolean): void
  opened(id: string, surface: ExtensionSurface, url: string): void
  closed(id: string, surface: ExtensionSurface, url: string): void
}

/**
 * Extension UI (action popups and side panels) in small native windows: one
 * per extension, a child of the browser window (above it, but not above
 * other apps), with a standard titlebar so it can be dragged. Unlike Chrome's
 * anchored popup it stays open on blur, so a wallet can sit next to a dApp;
 * it closes from its close button, ⌘W, or the page's `window.close()`.
 */
export class ExtensionWindows {
  private readonly windows = new Map<string, ExtensionWindow>()

  constructor(private readonly host: ExtensionWindowHost) {}

  has(id: string): boolean {
    return this.windows.has(id)
  }

  get(id: string): ExtensionWindow | undefined {
    return this.windows.get(id)
  }

  /** Which surface `wc` is, when it is one of our windows. */
  surfaceOf(wc: WebContents): ExtensionSurface | null {
    for (const w of this.windows.values()) if (w.webContents === wc) return w.surface
    return null
  }

  /**
   * Open the extension's window on `url`, or bring the open one forward
   * (navigating it when the URL changed). `anchor` is the toolbar button in
   * the browser window's content coordinates.
   */
  show(id: string, surface: ExtensionSurface, url: string, anchor: Rect | null): void {
    const existing = this.windows.get(id)
    if (existing && existing.surface === surface && !existing.destroyed) {
      existing.navigate(url)
      existing.bringForward()
      return
    }
    existing?.close()
    const win = new ExtensionWindow(id, surface, url, anchor, this.host, () => {
      if (this.windows.get(id) === win) this.windows.delete(id)
    })
    this.windows.set(id, win)
  }

  close(id: string, surface?: ExtensionSurface): void {
    const w = this.windows.get(id)
    if (w && (!surface || w.surface === surface)) w.close()
  }

  /** Quit: no close handlers, no `beforeunload`, no events to anyone. */
  destroyAll(): void {
    const all = [...this.windows.values()]
    this.windows.clear()
    for (const w of all) w.destroy()
  }
}

export class ExtensionWindow {
  readonly win: BrowserWindow
  readonly webContents: WebContents
  private url: string
  private shown = false
  private userSized = false
  private saveTimer: NodeJS.Timeout | null = null
  /** Destroyed on quit: do not report the close. */
  private quietly = false

  constructor(
    readonly id: string,
    readonly surface: ExtensionSurface,
    url: string,
    private readonly anchor: Rect | null,
    private readonly host: ExtensionWindowHost,
    onGone: () => void
  ) {
    this.url = url
    const parent = host.parent()
    const saved = host.placement(id)
    const panel = surface === 'panel'
    this.win = new BrowserWindow({
      show: false,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      title: host.title(id),
      // Sizes below are the page's viewport; the titlebar comes on top.
      useContentSize: true,
      width: panel ? (saved?.panelWidth ?? PANEL_DEFAULT.width) : POPUP_MIN,
      height: panel ? (saved?.panelHeight ?? PANEL_DEFAULT.height) : POPUP_MIN,
      ...(panel ? { minWidth: PANEL_MIN.width, minHeight: PANEL_MIN.height } : {}),
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // A click on the inactive window goes straight to the page (wallet buttons).
      acceptFirstMouse: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: host.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false
      }
    })
    const wc = this.win.webContents
    this.webContents = wc

    // The titlebar shows the extension's name, not the page's <title>.
    this.win.on('page-title-updated', (event) => event.preventDefault())
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.meta && !input.control && !input.alt && input.code === 'KeyW') {
        event.preventDefault()
        this.close()
      }
    })
    wc.setWindowOpenHandler(({ url: target, disposition }) => {
      if (/^(https?|chrome-extension):/i.test(target)) host.openTab(target, disposition === 'background-tab')
      return { action: 'deny' }
    })
    wc.on('context-menu', (_event, params) => this.showContextMenu(params))
    wc.on('render-process-gone', () => this.close())

    // Only user resizes emit will-resize; from then on the popup keeps that size.
    this.win.on('will-resize', () => {
      this.userSized = true
    })
    this.win.on('move', () => this.scheduleSave())
    this.win.on('resize', () => this.scheduleSave())
    this.win.on('close', () => this.save())
    this.win.on('closed', () => {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      onGone()
      if (this.shown && !this.quietly) host.closed(id, surface, this.url)
    })

    if (panel) {
      this.win.once('ready-to-show', () => this.reveal())
    } else {
      fitPopup({
        webContents: wc,
        alive: () => !this.win.isDestroyed(),
        setContentSize: (width, height) => this.setContentSize(width, height),
        fitted: () => this.reveal(),
        userSized: () => this.userSized
      })
    }
    setTimeout(() => {
      if (this.shown || this.win.isDestroyed()) return
      if (!panel) this.win.setContentSize(POPUP_FALLBACK.width, POPUP_FALLBACK.height)
      this.reveal()
    }, panel ? PANEL_SHOW_FALLBACK_MS : POPUP_SHOW_FALLBACK_MS).unref()
    void wc.loadURL(url).catch(() => undefined)
  }

  get destroyed(): boolean {
    return this.win.isDestroyed()
  }

  /** Show (placing it the first time) and focus, unless the host wants inactive windows. */
  reveal(): void {
    if (this.win.isDestroyed()) return
    if (!this.shown) {
      this.shown = true
      this.place()
      this.host.opened(this.id, this.surface, this.url)
    }
    if (this.host.inactive) {
      this.win.showInactive()
    } else {
      this.win.show()
      this.win.focus()
    }
  }

  /** Raise an already visible window; one still loading shows itself when ready. */
  bringForward(): void {
    if (this.shown) this.reveal()
  }

  /** Load `url` unless it is the page this window was last asked to show. */
  navigate(url: string): void {
    if (url === this.url || this.win.isDestroyed()) return
    this.url = url
    void this.webContents.loadURL(url).catch(() => undefined)
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.close()
  }

  destroy(): void {
    if (this.win.isDestroyed()) return
    this.save()
    this.quietly = true
    this.win.destroy()
  }

  private setContentSize(width: number, height: number): void {
    if (this.win.isDestroyed()) return
    this.win.setContentSize(width, height)
    // A popup that grew after it was shown must not run off the screen.
    if (this.shown) this.keepOnScreen()
  }

  private place(): void {
    const parent = this.host.parent()
    const parentRect = parent && !parent.isDestroyed() ? parent.getContentBounds() : null
    const bounds = this.win.getBounds()
    const anchor =
      this.anchor && parentRect
        ? {
            x: parentRect.x + this.anchor.x,
            y: parentRect.y + this.anchor.y,
            width: this.anchor.width,
            height: this.anchor.height
          }
        : null
    const saved = this.host.placement(this.id)
    const savedPoint = saved ? { x: saved.x, y: saved.y } : null
    const near = savedPoint ?? anchor ?? parentRect ?? bounds
    const workArea = screen.getDisplayMatching({
      x: Math.round(near.x),
      y: Math.round(near.y),
      width: bounds.width,
      height: bounds.height
    }).workArea
    const { x, y } = placeWindow(bounds, { saved: savedPoint, anchor, parent: parentRect, workArea })
    this.win.setPosition(x, y)
  }

  private keepOnScreen(): void {
    const bounds = this.win.getBounds()
    const { x, y } = clampToArea(bounds, screen.getDisplayMatching(bounds).workArea)
    if (x !== bounds.x || y !== bounds.y) this.win.setPosition(x, y)
  }

  private scheduleSave(): void {
    if (!this.shown) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS)
    this.saveTimer.unref()
  }

  private save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.shown || this.win.isDestroyed()) return
    const { x, y } = this.win.getBounds()
    const next: StoredPlacement = { ...this.host.placement(this.id), x, y }
    if (this.surface === 'panel') {
      const [width, height] = this.win.getContentSize()
      next.panelWidth = width
      next.panelHeight = height
    }
    this.host.savePlacement(this.id, next)
  }

  /** Native menu: editing, links, reload, inspect, close. */
  private showContextMenu(params: ContextMenuParams): void {
    const { t } = this.host
    const wc = this.webContents
    const items: MenuItemConstructorOptions[] = []
    const sep = () => {
      if (items.length && items[items.length - 1]!.type !== 'separator') items.push({ type: 'separator' })
    }
    const link = params.linkURL
    if (link && /^(https?|chrome-extension):/i.test(link)) {
      items.push(
        { label: t('ctx.openLinkInNewTab'), click: () => this.host.openTab(link, false) },
        { label: t('ctx.copyLink'), click: () => clipboard.writeText(link) }
      )
      sep()
    }
    const { editFlags } = params
    if (params.isEditable) {
      items.push(
        { role: 'cut', label: t('menu.cut'), enabled: editFlags.canCut },
        { role: 'copy', label: t('menu.copy'), enabled: editFlags.canCopy },
        { role: 'paste', label: t('menu.paste'), enabled: editFlags.canPaste },
        { role: 'selectAll', label: t('menu.selectAll'), enabled: editFlags.canSelectAll }
      )
      sep()
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy', label: t('menu.copy') })
      sep()
    }
    items.push(
      { label: t('common.reload'), click: () => wc.reload() },
      {
        label: t('ctx.inspect'),
        click: () => {
          if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
          wc.inspectElement(params.x, params.y)
        }
      },
      { type: 'separator' },
      { label: t('extWindow.menu.close'), click: () => this.close() }
    )
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }
}
