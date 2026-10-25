// Side Panel Probe service worker. Like real wallets, it configures the panel
// synchronously at the very top of the worker: before the compat shim,
// chrome.sidePanel was undefined in Electron and this line killed the worker.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

chrome.sidePanel.onOpened?.addListener((info) => chrome.storage.local.set({ 'sp:opened': info }))
chrome.sidePanel.onClosed?.addListener((info) => chrome.storage.local.set({ 'sp:closed': info }))

async function runChecks() {
  const out = {}
  const check = async (name, fn) => {
    try {
      out[name] = await fn()
    } catch (error) {
      out[name] = `threw: ${error?.message ?? error}`
    }
  }
  await check('getPanelBehavior', async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)
  await check('getOptions', () => chrome.sidePanel.getOptions({}))
  await check('getOptions(callback)', () => new Promise((resolve) => chrome.sidePanel.getOptions({}, resolve)))
  await check('setOptions(tabId)', async () => {
    await chrome.sidePanel.setOptions({ tabId: 987654, path: 'panel.html?tab', enabled: true })
    return chrome.sidePanel.getOptions({ tabId: 987654 })
  })
  await check('getLayout', () => chrome.sidePanel.getLayout())
  return out
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'checks') {
    runChecks().then(sendResponse)
    return true
  }
  if (message?.type === 'open') {
    chrome.sidePanel.open({ windowId: message.windowId ?? -2 }).then(() => sendResponse({ ok: true }))
    return true
  }
  return false
})
