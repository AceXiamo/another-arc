import { useBrowser } from '../stores/browser'

const media = window.matchMedia('(prefers-color-scheme: dark)')

/**
 * Theme and layout variables live on <html> and are updated outside React:
 * switching spaces or resizing the sidebar never re-renders components.
 */
export function startTheme(): void {
  const root = document.documentElement
  const apply = () => {
    const s = useBrowser.getState()
    const space = s.spaces[s.window.activeSpaceId]
    const dark = s.settings.theme === 'dark' || (s.settings.theme === 'system' && media.matches)
    root.dataset.theme = dark ? 'dark' : 'light'
    root.lang = s.settings.language
    if (space) root.style.setProperty('--space', space.color)
    root.style.setProperty('--sidebar-width', `${s.window.sidebarWidth}px`)
  }
  apply()
  media.addEventListener('change', apply)
  useBrowser.subscribe((s, prev) => {
    if (
      s.window.activeSpaceId !== prev.window.activeSpaceId ||
      s.window.sidebarWidth !== prev.window.sidebarWidth ||
      s.settings.theme !== prev.settings.theme ||
      s.settings.language !== prev.settings.language ||
      s.spaces !== prev.spaces
    ) {
      apply()
    }
  })
}

/** Live sidebar width while dragging the resizer (main is told separately). */
export function setSidebarWidthVar(width: number): void {
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
}

/** Copy theme state onto another document (floating surfaces). */
export function mirrorTheme(target: Document): () => void {
  const sync = () => {
    target.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'light'
    target.documentElement.style.cssText = document.documentElement.style.cssText
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
  return () => observer.disconnect()
}
