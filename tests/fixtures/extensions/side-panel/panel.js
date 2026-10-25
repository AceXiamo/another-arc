// The panel reports where it runs, so the test can check getContexts sees a SIDE_PANEL.
chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).then((contexts) => {
  const self = contexts.some((c) => c.documentUrl === location.href)
  document.getElementById('out').textContent = self ? 'side panel' : 'not a side panel'
  chrome.storage.local.set({ 'sp:panel': { url: location.href, self } })
})
