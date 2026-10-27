import type { ExtensionInfo } from '@shared/types'
import { Icon } from '../../components/Icon'
import { send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'

// Pieces the Extensions list and details share.

const LIST_URL = 'browser://extensions'

export function useExtensionsNav(): { open(id: string | null): void } {
  const tabId = useBrowser((s) => selectActiveTab(s)?.id)
  return {
    open: (id) => {
      if (tabId) send('tabs.navigate', tabId, id ? `${LIST_URL}?id=${id}` : LIST_URL)
    }
  }
}

export function ExtensionIcon({ ext, size }: { ext: ExtensionInfo; size: number }) {
  const radius = Math.round(size * 0.24)
  return ext.icon ? (
    <img
      src={ext.icon}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={`shrink-0 transition-[filter,opacity] duration-150 ${ext.enabled ? '' : 'opacity-45 grayscale'}`}
    />
  ) : (
    <span
      style={{ width: size, height: size, borderRadius: radius }}
      className="grid shrink-0 place-items-center bg-[var(--surface-3)] text-[var(--ink)]"
    >
      <Icon name="puzzle" size={Math.round(size * 0.55)} />
    </span>
  )
}
