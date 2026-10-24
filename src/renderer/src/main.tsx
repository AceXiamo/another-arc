import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { handleCommand, startUiEffects } from './lib/effects'
import { send } from './lib/rpc'
import { startTheme } from './lib/theme'
import { initBrowserState, receivePatch } from './stores/browser'

async function boot(): Promise<void> {
  // The preload started this request before any of our JS was parsed.
  initBrowserState(await window.arc.snapshot())
  window.arc.onPatch(receivePatch)
  window.arc.onCommand(handleCommand)
  startTheme()
  startUiEffects()
  // Commit the first render synchronously, then tell main right away. Do not
  // wait for requestAnimationFrame: the window is still hidden at this point
  // and hidden windows do not run rAF, which would stall startup.
  const root = createRoot(document.getElementById('root')!)
  flushSync(() => root.render(<App />))
  send('shell.ready')
}

void boot()
