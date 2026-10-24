// Marks the page so the test can see the content script ran, starts the probe
// on /probe and answers pings from the service worker.
document.documentElement.dataset.probeContent = '1'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ping') sendResponse({ type: 'pong', title: document.title })
})

chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((m) => port.postMessage({ echo: m }))
})

if (location.pathname === '/probe') {
  chrome.runtime.sendMessage({ type: 'start', origin: location.origin }, (reply) => {
    document.documentElement.dataset.probeStarted = reply?.ok ? '1' : '0'
  })
}

// Used by the DNR check: the page asks us to fetch a URL a dynamic rule blocks.
window.addEventListener('message', async (e) => {
  if (e.data?.type !== 'probe-fetch') return
  let status = 'ok'
  try {
    await fetch(e.data.url, { cache: 'no-store' })
  } catch {
    status = 'blocked'
  }
  window.postMessage({ type: 'probe-fetch-result', status }, '*')
})
