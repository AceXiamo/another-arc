chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  const url = tabs[0]?.url ?? ''
  document.getElementById('out').textContent = url
  chrome.runtime.sendMessage({ type: 'surface', surface: 'popup', activeUrl: url })
})
