import type { MoveTabOptions } from '@shared/ipc'
import { isSavedTab } from '@shared/tabs'
import {
  describeViewport,
  presetSpec,
  rotated,
  sanitizeViewport,
  VIEWPORT_LIMITS,
  VIEWPORT_PRESETS,
  type ViewportSpec
} from '@shared/viewport'
import type { HistoryService } from '../history/history-service'
import type { PageDialogs } from '../tabs/page-dialogs'
import type { TabData } from '../tabs/model'
import type { TabManager } from '../tabs/tab-manager'
import { textResult, ToolError, type JsonSchema, type McpTool, type McpToolResult } from './mcp-server'
import { waitForLoad, type TabDriver, type Target } from './tab-driver'

// The tools agents see. Descriptions are written for a language model:
// what the tool is for, what comes back, and how it connects to the others.

export interface ToolDeps {
  tabs: TabManager
  history: HistoryService
  dialogs: Pick<PageDialogs, 'list' | 'respond'>
  /** A tab by id or unique prefix; the tab the user is looking at when omitted. */
  resolveTab(id: string | undefined): TabData
  /** The tab's driver: woken, loaded, sized and marked as agent-driven. */
  driver(id: string | undefined): Promise<TabDriver>
  /** Open a tab for an agent (network recorded from its first request). */
  openTab(input: string, activate: boolean): Promise<TabData>
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

const destination: JsonSchema = { type: 'string' }
const spaceId: JsonSchema = { type: 'string', description: 'Space id from list_tabs (or its exact name). Default: the current space.' }
const index: JsonSchema = { type: 'integer', minimum: 0, description: 'Position in the target list (0 = first). Default: last.' }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** An id, a unique id prefix, or an exact name (ignoring case). */
function pick<T extends { id: string; name: string }>(items: Iterable<T>, key: string, kind: string): T {
  const all = [...items]
  const exact = all.find((i) => i.id === key)
  if (exact) return exact
  const byId = all.filter((i) => i.id.startsWith(key))
  if (byId.length === 1) return byId[0]!
  const byName = all.filter((i) => i.name.toLowerCase() === key.toLowerCase())
  if (byName.length === 1) return byName[0]!
  if (byId.length > 1 || byName.length > 1) throw new ToolError(`${kind} "${key}" is ambiguous; use its id from list_tabs`)
  throw new ToolError(`No ${kind.toLowerCase()} "${key}". Call list_tabs for ids.`)
}

/** A web address to save; bare hosts get https. */
function bookmarkUrl(input: string): string {
  const text = input.trim()
  for (const candidate of [text, `https://${text}`]) {
    try {
      const url = new URL(candidate)
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return url.href
    } catch {
      // Try the next form.
    }
  }
  throw new ToolError(`Not a web address: ${JSON.stringify(input)}`)
}
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

  const resolveFolder = (key: string) => pick(tabs.model.folders.values(), key, 'Folder')
  const resolveSpace = (key: string | undefined) => {
    if (key) return pick(tabs.model.spaces.values(), key, 'Space')
    const space = tabs.model.activeSpace()
    if (!space) throw new ToolError('There is no space')
    return space
  }

  /** Where `to` ("favorites", "pinned", "tabs" or a folder) puts a tab, as the model's move target. */
  const placeTab = (to: string, spaceKey: string | undefined, at: unknown, fallbackSpace?: string): MoveTabOptions => {
    const i = typeof at === 'number' ? at : undefined
    if (to === 'favorites' || to === 'pinned' || to === 'tabs') {
      const space = resolveSpace(spaceKey ?? fallbackSpace)
      if (to === 'favorites') return { spaceId: space.id, pinned: true, index: i ?? space.pinnedTabIds.length }
      if (to === 'pinned') return { spaceId: space.id, pinned: false, saved: true, index: i ?? space.savedIds.length }
      return { spaceId: space.id, pinned: false, index: i ?? 0 }
    }
    const folder = resolveFolder(to)
    if (spaceKey && resolveSpace(spaceKey).id !== folder.spaceId) throw new ToolError(`Folder ${JSON.stringify(folder.name)} is in another space`)
    return { spaceId: folder.spaceId, pinned: false, folderId: folder.id, index: i ?? folder.childIds.length }
  }

  const describePlace = (id: string): string => {
    const tab = tabs.model.getTab(id)
    if (!tab) return 'nowhere (it is gone)'
    const space = tabs.model.getSpace(tab.spaceId)
    const folder = tab.folderId ? tabs.model.getFolder(tab.folderId) : undefined
    const where = folder ? `folder ${JSON.stringify(folder.name)}` : tab.pinned ? 'the favorites' : isSavedTab(tab) ? 'the pinned tabs' : 'the tabs'
    return `${where} of space ${JSON.stringify(space?.name ?? '')}`
  }

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
      run: async (args) => {
        const tab = await deps.openTab(String(args.url), args.activate === true)
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
      description:
        'Close a tab. Favorites, pinned tabs and tabs in folders are bookmarks: closing unloads them and keeps the bookmark; ' +
        'remove: true deletes the bookmark from the sidebar too.',
      inputSchema: object({ tabId, remove: { type: 'boolean', description: 'Delete a bookmark instead of just unloading it.' } }, ['tabId']),
      annotations: { destructiveHint: true },
      run: (args) => {
        const tab = deps.resolveTab(str(args.tabId))
        const label = deps.describeTab(tab)
        if (args.remove === true) {
          tabs.deleteTab(tab.id)
          return textResult(`Removed ${label}${isSavedTab(tab) ? ' from the sidebar' : ''}.`)
        }
        tabs.closeTab(tab.id)
        return textResult(isSavedTab(tab) ? `Unloaded ${label}; the bookmark stays (remove: true deletes it).` : `Closed ${label}.`)
      }
    },

    // -- bookmarks: favorites, pinned tabs and folders in the sidebar --------------
    {
      name: 'add_bookmark',
      title: 'Add bookmark',
      description:
        'Save a URL in the sidebar without opening it: as a pinned tab (default), a favorite, or into a folder. ' +
        'Returns the new tab id; activating it (select_tab) loads the page.',
      inputSchema: object(
        {
          url: { type: 'string', description: 'http(s) URL.' },
          title: { type: 'string', description: 'Shown until the page is first loaded. Default: the host name.' },
          to: { ...destination, description: 'Where: "pinned" (default), "favorites", or a folder id from list_tabs.' },
          spaceId,
          index
        },
        ['url']
      ),
      run: (args) => {
        const url = bookmarkUrl(String(args.url))
        const where = str(args.to) ?? 'pinned'
        if (where === 'tabs') throw new ToolError('A bookmark goes to "pinned", "favorites" or a folder; use open_tab for an ordinary tab')
        const target = placeTab(where, str(args.spaceId), args.index)
        const id = tabs.addUnloadedTab({
          spaceId: target.spaceId,
          url,
          title: str(args.title) ?? new URL(url).hostname,
          pinned: target.pinned,
          saved: target.saved,
          folderId: target.folderId
        })
        if (typeof args.index === 'number') tabs.moveTab(id, target)
        void tabs.prefetchFavicons([id]).catch(() => undefined)
        return textResult(`Added ${deps.describeTab(tabs.model.getTab(id)!)} to ${describePlace(id)}.`)
      }
    },
    {
      name: 'move_tab',
      title: 'Move tab',
      description:
        'Move a tab or bookmark: into a folder, to the favorites, to the pinned tabs (saving an open tab as a bookmark), ' +
        'or to the ordinary tabs (no longer a bookmark); also between spaces and to a position. ' +
        'Without index it goes to the end (the top, for "tabs").',
      inputSchema: object(
        {
          tabId,
          to: { ...destination, description: '"favorites", "pinned", "tabs", or a folder id from list_tabs.' },
          spaceId,
          index
        },
        ['tabId', 'to']
      ),
      run: (args) => {
        const tab = deps.resolveTab(str(args.tabId))
        // Without a space, a tab stays in its own.
        const target = placeTab(String(args.to), str(args.spaceId), args.index, tab.spaceId)
        tabs.moveTab(tab.id, target)
        return textResult(`Moved ${deps.describeTab(tab)} to ${describePlace(tab.id)}.`)
      }
    },
    {
      name: 'create_folder',
      title: 'Create folder',
      description:
        "Create a folder among the sidebar's pinned tabs, at the top level or inside another folder, optionally saving tabs into it. Returns its id.",
      inputSchema: object({
        name: { type: 'string' },
        spaceId,
        parentId: { type: 'string', description: 'Create it inside this folder (id from list_tabs). Default: top level.' },
        index: { ...index, description: 'Position among its siblings. Default: first.' },
        tabIds: { type: 'array', items: { type: 'string' }, description: 'Tabs (of the same space) to save into it.' }
      }),
      run: (args) => {
        const parent = str(args.parentId) ? resolveFolder(String(args.parentId)) : undefined
        const space = parent ? tabs.model.getSpace(parent.spaceId)! : resolveSpace(str(args.spaceId))
        const tabIds = Array.isArray(args.tabIds) ? args.tabIds.map((id) => deps.resolveTab(String(id))) : []
        const elsewhere = tabIds.filter((t) => t.spaceId !== space.id)
        if (elsewhere.length) throw new ToolError(`${elsewhere.map((t) => deps.describeTab(t)).join(', ')} ${elsewhere.length > 1 ? 'are' : 'is'} in another space; move_tab it first`)
        const id = tabs.createFolder({
          spaceId: space.id,
          parentId: parent?.id ?? null,
          index: typeof args.index === 'number' ? args.index : 0,
          name: str(args.name),
          tabIds: tabIds.map((t) => t.id)
        })
        const folder = id ? tabs.model.getFolder(id) : undefined
        if (!folder) throw new ToolError('Could not create the folder')
        return textResult(
          `Created folder [${deps.shortId(folder.id)}] ${JSON.stringify(folder.name)} in space ${JSON.stringify(space.name)}` +
            `${parent ? ` inside ${JSON.stringify(parent.name)}` : ''}${folder.childIds.length ? ` with ${folder.childIds.length} tab${folder.childIds.length > 1 ? 's' : ''}` : ''}.`
        )
      }
    },
    {
      name: 'update_folder',
      title: 'Update folder',
      description: 'Rename a folder, open or collapse it in the sidebar, or move it: into another folder (parentId) or to the top level (parentId: "top"), and to a position.',
      inputSchema: object(
        {
          folderId: { type: 'string', description: 'Folder id from list_tabs (a unique prefix or the exact name also works).' },
          name: { type: 'string' },
          collapsed: { type: 'boolean' },
          parentId: { type: 'string', description: 'Folder id to move it into, or "top".' },
          index: { ...index, description: 'Position among its new siblings. Default: last.' }
        },
        ['folderId']
      ),
      run: (args) => {
        const folder = resolveFolder(String(args.folderId))
        const done: string[] = []
        const name = str(args.name)
        if (name !== undefined) {
          tabs.renameFolder(folder.id, name)
          done.push(`renamed to ${JSON.stringify(tabs.model.getFolder(folder.id)!.name)}`)
        }
        if (typeof args.collapsed === 'boolean') {
          tabs.setFolderCollapsed(folder.id, args.collapsed)
          done.push(args.collapsed ? 'collapsed' : 'opened')
        }
        const parentArg = str(args.parentId)
        if (parentArg !== undefined || typeof args.index === 'number') {
          const parent = parentArg === undefined ? (folder.parentId ? tabs.model.getFolder(folder.parentId) : undefined) : parentArg === 'top' ? undefined : resolveFolder(parentArg)
          if (parent && parent.spaceId !== folder.spaceId) throw new ToolError('Folders move within their space only')
          if (parent?.id === folder.id) throw new ToolError('A folder cannot go inside itself')
          const siblings = parent ? parent.childIds : tabs.model.getSpace(folder.spaceId)!.savedIds
          const count = siblings.filter((id) => id !== folder.id).length
          tabs.moveFolder(folder.id, { parentId: parent?.id ?? null, index: typeof args.index === 'number' ? args.index : count })
          const now = tabs.model.getFolder(folder.id)!
          if (now.parentId !== (parent?.id ?? null)) throw new ToolError('Cannot move a folder into one of its own sub-folders')
          done.push(`moved ${parent ? `into ${JSON.stringify(parent.name)}` : 'to the top level'}`)
        }
        if (done.length === 0) throw new ToolError('Pass name, collapsed, parentId or index')
        return textResult(`Folder [${deps.shortId(folder.id)}] ${done.join(', ')}.`)
      }
    },
    {
      name: 'delete_folder',
      title: 'Delete folder',
      description: 'Delete a folder with its sub-folders and every bookmark saved in them. Move tabs out first (move_tab) to keep them.',
      inputSchema: object({ folderId: { type: 'string', description: 'Folder id from list_tabs.' } }, ['folderId']),
      annotations: { destructiveHint: true },
      run: (args) => {
        const folder = resolveFolder(String(args.folderId))
        const before = tabs.model.tabs.size
        tabs.deleteFolder(folder.id)
        const removed = before - tabs.model.tabs.size
        return textResult(`Deleted folder ${JSON.stringify(folder.name)}${removed ? ` and ${removed} bookmark${removed > 1 ? 's' : ''} in it` : ''}.`)
      }
    },
    {
      name: 'navigate',
      title: 'Navigate',
      description:
        'Load a URL (or search words) in a tab, or go "back", "forward" or "reload", and wait for the page to load.',
      inputSchema: object({ url: { type: 'string', description: 'URL, search words, or back / forward / reload.' }, tabId }, ['url']),
      annotations: { openWorldHint: true },
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
        if (await driver.call<boolean>('isPdf').catch(() => false)) {
          return textResult(`This tab shows a PDF: ${driver.wc.getURL()}\nThe browser cannot extract its text; download it (e.g. curl -L) and read it with a PDF tool.`)
        }
        const offset = num(args.offset, 0)
        const query = str(args.query)
        driver.scan()
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
        driver.scan()
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
        driver.scan()
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
        const text = String(args.text)
        return act(driver, async () => {
          let label = 'the focused element'
          const r = str(args.ref)
          if (r) {
            const t = await driver.target({ ref: r })
            label = t.label
            if (!t.covered) await driver.click(t)
          }
          const focus = await driver.call<{ kind: string; label: string }>('focusField', { ref: r, mode: args.clear ? 'select' : 'end' })
          if (!r) {
            label = focus.label
            driver.holdCursor()
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
              await driver.click(t)
              done.push(`${plan.label} → ${field.value}`)
            } else {
              const t = await driver.target({ ref: field.ref })
              if (!t.covered) await driver.hover(t)
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
        const count = num(args.count, 1)
        driver.holdCursor()
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
          const size = driver.viewportSize()
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const open = deps.dialogs.list()
        const id = str(args.tabId)
        const dialog = id
          ? open.find((d) => d.tabId === deps.resolveTab(id).id)
          : (open.find((d) => d.tabId === tabs.model.activeTab()?.id) ?? (open.length === 1 ? open[0] : undefined))
        if (!dialog) throw new ToolError(open.length > 1 ? 'Several tabs have a dialog open; pass tabId' : 'No dialog is open there')
        const driver = await deps.driver(dialog.tabId)
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      run: async (args) => {
        const driver = await deps.driver(str(args.tabId))
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
      name: 'set_viewport',
      title: 'Emulate device',
      description:
        'Lay a tab out as another screen shows it, like Chrome\'s device mode: a device preset, or any width × height (CSS px), ' +
        'with a pixel ratio and mobile mode (touch input, mobile user agent, the page\'s meta viewport). ' +
        'For checking responsive layouts at several sizes. The user sees it with a device toolbar; snapshot, screenshot, click and the rest work ' +
        'in the emulated viewport. It stays across navigations until reset: true. A mobile user agent reaches the server from the next load (navigate "reload").',
      inputSchema: object({
        tabId,
        preset: { type: 'string', enum: VIEWPORT_PRESETS.map((p) => p.id), description: VIEWPORT_PRESETS.map((p) => `${p.id} (${p.width}×${p.height})`).join(', ') },
        width: { type: 'integer', minimum: VIEWPORT_LIMITS.min, maximum: VIEWPORT_LIMITS.max },
        height: { type: 'integer', minimum: VIEWPORT_LIMITS.min, maximum: VIEWPORT_LIMITS.max },
        deviceScaleFactor: { type: 'number', minimum: 0, maximum: 4, description: 'Pixel ratio; 0 = this screen\'s. Presets bring their own.' },
        mobile: { type: 'boolean', description: 'Touch input, mobile user agent, meta viewport. Presets: phones and tablets are mobile.' },
        landscape: { type: 'boolean', description: 'Turn the device sideways (width > height).' },
        reset: { type: 'boolean', description: 'Back to the window\'s own size.' }
      }),
      run: async (args) => {
        const tab = deps.resolveTab(str(args.tabId))
        if (args.reset === true) {
          tabs.setViewport(tab.id, null)
          return textResult(`${deps.describeTab(tab)} is back at the window's size.`)
        }
        const current = tab.viewport ?? null
        const preset = str(args.preset)
        let base: ViewportSpec | null = preset ? presetSpec(preset) : current
        if (preset && !base) throw new ToolError(`No preset "${preset}"`)
        const width = typeof args.width === 'number' ? args.width : undefined
        const height = typeof args.height === 'number' ? args.height : undefined
        if (!base) {
          if (width === undefined || height === undefined) throw new ToolError('Pass a preset, or width and height')
          base = { width, height, deviceScaleFactor: 0, mobile: false, preset: null }
        }
        let spec: ViewportSpec = {
          ...base,
          ...(width !== undefined ? { width, preset: null } : {}),
          ...(height !== undefined ? { height, preset: null } : {}),
          ...(typeof args.deviceScaleFactor === 'number' ? { deviceScaleFactor: args.deviceScaleFactor } : {}),
          ...(typeof args.mobile === 'boolean' ? { mobile: args.mobile } : {})
        }
        if (typeof args.landscape === 'boolean' && args.landscape !== spec.width > spec.height) spec = rotated(spec)
        const clean = sanitizeViewport(spec)
        if (!clean) throw new ToolError('That is not a viewport size')
        if (!tabs.setViewport(tab.id, clean)) throw new ToolError(`${deps.describeTab(tab)} shows a browser page; emulate devices in web pages`)
        const driver = await deps.driver(tab.id)
        const layout = await driver.evaluate('`${innerWidth}×${innerHeight}`').catch(() => null)
        const css = layout?.ok ? layout.text.replace(/"/g, '') : null
        return textResult(
          `Emulating ${describeViewport(clean)} in ${deps.describeTab(tab)}.` +
            (css && css !== `${clean.width}×${clean.height}` ? ` The page lays out at ${css} CSS px (no meta viewport, or zoomed).` : '')
        )
      }
    },
    {
      name: 'devtools',
      title: 'Show DevTools',
      description:
        'Open DevTools for the user, docked where they keep them, optionally on an element (ref) in the Elements panel; or close them. ' +
        'For pointing the user at something. To read the console or network yourself, use console_logs and network_requests.',
      inputSchema: object({ tabId, ref, open: { type: 'boolean', description: 'false closes them. Default true.' } }),
      run: async (args) => {
        const tab = deps.resolveTab(str(args.tabId))
        if (args.open === false) {
          tabs.closeDevTools(tab.id)
          return textResult(`Closed DevTools of ${deps.describeTab(tab)}.`)
        }
        let inspect: { x: number; y: number } | undefined
        let label = ''
        if (str(args.ref)) {
          const driver = await deps.driver(tab.id)
          const t = await driver.target({ ref: args.ref })
          const rt = tabs.runtime(tab.id)
          const scale = driver.wc.getZoomFactor() * (rt?.emulationScale ?? 1)
          inspect = { x: t.x * scale, y: t.y * scale }
          label = ` on ${t.label}`
        }
        if (!tabs.openDevTools(tab.id, { inspect, focus: false })) throw new ToolError(`${deps.describeTab(tab)} has no web page to inspect`)
        const where = tabs.getDevToolsDock() === 'undocked' ? 'in their own window' : `docked ${tabs.getDevToolsDock()}`
        return textResult(`Opened DevTools${label} for ${deps.describeTab(tab)}, ${where}.`)
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
- Bookmarks are the sidebar's favorites, pinned tabs and folders (list_tabs shows them with ids). add_bookmark saves a URL without opening it; move_tab files a tab into a folder, the favorites or the pinned tabs (or back to the ordinary tabs); create_folder / update_folder / delete_folder organize folders. Closing a bookmark only unloads it; close_tab with remove: true deletes it.
- Dialogs: when an action opens an alert / confirm / prompt, the page freezes until you answer it with handle_dialog.
- Web development: console_logs, network_requests and evaluate (JavaScript in the page) help test and debug web apps. set_viewport lays a page out at a phone, tablet or desktop size (check responsive layouts, then reset: true); devtools opens DevTools for the user, on an element if you pass its ref.
- It is the user's real browser and accounts. Ask before buying, sending or posting anything, deleting data, or changing account settings, unless the user asked for exactly that.`
