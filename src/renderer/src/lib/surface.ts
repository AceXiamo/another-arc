import { useEffect, useState } from 'react'
import { SURFACE_FRAME_PREFIX, type SurfaceId } from '@shared/layout'
import { useBrowser } from '../stores/browser'
import { mirrorTheme } from './theme'

/**
 * Opens (once) an about:blank child window that main turns into a floating
 * view above the page. Because it is our own opener-scripted window it lives
 * in the shell's renderer process, and React renders into it directly.
 */
export function useSurface(id: SurfaceId, wanted: boolean): HTMLElement | null {
  const [root, setRoot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!wanted) return
    const win = window.open('about:blank', SURFACE_FRAME_PREFIX + id)
    if (!win) return
    const doc = win.document
    doc.title = id
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const clone = node.cloneNode(true) as HTMLElement
      if (node instanceof HTMLLinkElement) (clone as HTMLLinkElement).href = node.href
      doc.head.appendChild(clone)
    }
    // Dev: Vite swaps <style> tags on HMR; keep the surface in sync.
    const styleObserver = useBrowser.getState().isDev
      ? new MutationObserver(() => {
          doc.head.querySelectorAll('style').forEach((n) => n.remove())
          document.head.querySelectorAll('style').forEach((n) => doc.head.appendChild(n.cloneNode(true)))
        })
      : null
    styleObserver?.observe(document.head, { childList: true, subtree: true, characterData: true })
    const stopTheme = mirrorTheme(doc)
    doc.body.style.margin = '0'
    doc.body.style.background = 'transparent'
    doc.body.style.overflow = 'hidden'
    const container = doc.createElement('div')
    container.style.height = '100%'
    doc.body.appendChild(container)
    setRoot(container)
    return () => {
      styleObserver?.disconnect()
      stopTheme()
    }
  }, [id, wanted])
  return root
}
