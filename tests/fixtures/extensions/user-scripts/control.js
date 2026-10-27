// Driven by the test: control.html?server=<origin>&step=<step>.
const params = new URLSearchParams(location.search)
const server = params.get('server')
const step = params.get('step')
const report = (data) => fetch(`${server}/report`, { method: 'POST', body: JSON.stringify({ step, ...data }) })

const steps = {
  async state(sw) {
    await report({ kind: 'state', page: typeof chrome.userScripts, sw: sw?.userScripts, commands: sw?.commands })
  },
  async register() {
    // Like Tampermonkey: eval and inline scripts in the user script world.
    await chrome.userScripts.configureWorld({ messaging: true, csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval' *" })
    await chrome.userScripts.register([
      {
        id: 'iso',
        matches: [`${server}/*`],
        includeGlobs: ['*/us-target*'],
        excludeGlobs: ['*nope*'],
        runAt: 'document_start',
        allFrames: true,
        js: [
          {
            code: [
              'var usTop = 1;',
              "let ev; try { ev = eval('6 * 7') } catch (e) { ev = 'blocked' }",
              "chrome.runtime.sendMessage({ kind: 'iso', href: location.href, top: typeof window.usTop, state: document.readyState, eval: ev, frame: top === window ? 'top' : 'sub' });",
              "if (top === window) chrome.runtime.sendMessage({ kind: 'dedupe' })"
            ].join('\n')
          }
        ]
      },
      {
        id: 'main',
        matches: [`${server}/*`],
        world: 'MAIN',
        js: [
          {
            code: `fetch('/report', { method: 'POST', body: JSON.stringify({ kind: 'main', href: location.href, runtime: typeof (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage), iso: typeof window.usTop }) })`
          }
        ]
      }
    ])
    let duplicate = null
    try {
      await chrome.userScripts.register([{ id: 'main', matches: ['<all_urls>'], js: [{ code: '' }] }])
    } catch (error) {
      duplicate = String(error?.message ?? error)
    }
    const scripts = await chrome.userScripts.getScripts()
    const visibleNative = await chrome.scripting.getRegisteredContentScripts()
    await report({
      kind: 'registered',
      ids: scripts.map((s) => s.id).sort(),
      hasCode: scripts.every((s) => typeof s.js?.[0]?.code === 'string' && s.js[0].code.length > 0),
      visibleNative: visibleNative.length,
      duplicate,
      worlds: (await chrome.userScripts.getWorldConfigurations()).map((w) => ({ messaging: w.messaging }))
    })
  },
  async swRegister() {
    const res = await chrome.runtime.sendMessage({ kind: 'sw-register', server })
    await report({ kind: 'sw-registered', ...res })
  },
  async execute() {
    const [tab] = await chrome.tabs.query({ url: `${server}/us-target*` })
    const results = await chrome.userScripts.execute({ target: { tabId: tab.id }, js: [{ code: '6 * 7' }] })
    await report({ kind: 'executed', result: results[0]?.result })
  },
  async unregister() {
    await chrome.userScripts.unregister({ ids: ['main', 'from-sw'] })
    const scripts = await chrome.userScripts.getScripts()
    await report({ kind: 'unregistered', ids: scripts.map((s) => s.id) })
  }
}

;(async () => {
  try {
    const sw = await chrome.runtime.sendMessage({ kind: 'sw-state', server })
    await steps[step](sw)
  } catch (error) {
    await report({ kind: 'error', error: String(error?.message ?? error) })
  }
})()
