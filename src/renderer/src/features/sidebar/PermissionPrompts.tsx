import { useState } from 'react'
import type { Translate } from '@shared/i18n'
import type { PermissionPrompt } from '@shared/types'
import { displayHost } from '@shared/url'
import { Icon, type IconName } from '../../components/Icon'
import { useLocale, useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'

function describe(p: PermissionPrompt, t: Translate): string {
  switch (p.permission) {
    case 'media': {
      const cam = p.details.includes('camera')
      const mic = p.details.includes('microphone')
      return t(
        cam && mic
          ? 'sidebar.permission.cameraAndMicrophone'
          : cam
            ? 'sidebar.permission.camera'
            : 'sidebar.permission.microphone'
      )
    }
    case 'geolocation':
      return t('sidebar.permission.geolocation')
    case 'notifications':
      return t('sidebar.permission.notifications')
    case 'clipboard-read':
      return t('sidebar.permission.clipboardRead')
    case 'midiSysex':
      return t('sidebar.permission.midiSysex')
    case 'idle-detection':
      return t('sidebar.permission.idleDetection')
    case 'window-management':
      return t('sidebar.permission.windowManagement')
    case 'storage-access':
    case 'top-level-storage-access':
      return t('sidebar.permission.storageAccess')
    case 'fileSystem':
      return t('sidebar.permission.fileSystem')
    case 'openExternal': {
      const target = p.details[0] ?? ''
      const scheme = target.split(':')[0] ?? ''
      return t('sidebar.permission.openExternal', { scheme })
    }
    default:
      return t('sidebar.permission.other', { permission: p.permission })
  }
}

function iconFor(p: PermissionPrompt): IconName {
  switch (p.permission) {
    case 'media':
      return p.details.includes('camera') ? 'camera' : 'mic'
    case 'geolocation':
      return 'location'
    case 'notifications':
      return 'bell'
    case 'clipboard-read':
      return 'clipboard'
    case 'fileSystem':
      return 'folder'
    case 'openExternal':
      return 'external'
    default:
      return 'shield'
  }
}

function PromptCard({ prompt }: { prompt: PermissionPrompt }) {
  const t = useT()
  const locale = useLocale()
  const [remember, setRemember] = useState(true)
  return (
    <div className="anim-pop flex flex-col gap-2.5 rounded-[12px] bg-[var(--popover)] p-3 shadow-[var(--popover-shadow)]">
      <div className="flex gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-[var(--accent-soft)] text-[var(--accent)]">
          <Icon name={iconFor(prompt)} size={15} />
        </span>
        <div className="min-w-0 flex-1 leading-snug">
          <div className="truncate font-semibold">{displayHost(prompt.origin, locale)}</div>
          <div className="text-[12px] text-[var(--text-2)]">{describe(prompt, t)}</div>
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
        <input type="checkbox" className="m-0" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {t('sidebar.permission.remember')}
      </label>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => send('permissions.respond', prompt.id, 'deny', remember)}
          className="h-7 rounded-[7px] bg-[var(--hover)] font-medium text-[var(--text-2)] hover:bg-[var(--press)] hover:text-[var(--text)]"
        >
          {t('common.deny')}
        </button>
        <button
          onClick={() => send('permissions.respond', prompt.id, 'allow', remember)}
          className="h-7 rounded-[7px] bg-[var(--accent-fill)] font-medium text-white hover:brightness-110 active:brightness-95"
        >
          {t('common.allow')}
        </button>
      </div>
    </div>
  )
}

export function PermissionPrompts() {
  const prompts = useBrowser((s) => s.permissionPrompts)
  const activeId = useBrowser((s) => selectActiveTab(s)?.id ?? null)
  const visible = prompts.filter((p) => p.tabId === null || p.tabId === activeId)
  if (visible.length === 0) return null
  return (
    <>
      {visible.map((p) => (
        <PromptCard key={p.id} prompt={p} />
      ))}
    </>
  )
}
