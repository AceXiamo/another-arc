import { app, type WebContents } from 'electron'
import { agentUrl, type AgentInfo } from '@shared/agent'
import type { MessageKey, Translate } from '@shared/i18n'
import type { TabId } from '@shared/types'
import { fallbackTitle, isInternalUrl } from '@shared/url'
import { isSavedTab } from '@shared/tabs'
import type { HistoryService } from '../history/history-service'
import type { PageDialogs } from '../tabs/page-dialogs'
import type { TabData } from '../tabs/model'
import type { TabManager } from '../tabs/tab-manager'
import type { BrowserWindowController } from '../windows/browser-window'
import { McpHttpServer, ToolError, type McpClientInfo } from './mcp-server'
import { pushConsole, TabDriver, waitForLoad, type ConsoleEntry, type CursorVerb } from './tab-driver'
import { AGENT_INSTRUCTIONS, createTools } from './tools'

// Agents over MCP. Loaded only once the user turns agents on in Settings
// (see Browser.syncAgent); until then none of this code is even parsed.

/** A tab stops showing as agent-driven this long after the agent's last call. */
const IDLE_MS = 45_000
/** How long a page may take to load before tools work with it anyway. */
const WAKE_TIMEOUT_MS = 8_000

export interface AgentHost {
  tabs: TabManager
  history: HistoryService
  dialogs: Pick<PageDialogs, 'list' | 'respond' | 'dismissHidden'>
  window(): BrowserWindowController | null
  token(): string
  /** The user's language, for what the agent's cursor says. */
  t: Translate
}

export class AgentService {
  private server: McpHttpServer | null = null
  private port = 0
  private error: AgentInfo['error'] = null
  private readonly drivers = new Map<TabId, TabDriver>()
  private readonly consoles = new Map<TabId, ConsoleEntry[]>()
  private readonly refCounters = new Map<TabId, { next: number }>()
  private readonly idle = new Map<TabId, NodeJS.Timeout>()
  private readonly consoleListeners = new Map<WebContents, (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => void>()
  private readonly noContextMenuUntil = new WeakMap<WebContents, number>()

  constructor(private readonly host: AgentHost) {}

  get running(): boolean {
    return this.server !== null
  }

  async start(port: number): Promise<void> {
    if (this.server && this.port === port) return
    await this.stopServer()
    const server = new McpHttpServer({
      name: 'another-arc',
      title: 'Another Arc',
      version: app.getVersion(),
      instructions: AGENT_INSTRUCTIONS,
      tools: createTools({
        tabs: this.host.tabs,
        history: this.host.history,
        resolveTab: (id) => this.resolveTab(id),
        dialogs: this.host.dialogs,
        driver: (id, client) => this.driver(id, client),
        openTab: (input, activate, client) => this.openTab(input, activate, client),
        shortId,
        describeTab: (tab) => this.describeTab(tab),
        listTabs: () => this.listTabs()
      }),
      token: () => this.host.token()
    })
    this.port = port
    try {
      await server.listen(port)
      this.server = server
      this.error = null
    } catch (error) {
      this.error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'portInUse' : 'failed'
      console.error('[agent] cannot listen on', port, error)
      return
    }
    for (const rt of this.host.tabs.liveRuntimes()) this.runtimeCreated(rt.tabId, rt.wc)
  }

  /** Turn agents off: close the server, forget every tab's agent state. */
  async stop(): Promise<void> {
    await this.stopServer()
    for (const [wc, listener] of this.consoleListeners) if (!wc.isDestroyed()) wc.off('console-message', listener)
    this.consoleListeners.clear()
    this.consoles.clear()
    for (const driver of this.drivers.values()) {
      driver.presence(false)
      driver.detach()
    }
    this.drivers.clear()
    for (const [tabId, timer] of this.idle) {
      clearTimeout(timer)
      this.unmark(tabId)
    }
    this.idle.clear()
    this.host.dialogs.dismissHidden()
  }

  /** Quitting: close the server and leave the tabs alone. */
  close(): Promise<void> {
    return this.stopServer()
  }

  private async stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.error = null
    await server?.close()
  }

  info(enabled: boolean, port: number): AgentInfo {
    return {
      enabled,
      running: this.server !== null,
      port,
      url: agentUrl(port),
      token: this.host.token(),
      error: enabled ? this.error : null,
      clients: (this.server?.clients() ?? []).filter((c) => c.name).map((c) => ({ name: c.name, lastSeen: c.lastSeen }))
    }
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  /** Console output is kept for every live tab, so it is there when an agent asks. */
  runtimeCreated(tabId: TabId, wc: WebContents): void {
    if (!this.server || this.consoleListeners.has(wc)) return
    const listener = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
      const id = this.host.tabs.tabIdFor(wc) ?? tabId
      pushConsole(this.consoleFor(id), {
        level: details.level,
        text: details.message,
        source: details.sourceId,
        line: details.lineNumber,
        at: Date.now()
      })
    }
    wc.on('console-message', listener)
    wc.once('destroyed', () => this.consoleListeners.delete(wc))
    this.consoleListeners.set(wc, listener)
  }

  tabRemoved(tabId: TabId): void {
    this.drivers.get(tabId)?.detach()
    this.drivers.delete(tabId)
    this.consoles.delete(tabId)
    this.refCounters.delete(tabId)
    const timer = this.idle.get(tabId)
    if (timer) clearTimeout(timer)
    this.idle.delete(tabId)
  }

  /** An agent is working in this page right now (its dialogs wait for the agent). */
  drives(wc: WebContents): boolean {
    const tabId = this.host.tabs.tabIdFor(wc)
    return tabId !== undefined && this.idle.has(tabId)
  }

  /** The dialog a tab is blocked on, if any. */
  pendingDialog(tabId: TabId) {
    return this.host.dialogs.list().find((d) => d.tabId === tabId)
  }

  /** An agent right-click is underway: the page's native menu would block the main process. */
  ownsContextMenu(wc: WebContents): boolean {
    return (this.noContextMenuUntil.get(wc) ?? 0) > Date.now()
  }

  private consoleFor(tabId: TabId): ConsoleEntry[] {
    let buffer = this.consoles.get(tabId)
    if (!buffer) {
      buffer = []
      this.consoles.set(tabId, buffer)
    }
    return buffer
  }

  resolveTab(id: string | undefined): TabData {
    const model = this.host.tabs.model
    if (!id) {
      const active = model.activeTab()
      if (!active) throw new ToolError('No tab is open in the current space. Open one with open_tab.')
      return active
    }
    const exact = model.getTab(id)
    if (exact) return exact
    const matches = [...model.tabs.values()].filter((t) => t.id.startsWith(id))
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) throw new ToolError(`Tab id "${id}" is ambiguous; use more characters`)
    throw new ToolError(`No tab "${id}". Call list_tabs for current ids.`)
  }

  async driver(id: string | undefined, client: McpClientInfo): Promise<TabDriver> {
    const tab = this.resolveTab(id)
    if (isInternalUrl(tab.url)) {
      throw new ToolError(`Tab ${shortId(tab.id)} shows a browser page (${tab.url}), not a web page. Open a web page with open_tab or navigate.`)
    }
    const tabs = this.host.tabs
    const rt = tabs.runtime(tab.id) ?? tabs.wake(tab.id)
    if (!rt) throw new ToolError(`Tab ${shortId(tab.id)} cannot be loaded`)
    let driver = this.drivers.get(tab.id)
    if (!driver || driver.view !== rt.view) {
      driver?.detach()
      driver = new TabDriver(tab.id, rt.view, this.driverHost(tab.id, rt.view), this.refsFor(tab.id), this.consoleFor(tab.id))
      this.drivers.set(tab.id, driver)
    }
    driver.actor = client.name || 'Agent'
    driver.ensureSized()
    // A background tab is hidden: wake it first, so it also loads unthrottled.
    const awake = driver.wake()
    this.mark(tab.id)
    // A page still loading its document has nothing to read yet; one loading ads and images does.
    if (rt.wc.isLoadingMainFrame()) await waitForLoad(rt.wc, WAKE_TIMEOUT_MS)
    // A page frozen on a dialog cannot paint a frame; the agent answers it first.
    if (!this.pendingDialog(tab.id)) await awake
    driver.presence(true)
    return driver
  }

  async openTab(input: string, activate: boolean, client: McpClientInfo): Promise<TabData> {
    const tab = this.host.tabs.openInput(input, {
      background: !activate,
      // Record the network from the very first request: attach before the page loads.
      beforeLoad: (tabId, view) => {
        const early = new TabDriver(tabId, view, this.driverHost(tabId, view), this.refsFor(tabId), this.consoleFor(tabId))
        early.ensureSized()
        void early.recordNetwork().catch(() => undefined)
        this.drivers.set(tabId, early)
      }
    })
    if (!tab) throw new ToolError(`Cannot open ${JSON.stringify(input)}`)
    const driver = await this.driver(tab.id, client)
    await waitForLoad(driver.wc)
    return tab
  }

  private refsFor(tabId: TabId): { next: number } {
    let refs = this.refCounters.get(tabId)
    if (!refs) {
      refs = { next: 1 }
      this.refCounters.set(tabId, refs)
    }
    return refs
  }

  private driverHost(tabId: TabId, view: Electron.WebContentsView) {
    const tabs = this.host.tabs
    return {
      isShown: () => {
        const window = this.host.window()
        return window !== null && !window.destroyed && window.currentPage === view && window.win.isVisible() && !window.win.isMinimized()
      },
      cardBounds: () => this.host.window()?.cardBounds() ?? null,
      tabIds: () => [...tabs.model.tabs.keys()],
      describeTab: (id: string) => {
        const tab = tabs.model.getTab(id)
        return tab ? this.describeTab(tab) : id
      },
      suppressContextMenu: (wc: WebContents, ms: number) => this.noContextMenuUntil.set(wc, Date.now() + ms),
      pendingDialog: () => this.pendingDialog(tabId),
      // Verbs whose target is missing read fine without it ("Clicking").
      cursorText: (verb: CursorVerb, target: string) => this.host.t(`agent.cursor.${verb}` as MessageKey, { target }).trim()
    }
  }

  /** Show the tab as agent-driven (sidebar mark, glow around the page) until the agent goes quiet. */
  private mark(tabId: TabId): void {
    const model = this.host.tabs.model
    const timer = this.idle.get(tabId)
    if (timer) clearTimeout(timer)
    // Recently used tabs are not discarded, so an agent's tab stays loaded.
    else model.updateTab(tabId, { agent: true, lastActiveAt: Date.now() })
    this.idle.set(
      tabId,
      setTimeout(() => {
        this.idle.delete(tabId)
        this.unmark(tabId)
      }, IDLE_MS)
    )
  }

  private unmark(tabId: TabId): void {
    if (this.host.tabs.model.getTab(tabId)) this.host.tabs.model.updateTab(tabId, { agent: false, lastActiveAt: Date.now() })
    this.drivers.get(tabId)?.presence(false)
    // A dialog the agent left unanswered would freeze the page; off screen, cancel it now.
    this.host.dialogs.dismissHidden()
  }

  describeTab(tab: TabData): string {
    const title = tab.title || tab.savedTitle || fallbackTitle(tab.url, 'en')
    return `[${shortId(tab.id)}] ${JSON.stringify(title)} ${tab.url}`
  }

  listTabs(): string {
    const model = this.host.tabs.model
    const lines: string[] = []
    const viewing = model.activeTab()?.id
    const tabLine = (id: string, indent: string) => {
      const tab = model.getTab(id)
      if (!tab) return
      const flags = [
        id === viewing ? 'user is viewing' : '',
        !tab.live && id !== viewing ? 'not loaded' : '',
        tab.agent ? 'agent' : '',
        this.pendingDialog(id) ? 'waiting on a dialog' : '',
        isSavedTab(tab) && tab.savedUrl && tab.url !== tab.savedUrl ? `saved as ${tab.savedUrl}` : ''
      ].filter(Boolean)
      lines.push(`${indent}${id === viewing ? '* ' : '- '}${this.describeTab(tab)}${flags.length ? ` (${flags.join(', ')})` : ''}`)
    }
    const folderTree = (ids: readonly string[], indent: string) => {
      for (const id of ids) {
        const folder = model.getFolder(id)
        if (!folder) {
          tabLine(id, indent)
          continue
        }
        lines.push(`${indent}- Folder ${JSON.stringify(folder.name)}`)
        folderTree(folder.childIds, `${indent}  `)
      }
    }
    for (const spaceId of model.spaceOrder) {
      const space = model.getSpace(spaceId)
      if (!space) continue
      lines.push(`Space ${JSON.stringify(space.name)}${spaceId === model.activeSpaceId ? ' (current)' : ''}`)
      if (space.pinnedTabIds.length) {
        lines.push('  Favorites:')
        for (const id of space.pinnedTabIds) tabLine(id, '    ')
      }
      if (space.savedIds.length) {
        lines.push('  Pinned:')
        folderTree(space.savedIds, '    ')
      }
      lines.push(space.tabIds.length ? '  Tabs:' : '  Tabs: (none)')
      for (const id of space.tabIds) tabLine(id, '    ')
    }
    return lines.join('\n')
  }
}

/** First 8 characters of a tab's UUID: enough to tell tabs apart, cheap to repeat. */
export function shortId(id: string): string {
  return id.slice(0, 8)
}
