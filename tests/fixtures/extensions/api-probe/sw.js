// API Probe service worker. On a "start" message from the content script on
// http://127.0.0.1:<port>/probe it runs every check below and POSTs the
// results to <origin>/report. Each check is independent and time-limited.

// MV3 workers are stopped when idle, so (like real extensions) record
// lifecycle events in storage rather than in globals.
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.set({ 'probe:installed': details?.reason ?? 'unknown' })
})
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ 'probe:startup': true })
})

const events = { created: [], updated: [], removed: [], activated: [], committed: [], completed: [], webRequest: [], storage: [] }
const safe = (fn) => {
  try {
    fn()
    return true
  } catch {
    return false
  }
}
safe(() => chrome.tabs.onCreated.addListener((t) => events.created.push(t.id)))
safe(() => chrome.tabs.onUpdated.addListener((id, info) => info.status === 'complete' && events.updated.push(id)))
safe(() => chrome.tabs.onRemoved.addListener((id) => events.removed.push(id)))
safe(() => chrome.tabs.onActivated.addListener((i) => events.activated.push(i.tabId)))
safe(() => chrome.webNavigation.onCommitted.addListener((d) => d.frameId === 0 && events.committed.push(d.tabId)))
safe(() => chrome.webNavigation.onCompleted.addListener((d) => d.frameId === 0 && events.completed.push(d.tabId)))
safe(() =>
  chrome.webRequest.onBeforeRequest.addListener((d) => void events.webRequest.push(d.url), {
    urls: ['http://127.0.0.1/*']
  })
)
safe(() => chrome.storage.onChanged.addListener((changes) => events.storage.push(Object.keys(changes))))

const surfaces = {}
let origin = null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(50)
  }
  return pred()
}
function withTimeout(promise, ms = 4000) {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`timeout after ${ms}ms`)))])
}

async function runChecks(tabId) {
  const results = []
  const check = async (api, name, fn) => {
    try {
      const detail = await withTimeout(Promise.resolve().then(fn))
      results.push({ api, name, ok: detail !== false, detail: detail === true || detail === false ? '' : String(detail ?? '') })
    } catch (error) {
      results.push({ api, name, ok: false, detail: String(error?.message ?? error) })
    }
  }

  // -- runtime ---------------------------------------------------------------
  await check('runtime', 'getManifest', () => chrome.runtime.getManifest().name === 'API Probe')
  await check('runtime', 'id/getURL', () => Boolean(chrome.runtime.id) && chrome.runtime.getURL('x').startsWith('chrome-extension://'))
  await check('runtime', 'onInstalled', async () => {
    let r
    const end = Date.now() + 3000
    while (Date.now() < end && r === undefined) {
      r = (await chrome.storage.local.get('probe:installed'))['probe:installed']
      if (r === undefined) await sleep(100)
    }
    if (r !== 'install') throw new Error(`stored reason=${r}`)
    return true
  })
  await check('runtime', 'content→sw sendMessage', () => true)
  await check('runtime', 'getContexts', async () => {
    const all = await chrome.runtime.getContexts({})
    const bg = await chrome.runtime.getContexts({ contextTypes: ['BACKGROUND'] })
    return bg.length >= 1 && all.length >= bg.length ? true : `all=${all.length} bg=${bg.length}`
  })
  await check('runtime', 'getPlatformInfo', async () => (await chrome.runtime.getPlatformInfo()).os)

  // -- tabs ----------------------------------------------------------------------
  await check('tabs', 'sw→content sendMessage', async () => {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' })
    return r?.type === 'pong' ? r.title : false
  })
  await check('tabs', 'connect (port)', async () => {
    const port = chrome.tabs.connect(tabId)
    const echoed = await new Promise((resolve) => {
      port.onMessage.addListener((m) => resolve(m?.echo === 'hi'))
      port.postMessage('hi')
    })
    port.disconnect()
    return echoed
  })
  await check('tabs', 'query(active)', async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    return tabs.some((t) => t.id === tabId) || `got ${tabs.map((t) => t.url).join(',')}`
  })
  await check('tabs', 'get', async () => (await chrome.tabs.get(tabId)).url?.includes('/probe'))

  let created = null
  await check('tabs', 'create', async () => {
    created = await chrome.tabs.create({ url: `${origin}/page/created`, active: false })
    return typeof created?.id === 'number'
  })
  await check('tabs', 'onCreated', () => waitFor(() => events.created.includes(created?.id)))
  await check('tabs', 'onUpdated(complete)', () => waitFor(() => events.updated.includes(created?.id), 5000))
  await check('webNavigation', 'onCommitted', () => waitFor(() => events.committed.includes(created?.id)))
  await check('webNavigation', 'onCompleted', () => waitFor(() => events.completed.includes(created?.id)))
  await check('webNavigation', 'getAllFrames', async () => (await chrome.webNavigation.getAllFrames({ tabId }))?.length >= 1)
  await check('webRequest', 'onBeforeRequest', () => waitFor(() => events.webRequest.some((u) => u.includes('/page/created'))))
  await check('tabs', 'update(url)', async () => {
    const t = await chrome.tabs.update(created.id, { url: `${origin}/page/updated` })
    return Boolean(t)
  })
  await check('tabs', 'update(active)+onActivated', async () => {
    await chrome.tabs.update(created.id, { active: true })
    const ok = await waitFor(() => events.activated.includes(created.id))
    await chrome.tabs.update(tabId, { active: true })
    return ok
  })
  await check('tabs', 'remove+onRemoved', async () => {
    await chrome.tabs.remove(created.id)
    return waitFor(() => events.removed.includes(created.id))
  })

  // -- scripting ---------------------------------------------------------------------
  await check('scripting', 'executeScript(func)', async () => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title })
    return r?.result === 'Probe' ? true : `result=${r?.result}`
  })
  await check('scripting', 'insertCSS', async () => {
    await chrome.scripting.insertCSS({ target: { tabId }, css: 'body { outline: 3px solid rgb(1, 2, 3) }' })
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => getComputedStyle(document.body).outlineColor })
    return r?.result === 'rgb(1, 2, 3)' ? true : `outline=${r?.result}`
  })
  await check('scripting', 'registerContentScripts', async () => {
    await chrome.scripting.registerContentScripts([
      { id: 'probe-dynamic', matches: ['http://127.0.0.1/*'], js: ['content.js'], runAt: 'document_idle' }
    ])
    const list = await chrome.scripting.getRegisteredContentScripts()
    await chrome.scripting.unregisterContentScripts({ ids: ['probe-dynamic'] })
    return list.some((s) => s.id === 'probe-dynamic')
  })

  // -- storage ---------------------------------------------------------------------------
  await check('storage', 'local', async () => {
    await chrome.storage.local.set({ 'probe:value': 42 })
    return (await chrome.storage.local.get('probe:value'))['probe:value'] === 42
  })
  await check('storage', 'onChanged', () => waitFor(() => events.storage.some((k) => k.includes('probe:value'))))
  await check('storage', 'session', async () => {
    await chrome.storage.session.set({ s: 1 })
    return (await chrome.storage.session.get('s')).s === 1
  })
  await check('storage', 'sync', async () => {
    await chrome.storage.sync.set({ y: 'z' })
    return (await chrome.storage.sync.get('y')).y === 'z'
  })

  // -- action ------------------------------------------------------------------------------
  await check('action', 'setBadgeText/getBadgeText', async () => {
    await chrome.action.setBadgeText({ text: '7', tabId })
    return (await chrome.action.getBadgeText({ tabId })) === '7'
  })
  await check('action', 'setTitle/getTitle', async () => {
    await chrome.action.setTitle({ title: 'Probe!', tabId })
    return (await chrome.action.getTitle({ tabId })) === 'Probe!'
  })
  await check('action', 'setBadgeBackgroundColor', async () => {
    await chrome.action.setBadgeBackgroundColor({ color: '#ff0000' })
    return true
  })

  // -- misc ----------------------------------------------------------------------------------
  await check('contextMenus', 'create', async () => {
    await new Promise((resolve, reject) =>
      chrome.contextMenus.create({ id: 'probe', title: 'Probe item', contexts: ['page'] }, () =>
        chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
      )
    )
    return true
  })
  await check('alarms', 'create/get', async () => {
    await chrome.alarms.create('probe', { delayInMinutes: 5 })
    const a = await chrome.alarms.get('probe')
    await chrome.alarms.clear('probe')
    return a?.name === 'probe'
  })
  await check('cookies', 'set/get', async () => {
    await chrome.cookies.set({ url: `${origin}/`, name: 'probe', value: 'v1' })
    const c = await chrome.cookies.get({ url: `${origin}/`, name: 'probe' })
    return c?.value === 'v1'
  })
  await check('i18n', 'getUILanguage', () => chrome.i18n.getUILanguage())
  await check('permissions', 'contains', async () => chrome.permissions.contains({ permissions: ['tabs'] }))
  await check('windows', 'getCurrent/getAll', async () => {
    const all = await chrome.windows.getAll()
    const cur = await chrome.windows.getCurrent()
    return all.length >= 1 && typeof cur?.id === 'number'
  })
  await check('notifications', 'create', async () => {
    const id = await new Promise((resolve) =>
      chrome.notifications.create('probe', { type: 'basic', iconUrl: 'icon.png', title: 'Probe', message: 'hello' }, resolve)
    )
    chrome.notifications.clear('probe')
    return id === 'probe'
  })
  await check('management', 'getSelf', async () => (await chrome.management.getSelf())?.name === 'API Probe')
  await check('fetch', 'cross-origin from SW (host permission)', async () => (await fetch(`${origin}/page/fetched`)).ok)
  await check('declarativeNetRequest', 'updateDynamicRules + block', async () => {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [
        { id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '/blocked-by-dnr', resourceTypes: ['xmlhttprequest', 'other'] } }
      ]
    })
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        new Promise((resolve) => {
          addEventListener('message', (e) => e.data?.type === 'probe-fetch-result' && resolve(e.data.status))
          postMessage({ type: 'probe-fetch', url: '/blocked-by-dnr' }, '*')
        })
    })
    return r?.result === 'blocked' ? true : `fetch ${r?.result}`
  })
  await check('offscreen', 'createDocument', async () => {
    await chrome.offscreen.createDocument({ url: 'options.html', reasons: ['DOM_PARSER'], justification: 'probe' })
    await chrome.offscreen.closeDocument()
    return true
  })
  await check('sidePanel', 'available', () => typeof chrome.sidePanel?.setOptions === 'function')
  await check('userScripts', 'available', () => typeof chrome.userScripts?.register === 'function')

  return results
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'start' && sender.tab?.id !== undefined) {
    origin = message.origin
    sendResponse({ ok: true })
    runChecks(sender.tab.id).then((results) =>
      fetch(`${origin}/report`, { method: 'POST', body: JSON.stringify({ kind: 'checks', results }) })
    )
    return false
  }
  if (message?.type === 'surface' && origin) {
    surfaces[message.surface] = message
    fetch(`${origin}/report`, { method: 'POST', body: JSON.stringify({ kind: 'surface', ...message }) })
  }
  return false
})
