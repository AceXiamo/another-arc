import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { inMain, launch, quit, removeDir, rpc, tempDir } from './helpers'

// Agents over MCP, end to end: the test is the MCP client. It turns agents on
// the way Settings does, then drives a page through the HTTP endpoint with
// the same JSON-RPC an agent sends.

const FIXTURE = `<!doctype html><html><head><title>Agent fixture</title></head><body>
<header><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav></header>
<main>
  <article>
    <h1>Testing the agent</h1>
    <p>This page checks <strong>snapshots</strong>, <a href="/more">links</a> and forms.</p>
    <ul><li>First point</li><li>Second point</li></ul>
    <pre><code class="language-js">const answer = 42</code></pre>
    <table><tr><th>Name</th><th>Price</th></tr><tr><td>Apple</td><td>$1</td></tr></table>
  </article>
  <form id="f">
    <label>Email <input name="email" type="email" placeholder="you@example.com"></label>
    <label>Plan <select name="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select></label>
    <label><input type="checkbox" name="agree"> I agree to the terms</label>
    <input type="file" id="file" aria-label="Attachment">
    <button>Send</button>
  </form>
  <div id="out"></div>
  <a href="/"><img alt="Logo" width="120" height="90" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='90'%3E%3Crect width='120' height='90' fill='teal'/%3E%3C/svg%3E"></a>
  <div class="card" style="cursor:pointer;padding:8px" onclick="this.textContent='card opened'">Open the card</div>
  <button id="load" onclick="console.error('boom from page'); console.log('payload', { ok: 1 }); fetch('/ping?from=/api/data'); fetch('/api/data?x=1').then(r => r.json()).then(d => out.textContent = 'api ' + d.ok)">Load data</button>
  <a href="/docs" target="_blank">Docs in a new tab</a>
  <button onclick="out.textContent = confirm('Delete the draft?') ? 'deleted' : 'kept'">Delete draft</button>
  <button onclick="out.textContent = 'hello ' + prompt('Your name?', 'guest')">Ask name</button>
  <button onclick="document.getElementById('veil').style.display = 'block'">Cover everything</button>
  <div id="veil" style="position:fixed;inset:0;display:none;background:rgb(0 0 0 / 0.4)"></div>
</main>
<script>
  f.addEventListener('submit', (e) => {
    e.preventDefault()
    const d = new FormData(f)
    out.textContent = 'submitted ' + d.get('email') + ' ' + d.get('plan') + ' ' + (d.get('agree') ? 'agreed' : 'no')
  })
</script>
</body></html>`

/** A page much taller than the window: a long archive and a footer below the fold. */
const LONG = `<!doctype html><html><head><title>Long page</title></head><body>
<nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a></nav>
<main>
  <h1>Top of the page</h1>
  <p>Intro text.</p>
  <div style="height: 2400px"></div>
  <section aria-label="Archive">
    <h2>Archive</h2>
    <ul>${Array.from({ length: 300 }, (_, i) => `<li><a href="/a/${i + 1}">Archived post number ${i + 1} about things</a></li>`).join('')}</ul>
  </section>
  <h2>Pricing</h2>
  <p>The pro plan costs $12 a month.</p>
  <p>Unrelated words here.</p>
</main>
<footer>${Array.from({ length: 30 }, (_, i) => `<a href="/f/${i}">Footer link ${i}</a>`).join(' ')}</footer>
</body></html>`

let app: ElectronApplication
let userData: string
let server: Server
let site: string
let endpoint: string
let token: string
let session = ''

async function mcp(method: string, params: unknown = {}): Promise<any> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      ...(session ? { 'Mcp-Session-Id': session } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  })
  session ||= res.headers.get('mcp-session-id') ?? ''
  const body = await res.json()
  if (body.error) throw new Error(body.error.message)
  return body.result
}

/** Call a tool; returns its text, throwing when it reports an error. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await mcp('tools/call', { name, arguments: args })
  const text = result.content
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text)
    .join('\n')
  if (result.isError) throw new Error(text)
  return text
}

/** The ref of the element `needle` (`button "Send"`) names in a snapshot. */
function refOf(snapshot: string, needle: string): string {
  const lines = snapshot.split('\n')
  const line = lines.find((l) => l.includes(needle))
  let ref = line && /\[(e\d+)\]/.exec(line)?.[1]
  // Runs of plain links or buttons share a line: `- buttons: "Delete" [e12], "Ask" [e13]`.
  const [, role, name] = /^(\w+) (".*")$/.exec(needle) ?? []
  if (!ref && role && name) {
    const item = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\[(e\\d+)\\]`)
    ref = lines.filter((l) => l.includes(`- ${role}s: `)).map((l) => item.exec(l)?.[1]).find(Boolean)
  }
  if (!ref) throw new Error(`No ref for ${needle} in:\n${snapshot}`)
  return ref
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/data')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
    if (req.url === '/cached.css') {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'max-age=3600' }).end('body { margin: 0 }')
      return
    }
    if (req.url === '/cache' || req.url === '/cache2') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Cache</title><link rel="stylesheet" href="/cached.css"><h1>${req.url}</h1>`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(req.url === '/docs' ? '<!doctype html><title>Docs</title><h1>Docs</h1>' : req.url === '/long' ? LONG : FIXTURE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  userData = tempDir()
  ;({ app } = await launch(userData))
  // Playwright answers page dialogs itself unless someone listens for them.
  app.context().on('dialog', () => undefined)
  const shell = app.windows().find((p) => p.url().startsWith('app://shell'))!
  // A free port for this run.
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port
      probe.close(() => resolve(p))
    })
  })
  await rpc(shell, 'settings.update', { agentEnabled: true, agentPort: port })
  const info = await rpc<{ running: boolean; url: string; token: string }>(shell, 'agent.info')
  expect(info.running).toBe(true)
  endpoint = info.url
  token = info.token
  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', title: 'E2E Agent', version: '1' } })
})

test.afterAll(async () => {
  await quit(app)
  removeDir(userData)
  server.close()
})

test('lists its tools', async () => {
  const { tools } = await mcp('tools/list')
  const names = tools.map((t: { name: string }) => t.name)
  for (const name of ['list_tabs', 'open_tab', 'read_page', 'snapshot', 'click', 'type', 'fill', 'screenshot', 'evaluate', 'network_requests']) {
    expect(names).toContain(name)
  }
})

test('drives a page: snapshot, read, fill, click, type, keys', async () => {
  const opened = await tool('open_tab', { url: site })
  const tabId = /\[([0-9a-f]{8})\]/.exec(opened)![1]!
  expect(await tool('list_tabs')).toContain(`[${tabId}] "Agent fixture"`)
  // The tab shows as agent-driven while the agent works in it.
  expect(await inMain(app, (b, id: string) => [...b.tabs.model.tabs.values()].find((t: any) => t.id.startsWith(id))?.agent, tabId)).toBe(true)

  const snap = await tool('snapshot', { tabId })
  expect(snap).toContain('heading "Testing the agent" level=1')
  expect(snap).toMatch(/textbox "Email" \[e\d+\] placeholder="you@example.com"/)
  expect(snap).toMatch(/combobox "Plan" \[e\d+\] value="Free" options=\["Free", "Pro plan"\]/)
  expect(snap).toMatch(/checkbox "I agree to the terms" \[e\d+\] unchecked/)
  expect(snap).toMatch(/clickable "Open the card" \[e\d+\]/)
  // Where links go only when asked.
  expect(snap).toMatch(/link "Docs" \[e\d+\]$/m)
  expect(await tool('snapshot', { tabId, urls: true })).toMatch(/link "Docs" \[e\d+\] → \/docs/)
  expect(snap).toContain('- row: Name | Price')

  const short = await tool('snapshot', { tabId, interactiveOnly: true })
  expect(short).not.toContain('text:')
  expect(short.length).toBeLessThan(snap.length)

  const md = await tool('read_page', { tabId })
  expect(md).toContain('# Testing the agent')
  expect(md).toContain('**snapshots**')
  // Same-site links as paths, said once in the header.
  expect(md).toContain('(links on this site are written as paths)')
  expect(md).toContain('[links](/more)')
  expect(md).toContain('- First point\n- Second point')
  expect(md).toContain('```js\nconst answer = 42\n```')
  expect(md).toContain('| Name | Price |')
  // Navigation is not content.
  expect(md).not.toContain('[Home]')

  expect(await tool('find', { tabId, query: 'send button' })).toMatch(/^- button "Send" \[e\d+\]/)

  const email = refOf(snap, 'textbox "Email"')
  const filled = await tool('fill', {
    tabId,
    fields: [
      { ref: email, value: 'ada@example.com' },
      { ref: refOf(snap, 'combobox "Plan"'), value: 'Pro plan' },
      { ref: refOf(snap, 'checkbox "I agree'), value: 'true' }
    ]
  })
  expect(filled).toContain('Filled 3 fields')
  await tool('click', { tabId, ref: refOf(snap, 'button "Send"') })
  expect(await tool('evaluate', { tabId, script: 'out.textContent' })).toBe('submitted ada@example.com pro agreed')

  // Typing replaces with clear, Enter submits, Backspace deletes.
  await tool('type', { tabId, ref: email, text: 'bob@example.comx', clear: true })
  await tool('press_key', { tabId, key: 'Backspace' })
  await tool('press_key', { tabId, key: 'Enter' })
  expect(await tool('evaluate', { tabId, script: 'out.textContent' })).toBe('submitted bob@example.com pro agreed')

  // A script-driven element found by its pointer cursor.
  await tool('click', { tabId, ref: refOf(snap, 'clickable "Open the card"') })
  expect(await tool('evaluate', { tabId, script: "document.querySelector('.card').textContent" })).toBe('card opened')
})

test('debugging: console, network, evaluate, upload, screenshot', async () => {
  const tabId = /\[([0-9a-f]{8})\]/.exec(await tool('open_tab', { url: site }))![1]!
  const snap = await tool('snapshot', { tabId })
  await tool('click', { tabId, ref: refOf(snap, 'button "Load data"') })
  await tool('wait_for', { tabId, text: 'api true' })

  expect(await tool('console_logs', { tabId, level: 'error' })).toContain('[error] boom from page')
  // Logged objects arrive stringified; the log says how to see them.
  const logs = await tool('console_logs', { tabId, pattern: 'payload' })
  expect(logs).toContain('payload [object Object]')
  expect(logs).toContain('read their values with evaluate')
  const network = await tool('network_requests', { tabId })
  // Recorded from the tab's first request, the page itself included.
  expect(network).toMatch(/GET 200 document http:\/\/127\.0\.0\.1:\d+\//)
  const api = /\[([^\]]+)\] GET 200 fetch \S+\/api\/data\?x=1/.exec(network)
  expect(api).not.toBeNull()
  expect(await tool('network_requests', { tabId, requestId: api![1] })).toContain('{"ok":true}')
  // A filter skips query strings (where trackers carry other URLs) unless it looks like one.
  const byPath = await tool('network_requests', { tabId, filter: 'api/data' })
  expect(byPath).toContain('/api/data?x=1')
  expect(byPath).not.toContain('/ping')
  expect(await tool('network_requests', { tabId, filter: 'from=' })).toContain('/ping?from=/api/data')

  // A cache hit says where it came from instead of "0 B".
  const cacheTab = /\[([0-9a-f]{8})\]/.exec(await tool('open_tab', { url: `${site}/cache` }))![1]!
  await tool('navigate', { tabId: cacheTab, url: `${site}/cache2` })
  expect(await tool('network_requests', { tabId: cacheTab, filter: 'cached.css' })).toMatch(/cached\.css \((memory|disk) cache\)/)

  // History speaks local time, like the network log.
  const visit = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d) {2}Agent fixture/m.exec(await tool('search_history', { query: 'Agent fixture', limit: 1 }))
  expect(visit).not.toBeNull()
  const [, yy, mo, dd, hh, mi] = visit!.map(Number)
  expect(Math.abs(new Date(yy!, mo! - 1, dd, hh, mi).getTime() - Date.now())).toBeLessThan(10 * 60_000)

  expect(await tool('evaluate', { tabId, script: '1 + 1' })).toBe('2')
  expect(await tool('evaluate', { tabId, script: 'const a = [1, 2]\na.map((n) => n * 3)' })).toBe('[\n  3,\n  6\n]')
  expect(await tool('evaluate', { tabId, script: 'await new Promise((r) => setTimeout(() => r("later"), 10))' })).toBe('later')
  await expect(tool('evaluate', { tabId, script: 'throw new Error("nope")' })).rejects.toThrow('nope')
  await expect(tool('evaluate', { tabId, script: 'const = 1' })).rejects.toThrow('SyntaxError')

  const file = join(userData, 'note.txt')
  writeFileSync(file, 'hello')
  expect(await tool('upload_file', { tabId, ref: refOf(snap, 'button "Attachment"'), paths: [file] })).toContain('note.txt')
  expect(await tool('evaluate', { tabId, script: 'document.getElementById("file").files[0].name' })).toBe('note.txt')

  const shot = await mcp('tools/call', { name: 'screenshot', arguments: { tabId } })
  expect(shot.content[0].type).toBe('image')
  expect(shot.content[0].mimeType).toBe('image/jpeg')
  expect(Buffer.from(shot.content[0].data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8')

  // An inline link is one line tall; its screenshot still holds the whole image inside.
  const logo = await mcp('tools/call', { name: 'screenshot', arguments: { tabId, ref: refOf(snap, 'link "Logo"') } })
  const [, w, h] = /Element screenshot, (\d+)×(\d+)/.exec(logo.content.find((c: { type: string }) => c.type === 'text').text)!.map(Number)
  expect(w).toBe(120)
  expect(h).toBeGreaterThanOrEqual(90)
})

test('reports what actions did, and what is in the way', async () => {
  const tabId = /\[([0-9a-f]{8})\]/.exec(await tool('open_tab', { url: site }))![1]!
  const snap = await tool('snapshot', { tabId })

  expect(await tool('click', { tabId, ref: refOf(snap, 'link "Docs in a new tab"') })).toMatch(/opened a new tab: \[[0-9a-f]{8}\] .*\/docs/)

  await tool('click', { tabId, ref: refOf(snap, 'button "Cover everything"') })
  await expect(tool('click', { tabId, ref: refOf(snap, 'button "Send"') })).rejects.toThrow(/covered by <div#veil>/)

  expect(await tool('navigate', { tabId, url: `${site}/docs` })).toContain('Now at "Docs"')
  await expect(tool('click', { tabId, ref: refOf(snap, 'button "Send"') })).rejects.toThrow(/page this tab has since left/)
  expect(await tool('navigate', { tabId, url: 'back' })).toContain('"Agent fixture"')
})

test('page dialogs in a background tab wait for the agent', async () => {
  const tabId = /\[([0-9a-f]{8})\]/.exec(await tool('open_tab', { url: site }))![1]!
  const snap = await tool('snapshot', { tabId })

  expect(await tool('click', { tabId, ref: refOf(snap, 'button "Delete draft"') })).toContain('It opened a confirm dialog: "Delete the draft?"')
  expect(await tool('list_tabs')).toMatch(new RegExp(`\\[${tabId}\\].*waiting on a dialog`))
  // The page is frozen: say so rather than time out.
  await expect(tool('snapshot', { tabId })).rejects.toThrow(/waiting on a confirm dialog: "Delete the draft\?"/)
  expect(await tool('handle_dialog', { tabId, accept: true })).toContain('Accepted the confirm "Delete the draft?"')
  expect(await tool('evaluate', { tabId, script: 'out.textContent' })).toBe('deleted')

  await tool('click', { tabId, ref: refOf(snap, 'button "Ask name"') })
  // Without tabId: the one tab that has a dialog open.
  expect(await tool('handle_dialog', { accept: true, text: 'Ada' })).toContain('with "Ada"')
  expect(await tool('evaluate', { tabId, script: 'out.textContent' })).toBe('hello Ada')

  await tool('click', { tabId, ref: refOf(snap, 'button "Delete draft"') })
  await tool('handle_dialog', { tabId, accept: false })
  expect(await tool('evaluate', { tabId, script: 'out.textContent' })).toBe('kept')
  await expect(tool('handle_dialog', { tabId, accept: true })).rejects.toThrow('No dialog is open')
})

test('reads the tab the user is looking at by default', async () => {
  await inMain(app, (b, url: string) => b.tabs.createTab({ url }), `${site}/docs`)
  await expect.poll(() => tool('read_page').catch(() => '')).toContain('# Docs')
})

test('keeps snapshots and reading small on big pages', async () => {
  const tabId = /\[([0-9a-f]{8})\]/.exec(await tool('open_tab', { url: `${site}/long` }))![1]!
  const snap = await tool('snapshot', { tabId })
  expect(snap.length).toBeLessThan(13_000)
  expect(snap).toContain('heading "Top of the page" level=1')
  // Plain links in a row share a line.
  expect(snap).toMatch(/- links: "Home" \[e\d+\], "Docs" \[e\d+\], "Blog" \[e\d+\]/)
  // What is far below the window folds into a summary that says what it holds.
  expect(snap).toMatch(/300 items folded below the viewport \(~\d+ lines\): 300 links; starts with "Archived post number 1 about things"/)
  expect(snap).not.toContain('Archived post number 250')

  // find still sees folded parts, and a fold opens by its ref.
  expect(await tool('find', { tabId, query: 'Archived post number 250' })).toMatch(/link "Archived post number 250 about things" \[e\d+\] → \/a\/250/)
  const list = /snapshot ref=(e\d+) shows them/.exec(snap)?.[1]
  expect(list).toBeTruthy()
  expect(await tool('snapshot', { tabId, ref: list })).toContain('"Archived post number 250 about things"')

  // A question about a long page: just the passages that answer it.
  const passages = await tool('read_page', { tabId, query: 'pro plan price' })
  expect(passages).toContain('## Pricing')
  expect(passages).toContain('The pro plan costs $12 a month.')
  expect(passages).not.toContain('Archived post')
  expect(passages.length).toBeLessThan(500)
  // A cut says where the later sections start.
  expect(await tool('read_page', { tabId, maxChars: 2000 })).toMatch(/^- ## Pricing \(offset \d+\)$/m)
})
