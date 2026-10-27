import type { HistoryService } from '../history/history-service'
import type { PageDialogs } from '../tabs/page-dialogs'
import type { TabData } from '../tabs/model'
import type { TabManager } from '../tabs/tab-manager'
import { textResult, ToolError, type JsonSchema, type McpClientInfo, type McpTool, type McpToolResult } from './mcp-server'
import { targetName, waitForLoad, type TabDriver, type Target } from './tab-driver'

// The tools agents see. Descriptions are written for a language model:
// what the tool is for, what comes back, and how it connects to the others.

export interface ToolDeps {
  tabs: TabManager
  history: HistoryService
  dialogs: Pick<PageDialogs, 'list' | 'respond'>
  /** A tab by id or unique prefix; the tab the user is looking at when omitted. */
  resolveTab(id: string | undefined): TabData
  /** The tab's driver: woken, loaded, sized and marked as agent-driven. */
  driver(id: string | undefined, client: McpClientInfo): Promise<TabDriver>
  /** Open a tab for an agent (network recorded from its first request). */
  openTab(input: string, activate: boolean, client: McpClientInfo): Promise<TabData>
  shortId(id: string): string
  describeTab(tab: TabData): string
  listTabs(): string
}

const tabId: JsonSchema = {
  type: 'string',
  description: 'Tab id from list_tabs (a unique prefix is enough). Default: the tab the user is looking at.'
}
const ref: JsonSchema = { type: 'string', description: 'Element ref from snapshot or find, e.g. "e12".' }
const x: JsonSchema = { type: 'number', description: 'X in the latest screenshot (use instead of ref for things a snapshot cannot name).' }
const y: JsonSchema = { type: 'number', description: 'Y in the latest screenshot.' }

function object(properties: Record<string, JsonSchema>, required: string[] = []) {
  return { type: 'object' as const, properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

/** Local date and time, as the user's clock reads it (network_requests also speaks local time): "2026-10-27 15:53". */
function localStamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function joined(lines: Array<string | null | undefined | false>): McpToolResult {
  return textResult(lines.filter(Boolean).join('\n'))
}

function coveredError(t: Target): ToolError {
  return new ToolError(
    `${t.label} is covered by ${t.covered}. Close or scroll past what covers it (a dialog or banner?), or pass force: true to click there anyway.`
  )
}

export function createTools(deps: ToolDeps): McpTool[] {
  const { tabs } = deps

  /** Run an action (one at a time per tab), then report what it changed. */
  const act = (driver: TabDriver, action: () => Promise<string>): Promise<McpToolResult> =>
    driver.exclusive(async () => {
      const settle = driver.watch()
      let done: string
      try {
        done = await action()
      } catch (error) {
        await settle()
        throw error
      }
      return joined([done, ...(await settle())])
    })

  const tools: McpTool[] = [
    // -- tabs -------------------------------------------------------------------
    {
      name: 'list_tabs',
      title: 'List tabs',
      description:
        "Every space and tab in the browser: favorites, pinned tabs and folders, and open tabs, with ids for the other tools. Marks the tab the user is looking at.",
      inputSchema: object({}),
      annotations: { readOnlyHint: true },
      run: () => textResult(deps.listTabs())
    },
    {
      name: 'open_tab',
      title: 'Open tab',
      description:
        'Open a URL (or search words, searched with the browser\'s search engine) in a new tab and wait for it to load. ' +
        'Opens in the background so the user keeps their page; they can switch to it to watch you. ' +
        'Pass activate: true when the user wants to see it right away. Returns the new tab id; use it for later calls.',
      inputSchema: object({ url: { type: 'string', description: 'URL or search words.' }, activate: { type: 'boolean' } }, ['url']),
      annotations: { openWorldHint: true },
      run: async (args, client) => {
        const tab = await deps.openTab(String(args.url), args.activate === true, client)
        return textResult(`Opened ${deps.describeTab(tabs.model.getTab(tab.id) ?? tab)}${args.activate ? '' : ' in the background'}.`)
      }
    },
    {
      name: 'select_tab',
      title: 'Show tab',
      description: 'Bring a tab to the front (switching spaces if needed), so the user sees it.',
      inputSchema: object({ tabId }, ['tabId']),
      run: (args) => {
        const tab = deps.resolveTab(str(args.tabId))
        tabs.activateTab(tab.id)
        return textResult(`Showing ${deps.describeTab(tab)}.`)
      }
    },
    {
      name: 'close_tab',
      title: 'Close tab',
      description: 'Close a tab. Pinned tabs and favorites are bookmarks: closing unloads them instead of removing them.',
      inputSchema: object({ tabId }, ['tabId']),
      annotations: { destructiveHint: true },
      run: (args) => {
        const tab = deps.resolveTab(str(args.tabId))
        const label = deps.describeTab(tab)
        tabs.closeTab(tab.id)
        return textResult(`Closed ${label}.`)
      }
    },
    {
      name: 'navigate',
      title: 'Navigate',
      description:
        'Load a URL (or search words) in a tab, or go "back", "forward" or "reload", and wait for the page to load.',
      inputSchema: object({ url: { type: 'string', description: 'URL, search words, or back / forward / reload.' }, tabId }, ['url']),
      annotations: { openWorldHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const id = driver.tabId
        const url = String(args.url).trim()
        const before = driver.wc.getURL()
        if (url === 'back') {
          if (!driver.wc.navigationHistory.canGoBack()) throw new ToolError('There is no page to go back to')
          tabs.goBack(id)
        } else if (url === 'forward') {
          if (!driver.wc.navigationHistory.canGoForward()) throw new ToolError('There is no page to go forward to')
          tabs.goForward(id)
        } else if (url === 'reload') {
          tabs.reload(id)
        } else {
          tabs.navigate(id, url)
        }
        // Give the navigation a moment to start before waiting on it.
        await new Promise((r) => setTimeout(r, 100))
        const loaded = await waitForLoad(driver.wc)
        const tab = tabs.model.getTab(id)
        if (tab?.error) return textResult(`Could not load ${tab.error.url || url}: ${tab.error.description} (${tab.error.code})`, true)
        const now = driver.wc.getURL()
        return textResult(
          `${now === before && url !== 'reload' ? 'Still at' : 'Now at'} ${JSON.stringify(driver.wc.getTitle())} ${now}${loaded ? '' : ' (still loading)'}`
        )
      }
    },

    // -- reading ----------------------------------------------------------------
    {
      name: 'read_page',
      title: 'Read page',
      description:
        "The page's main content as Markdown (headings, paragraphs, lists, tables, links, code), without menus, ads and footers. " +
        'Best for reading, summarizing and research. Kept lean: same-site links are written as paths and images are left out. ' +
        'query returns just the passages about something (cheapest way to answer a question about a long page); ' +
        'links: false drops link targets too. Long pages come in parts: the cut says the offset to read on and where the later sections start. ' +
        'Includes any text the user has selected.',
      inputSchema: object({
        tabId,
        query: { type: 'string', description: 'Only the passages about this (words or a phrase), under their headings.' },
        links: { type: 'boolean', description: 'Write link targets (default true).' },
        images: { type: 'boolean', description: 'Include images as ![alt](src) (default false).' },
        full: { type: 'boolean', description: 'Whole page instead of the main content.' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to continue from.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200_000, description: 'Default 20000.' }
      }),
      annotations: { readOnlyHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        if (await driver.call<boolean>('isPdf').catch(() => false)) {
          return textResult(`This tab shows a PDF: ${driver.wc.getURL()}\nThe browser cannot extract its text; download it (e.g. curl -L) and read it with a PDF tool.`)
        }
        const offset = num(args.offset, 0)
        const query = str(args.query)
        driver.scan(query ? 'find' : 'read', query ? targetName(JSON.stringify(query)) : '')
        const page = await driver.call<{ text: string; total: number; sections: Array<{ title: string; offset: number }> }>('readPage', {
          full: args.full === true,
          query,
          links: args.links !== false,
          images: args.images === true,
          offset,
          maxChars: num(args.maxChars, 20_000)
        })
        const end = offset + page.text.length
        return joined([
          page.text,
          end < page.total &&
            `\n[${page.total - end} more characters: call read_page with offset: ${end}${page.sections.length ? ', or the offset of a section below' : ''}]`,
          ...page.sections.map((section) => `- ${section.title} (offset ${section.offset})`)
        ])
      }
    },
    {
      name: 'snapshot',
      title: 'Page snapshot',
      description:
        'The page as an accessibility tree: one line per element with its role, name and state, e.g. `- button "Sign in" [e12]`; ' +
        'runs of plain links or buttons share a line (`- links: "Docs" [e3], "Blog" [e4], "About" [e5]`). ' +
        'Elements you can act on carry refs ([e12]) for click, type, fill, hover, drag, scroll and upload_file. ' +
        'Refs stay valid while the page stays; take a new snapshot after it changes a lot. ' +
        'Kept to about 3k tokens: on big pages, off-screen parts fold into one-line summaries (what they hold, their headings); ' +
        'snapshot ref= expands one, or scroll and take a viewportOnly snapshot. Link URLs are left out unless urls: true. ' +
        'interactiveOnly keeps just controls (shorter still); viewportOnly keeps what is on screen; ref snapshots one part of the page.',
      inputSchema: object({
        tabId,
        interactiveOnly: { type: 'boolean' },
        viewportOnly: { type: 'boolean' },
        ref: { type: 'string', description: 'Only the part of the page under this element.' },
        urls: { type: 'boolean', description: 'Show where links go (default false).' },
        maxChars: { type: 'integer', minimum: 2000, maximum: 400_000, description: 'Size budget: off-screen parts fold to fit it. Default 12000 (24000 with ref).' }
      }),
      annotations: { readOnlyHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        driver.scan('read')
        const text = await driver.call<string>('snapshot', {
          interactiveOnly: args.interactiveOnly === true,
          viewportOnly: args.viewportOnly === true,
          ref: str(args.ref),
          urls: args.urls === true,
          maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined
        })
        // Folding keeps what is on screen whole; only a crowded screen goes over, and is cut here.
        const max = num(args.maxChars, 40_000)
        if (text.length <= max) return textResult(text)
        return textResult(
          `${text.slice(0, max)}\n[cut at ${max} of ${text.length} characters: use interactiveOnly, viewportOnly, find, or ref= for a part]`
        )
      }
    },
    {
      name: 'find',
      title: 'Find elements',
      description:
        'Find elements by their text, label, placeholder or value, e.g. "sign in", "search box", "price". ' +
        'Returns matching elements with refs, best first. Cheaper than a full snapshot on big pages.',
      inputSchema: object(
        {
          query: { type: 'string' },
          role: { type: 'string', description: 'Only this role, e.g. button, link, textbox, checkbox, heading.' },
          tabId
        },
        ['query']
      ),
      annotations: { readOnlyHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        driver.scan('find', targetName(JSON.stringify(String(args.query))))
        return textResult(await driver.call<string>('find', { query: String(args.query), role: str(args.role) }))
      }
    },
    {
      name: 'screenshot',
      title: 'Screenshot',
      description:
        'What the page looks like: the visible viewport, or one element (ref). Use it for layout and visual checks, ' +
        'canvases, maps and anything a snapshot cannot describe. click / hover / drag accept x, y in its coordinates.',
      inputSchema: object({ tabId, ref, format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg.' } }),
      annotations: { readOnlyHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const shot = await driver.screenshot({ ref: str(args.ref), format: args.format === 'png' ? 'png' : 'jpeg' })
        return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType }, { type: 'text', text: shot.text }] }
      }
    },

    // -- acting -----------------------------------------------------------------
    {
      name: 'click',
      title: 'Click',
      description:
        'Click an element (ref) or a point (x, y from a screenshot) with a real mouse event; scrolls it into view first. ' +
        'Refuses when something covers the element, and says what. Reports navigation, new tabs and dialogs it caused.',
      inputSchema: object({
        ref,
        x,
        y,
        tabId,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        doubleClick: { type: 'boolean' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Meta', 'Control', 'Alt', 'Shift'] }, description: 'e.g. ["Meta"] opens a link in a new tab.' },
        force: { type: 'boolean', description: 'Click even if the element is covered.' }
      }),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const t = await driver.target(args)
        if (t.covered && args.force !== true) throw coveredError(t)
        if (t.file) throw new ToolError(`${t.label} is a file input: use upload_file with its ref instead of clicking it`)
        return act(driver, async () => {
          await driver.click(t, {
            button: (str(args.button) as 'left' | 'right' | 'middle' | undefined) ?? 'left',
            count: args.doubleClick === true ? 2 : 1,
            modifiers: Array.isArray(args.modifiers) ? args.modifiers.map((m) => String(m).toLowerCase()) : []
          })
          return `Clicked ${t.label}${t.disabled ? ' (it is disabled)' : ''}.`
        })
      }
    },
    {
      name: 'hover',
      title: 'Hover',
      description: 'Move the mouse over an element (ref) or a point (x, y), to open hover menus or tooltips.',
      inputSchema: object({ ref, x, y, tabId }),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const t = await driver.target(args)
        await driver.hover(t)
        return textResult(`Hovering over ${t.label}.`)
      }
    },
    {
      name: 'type',
      title: 'Type text',
      description:
        'Type into a field (ref), or into whatever has focus. Clicks the field first; adds to its text unless clear: true. ' +
        'submit: true presses Enter afterwards. slowly: true types key by key, for fields that react to each key (autocomplete).',
      inputSchema: object(
        {
          text: { type: 'string' },
          ref,
          tabId,
          clear: { type: 'boolean', description: 'Replace what is in the field.' },
          submit: { type: 'boolean', description: 'Press Enter after typing.' },
          slowly: { type: 'boolean' }
        },
        ['text']
      ),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const text = String(args.text)
        return act(driver, async () => {
          let label = 'the focused element'
          const r = str(args.ref)
          if (r) {
            const t = await driver.target({ ref: r })
            label = t.label
            if (!t.covered) await driver.click(t, { verb: 'type' })
          }
          const focus = await driver.call<{ kind: string; label: string }>('focusField', { ref: r, mode: args.clear ? 'select' : 'end' })
          if (!r) {
            label = focus.label
            driver.say('type', targetName(label))
          }
          if (args.clear && text === '') driver.wc.delete()
          else await driver.typeText(text, args.slowly === true)
          if (args.submit) await driver.pressKey('Enter')
          return `Typed ${JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)} into ${label}${args.submit ? ' and pressed Enter' : ''}.`
        })
      }
    },
    {
      name: 'fill',
      title: 'Fill form',
      description:
        'Set several form fields at once: text fields and text areas (value replaces their content), selects (option value or label), ' +
        'checkboxes, radios and switches ("true" / "false"), date and range inputs. Faster than typing field by field.',
      inputSchema: object(
        {
          fields: {
            type: 'array',
            items: object({ ref: { type: 'string' }, value: { type: 'string' } }, ['ref', 'value']),
            description: 'e.g. [{"ref": "e3", "value": "Ada"}, {"ref": "e7", "value": "true"}]'
          },
          tabId
        },
        ['fields']
      ),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const fields = args.fields as Array<{ ref: string; value: string }>
        return act(driver, async () => {
          const done: string[] = []
          for (const field of fields) {
            const plan = await driver.call<{ action: 'done' | 'type' | 'click'; label?: string; detail?: string }>('fill', field)
            if (plan.action === 'done') {
              done.push(plan.detail!)
            } else if (plan.action === 'click') {
              const t = await driver.target({ ref: field.ref })
              if (t.covered) throw coveredError(t)
              await driver.click(t, { verb: 'fill' })
              done.push(`${plan.label} → ${field.value}`)
            } else {
              const t = await driver.target({ ref: field.ref })
              if (!t.covered) await driver.hover(t, 'fill')
              await driver.call('focusField', { ref: field.ref, mode: 'select' })
              if (field.value === '') driver.wc.delete()
              else await driver.typeText(field.value)
              done.push(`${plan.label} → ${JSON.stringify(field.value.length > 60 ? `${field.value.slice(0, 60)}…` : field.value)}`)
            }
          }
          return `Filled ${done.length} field${done.length === 1 ? '' : 's'}:\n${done.map((d) => `- ${d}`).join('\n')}`
        })
      }
    },
    {
      name: 'press_key',
      title: 'Press key',
      description:
        'Press a key or shortcut in the page: Enter, Escape, Tab, Backspace, ArrowDown, PageDown, Space, a letter, ' +
        'or combinations like Shift+Tab, Control+Enter, Meta+K. Meta+A / C / X / V / Z run the edit command (select all, copy…).',
      inputSchema: object({ key: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 50 }, tabId }, ['key']),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const count = num(args.count, 1)
        driver.say('key', String(args.key))
        return act(driver, async () => {
          await driver.pressKey(String(args.key), count)
          return `Pressed ${String(args.key)}${count > 1 ? ` ×${count}` : ''}.`
        })
      }
    },
    {
      name: 'scroll',
      title: 'Scroll',
      description:
        'Scroll an element into view (ref alone), or scroll by an amount in a direction: the page, or the scrollable part at ref / x, y. ' +
        'amount is in pixels (default: most of a screen). Reports the new position.',
      inputSchema: object({
        ref,
        x,
        y,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', minimum: 1 },
        tabId
      }),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const direction = str(args.direction)
        if (str(args.ref) && !direction) {
          const t = await driver.target({ ref: args.ref })
          return textResult(`Scrolled ${t.label} into view.`)
        }
        let at: { x: number; y: number }
        if (str(args.ref) || typeof args.x === 'number') {
          const t = await driver.target(args)
          at = { x: t.x, y: t.y }
        } else {
          const size = driver.view.getBounds()
          const zoom = driver.wc.getZoomFactor()
          at = { x: size.width / zoom / 2, y: size.height / zoom / 2 }
        }
        const state0 = await driver.call<{ view: number }>('scrollState', at)
        const amount = num(args.amount, Math.round(state0.view * 0.8))
        const dir = direction ?? 'down'
        const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0
        const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0
        const s = await driver.scroll(at, dx, dy)
        const where = s.container ? `${s.container}` : 'The page'
        const end = s.top + s.view >= s.height - 2 ? ' (at the bottom)' : s.top <= 0 ? ' (at the top)' : ''
        return textResult(`${where} is scrolled to y=${Math.round(s.top)} of ${s.height}${end}.`)
      }
    },
    {
      name: 'drag',
      title: 'Drag',
      description:
        'Drag from one element or point to another with the mouse (sliders, sortable lists, boards). ' +
        'Uses mouse events; native HTML drag-and-drop may not react.',
      inputSchema: object({
        fromRef: ref,
        fromX: x,
        fromY: y,
        toRef: ref,
        toX: x,
        toY: y,
        tabId
      }),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const from = await driver.target({ ref: args.fromRef, x: args.fromX, y: args.fromY })
        const to = await driver.target({ ref: args.toRef, x: args.toX, y: args.toY })
        return act(driver, async () => {
          await driver.drag(from, to)
          return `Dragged ${from.label} to ${to.label}.`
        })
      }
    },
    {
      name: 'upload_file',
      title: 'Upload file',
      description:
        'Choose files for a file input (ref of the input, shown as type=file, or of the upload button around it). ' +
        'Without ref, answers the file chooser a click just opened. Paths must be absolute.',
      inputSchema: object({ paths: { type: 'array', items: { type: 'string' } }, ref, tabId }, ['paths']),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const paths = (args.paths as unknown[]).map(String)
        if (paths.length === 0) throw new ToolError('Pass at least one path')
        return act(driver, () => driver.upload(str(args.ref), paths))
      }
    },
    {
      name: 'handle_dialog',
      title: 'Answer dialog',
      description:
        'Answer the alert, confirm or prompt a page is waiting on (actions report when one opens; the page is frozen until it is answered). ' +
        'accept: true is OK, false is Cancel; text is what to type into a prompt. Without tabId: the tab whose dialog is open.',
      inputSchema: object({ accept: { type: 'boolean' }, text: { type: 'string' }, tabId }, ['accept']),
      run: async (args, client) => {
        const open = deps.dialogs.list()
        const id = str(args.tabId)
        const dialog = id
          ? open.find((d) => d.tabId === deps.resolveTab(id).id)
          : (open.find((d) => d.tabId === tabs.model.activeTab()?.id) ?? (open.length === 1 ? open[0] : undefined))
        if (!dialog) throw new ToolError(open.length > 1 ? 'Several tabs have a dialog open; pass tabId' : 'No dialog is open there')
        const driver = await deps.driver(dialog.tabId, client)
        const accept = args.accept === true
        return act(driver, async () => {
          deps.dialogs.respond(dialog.id, accept, str(args.text) ?? dialog.defaultText, false)
          const verb = dialog.kind === 'alert' ? 'Closed' : accept ? 'Accepted' : 'Cancelled'
          const typed = dialog.kind === 'prompt' && accept ? ` with ${JSON.stringify(str(args.text) ?? dialog.defaultText)}` : ''
          return `${verb} the ${dialog.kind} ${JSON.stringify(dialog.message)}${typed}.`
        })
      }
    },
    {
      name: 'wait_for',
      title: 'Wait',
      description:
        'Wait until text appears on the page, text goes away, or an element (ref) is gone; or just wait some seconds. ' +
        'For pages that load or update after an action.',
      inputSchema: object({
        text: { type: 'string' },
        textGone: { type: 'string' },
        refGone: { type: 'string' },
        seconds: { type: 'number', minimum: 0, maximum: 60, description: 'Wait this long (alone), or the time limit (default 10).' },
        tabId
      }),
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const text = str(args.text)
        const gone = str(args.textGone)
        const refGone = str(args.refGone)
        const seconds = num(args.seconds, text || gone || refGone ? 10 : 1)
        if (!text && !gone && !refGone) {
          // Whatever the agent is waiting for should not stall in a sleeping page.
          void driver.wake(seconds * 1000)
          await new Promise((r) => setTimeout(r, seconds * 1000))
          return textResult(`Waited ${seconds} s.`)
        }
        const deadline = Date.now() + seconds * 1000
        for (;;) {
          let met = true
          if (text) met &&= await driver.call<boolean>('hasText', { text })
          if (gone) met &&= !(await driver.call<boolean>('hasText', { text: gone }))
          if (refGone) met &&= await driver.call('describe', { ref: refGone }).then(() => false, () => true)
          if (met) return textResult('Done waiting: the page matches.')
          if (Date.now() > deadline) throw new ToolError(`Still not there after ${seconds} s. Take a snapshot or screenshot to see what the page shows.`)
          await new Promise((r) => setTimeout(r, 250))
        }
      }
    },

    // -- developer tools ----------------------------------------------------------
    {
      name: 'evaluate',
      title: 'Run JavaScript',
      description:
        "Run JavaScript in the page itself (its globals, its app state) and get the result as text. " +
        'An expression returns its value; with several statements the last line\'s value is returned (or use return). await works.',
      inputSchema: object({ script: { type: 'string' }, tabId }, ['script']),
      annotations: { destructiveHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const result = await driver.evaluate(String(args.script))
        return textResult(result.ok ? result.text : `The script threw: ${result.text}`, !result.ok)
      }
    },
    {
      name: 'console_logs',
      title: 'Console',
      description:
        "The page's console output, including uncaught errors, newest last. Recorded for every tab while agents are enabled. " +
        'Messages are text as the page logged them: objects read [object Object]; inspect their values with evaluate.',
      inputSchema: object({
        tabId,
        level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'], description: 'This level and more severe. Default: all.' },
        pattern: { type: 'string', description: 'Only messages containing this text.' },
        clear: { type: 'boolean', description: 'Clear after reading.' }
      }),
      annotations: { readOnlyHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const order = ['debug', 'info', 'warning', 'error']
        const min = order.indexOf(str(args.level) ?? 'debug')
        const pattern = str(args.pattern)?.toLowerCase()
        const entries = driver.console.filter((e) => order.indexOf(e.level) >= min && (!pattern || e.text.toLowerCase().includes(pattern)))
        if (args.clear) driver.console.length = 0
        if (entries.length === 0) return textResult('No console messages.')
        const lines = entries.slice(-200).map((e) => {
          const where = e.source ? ` (${e.source.split('/').pop()}:${e.line})` : ''
          return `[${e.level}] ${e.text.length > 2000 ? `${e.text.slice(0, 2000)}…` : e.text}${where}`
        })
        // Chromium hands over console messages already stringified. Their real values would need
        // the DevTools Runtime domain, which pages can detect, so point at evaluate instead.
        if (entries.some((e) => e.text.includes('[object Object]'))) {
          lines.push('(Logged objects reach the console log as [object Object]; read their values with evaluate.)')
        }
        return textResult(lines.join('\n'))
      }
    },
    {
      name: 'network_requests',
      title: 'Network',
      description:
        "The tab's network requests: method, status, type, URL, size, time. Tabs you open with open_tab are recorded from their first request; " +
        'other tabs from the first call (reload to capture a page load). Pass requestId for headers and bodies.',
      inputSchema: object({
        tabId,
        filter: {
          type: 'string',
          description: 'URL substring (the query string is searched only when the filter has ?, = or &), or a type: fetch, xhr, document, script…'
        },
        requestId: { type: 'string' },
        clear: { type: 'boolean' }
      }),
      annotations: { readOnlyHint: true },
      run: async (args, client) => {
        const driver = await deps.driver(str(args.tabId), client)
        const requestId = str(args.requestId)
        if (requestId) return textResult(await driver.networkDetail(requestId))
        if (!driver.recordingNetwork) {
          await driver.recordNetwork()
          return textResult('Started recording this tab\'s requests. Act on the page (or navigate "reload") and call again.')
        }
        return textResult(driver.networkLog(str(args.filter) ?? '', args.clear === true))
      }
    },
    {
      name: 'search_history',
      title: 'Search history',
      description: "Search the user's browsing history by words in titles and URLs, most recent first, with local visit times. Empty query lists recent pages.",
      inputSchema: object({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }),
      annotations: { readOnlyHint: true },
      run: (args) => {
        const entries = deps.history.list(String(args.query ?? ''), Date.now() + 1, num(args.limit, 30))
        if (entries.length === 0) return textResult('Nothing in the history matches.')
        return textResult(
          entries.map((e) => `${localStamp(e.visitedAt)}  ${e.title || '(untitled)'} — ${e.url}`).join('\n')
        )
      }
    }
  ]
  return tools
}

export const AGENT_INSTRUCTIONS = `Another Arc is the user's own web browser. These tools act in it with the user's signed-in sessions, like a second pair of hands.

- Tabs: tools without tabId act on the tab the user is looking at ("this page", "this article"). For work of your own, open a tab with open_tab: it opens in the background, and the user can switch to it to watch your cursor. Keep using its tabId.
- Reading: read_page gives the main content as Markdown, which is best for summaries and research; read_page with query returns just the passages about one thing, which is far cheaper on long pages. search_history finds pages the user visited.
- Acting: take a snapshot (interactiveOnly: true for a short one) to get refs like [e12], then click / type / fill / press_key with them. Snapshots stay small: off-screen parts fold into summaries you can expand with ref. Actions say what they changed, so a new snapshot is only needed when the page changes a lot. find locates elements by text anywhere on the page, folded or not. screenshot shows how the page looks; click accepts x, y from it.
- Dialogs: when an action opens an alert / confirm / prompt, the page freezes until you answer it with handle_dialog.
- Web development: console_logs, network_requests and evaluate (JavaScript in the page) help test and debug web apps.
- It is the user's real browser and accounts. Ask before buying, sending or posting anything, deleting data, or changing account settings, unless the user asked for exactly that.`
