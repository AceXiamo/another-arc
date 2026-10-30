import { ipcRenderer } from 'electron'
import { applyCloudGameLatency, isOfferedOn, SITE_SETTING_IPC } from '@shared/site-settings'

// Runs before the page's own scripts. Every other site pays one comparison;
// only an offered site asks main (synchronously, as the page must not start
// on the old settings).

if (window.top === window && isOfferedOn('cloudGameLowLatency', location.origin)) {
  try {
    applyCloudGameLatency(localStorage, ipcRenderer.sendSync(SITE_SETTING_IPC, 'cloudGameLowLatency') === true)
  } catch (error) {
    console.warn('[site-settings]', error)
  }
}
