// User Script Probe worker. Reports to the test server it learns from the
// control page (kept in storage: the worker and the app restart).
let server = null
const report = async (data) => {
  server ??= (await chrome.storage.local.get('server')).server
  if (server) await fetch(`${server}/report`, { method: 'POST', body: JSON.stringify(data) }).catch(() => undefined)
}

// The same function on both events (as Tampermonkey does) must run once per message.
let sharedCalls = 0
const shared = (msg) => {
  if (msg?.kind === 'dedupe') report({ kind: 'dedupe', calls: ++sharedCalls })
}
chrome.runtime.onUserScriptMessage.addListener(shared)
chrome.runtime.onMessage.addListener(shared)

chrome.runtime.onUserScriptMessage.addListener((msg, sender) => {
  if (msg?.kind === 'dedupe') return
  report({ kind: 'us-message', msg, url: sender.url, tab: typeof sender.tab?.id })
})

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.kind === 'sw-state') {
    server = msg.server
    chrome.storage.local.set({ server: msg.server }).then(async () => {
      const commands = await chrome.commands.getAll().catch(() => [])
      respond({ userScripts: typeof chrome.userScripts, commands })
    })
    return true
  }
  if (msg?.kind === 'sw-register') {
    chrome.userScripts
      .register([{ id: 'from-sw', matches: [`${msg.server}/*`], js: [{ code: `chrome.runtime.sendMessage({ kind: 'from-sw', href: location.href })` }] }])
      .then(
        () => respond({ ok: true }),
        (error) => respond({ ok: false, error: String(error?.message ?? error) })
      )
    return true
  }
  return undefined
})

chrome.commands.onCommand.addListener((name, tab) => report({ kind: 'command', name, tab: typeof tab?.id }))
