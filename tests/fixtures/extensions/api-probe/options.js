chrome.storage.local.get('probe:value').then((r) => {
  chrome.runtime.sendMessage({ type: 'surface', surface: 'options', storageValue: r['probe:value'] ?? null })
})
