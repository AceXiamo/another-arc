import { fallbackTitle } from '@shared/url'
import { Favicon } from '../../components/Favicon'
import { Icon } from '../../components/Icon'
import { useLocale } from '../../lib/i18n'
import { useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'

/** Floating preview that follows the pointer while dragging a tab or a folder. */
export function DragGhost() {
  const locale = useLocale()
  const kind = useUi((s) => s.drag?.item.kind)
  const id = useUi((s) => s.drag?.item.id)
  const x = useUi((s) => s.drag?.x ?? 0)
  const y = useUi((s) => s.drag?.y ?? 0)
  const tab = useBrowser((s) => (kind === 'tab' && id ? s.tabs[id] : undefined))
  const folder = useBrowser((s) => (kind === 'folder' && id ? s.folders[id] : undefined))
  if (!tab && !folder) return null
  return (
    <div
      className="pointer-events-none fixed left-0 top-0 z-50 flex h-[34px] max-w-[220px] items-center gap-2.5 rounded-[10px] bg-[var(--popover)] px-2.5 shadow-[var(--popover-shadow)]"
      style={{ transform: `translate(${x + 10}px, ${y - 16}px)` }}
    >
      {tab ? (
        <>
          <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} />
          <span className="truncate">{tab.title || tab.savedTitle || fallbackTitle(tab.url, locale)}</span>
        </>
      ) : (
        <>
          <Icon name={folder!.collapsed ? 'folder' : 'folderOpen'} size={16} className="text-[var(--ink)]" />
          <span className="truncate">{folder!.name}</span>
        </>
      )}
    </div>
  )
}
