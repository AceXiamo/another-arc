import { useEffect, useRef, useState } from 'react'
import { SPACE_COLORS, SPACE_ICONS } from '@shared/defaults'
import { SpaceIcon } from '../../components/SpaceIcon'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'

export function SpaceEditor({ target }: { target: string }) {
  const t = useT()
  const existing = useBrowser((s) => (target === 'new' ? undefined : s.spaces[target]))
  const count = useBrowser((s) => s.spaceOrder.length)
  const [name, setName] = useState(existing?.name ?? '')
  const [icon, setIcon] = useState<string>(existing?.icon ?? SPACE_ICONS[count % SPACE_ICONS.length]!.id)
  const [color, setColor] = useState(existing?.color ?? SPACE_COLORS[count % SPACE_COLORS.length]!)
  const nameRef = useRef<HTMLInputElement>(null)
  const close = () => useUi.setState({ spaceEditor: null })

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // Live preview of the color while editing.
  useEffect(() => {
    document.documentElement.style.setProperty('--space', color)
    return () => {
      const s = useBrowser.getState()
      const active = s.spaces[s.window.activeSpaceId]
      if (active) document.documentElement.style.setProperty('--space', active.color)
    }
  }, [color])

  const save = async () => {
    const input = { name: name.trim() || t('space.untitled'), icon, color }
    if (existing) send('spaces.update', existing.id, input)
    else await rpc('spaces.create', input)
    close()
  }

  return (
    <div
      className="anim-rise no-drag absolute inset-x-2 bottom-12 z-20 flex flex-col gap-3 rounded-[14px] bg-[var(--popover)] p-3 shadow-[var(--popover-shadow)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
      }}
    >
      <div className="px-0.5 text-[12px] font-semibold text-[var(--text-2)]">{existing ? t('sidebar.spaceEditor.titleEdit') : t('sidebar.spaceEditor.titleNew')}</div>
      <div className="flex items-center gap-2">
        <span
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[8px]"
          style={{ color, background: `color-mix(in oklch, ${color} 16%, transparent)` }}
        >
          <SpaceIcon icon={icon} size={16} />
        </span>
        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('sidebar.spaceEditor.namePlaceholder')}
          maxLength={40}
          className="field min-w-0 flex-1"
        />
      </div>
      <div className="grid grid-cols-8 gap-0.5">
        {SPACE_ICONS.map((i) => (
          <button
            key={i.id}
            title={t(i.label)}
            aria-label={t(i.label)}
            aria-pressed={icon === i.id}
            onClick={() => setIcon(i.id)}
            className={`grid aspect-square place-items-center rounded-[7px] ${
              icon === i.id ? '' : 'text-[var(--ink)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)]'
            }`}
            style={icon === i.id ? { color, background: `color-mix(in oklch, ${color} 16%, transparent)` } : undefined}
          >
            <SpaceIcon icon={i.id} size={15} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-0.5">
        {SPACE_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            aria-label={c}
            aria-pressed={color === c}
            className={`h-[18px] w-[18px] rounded-full ${
              color === c ? 'ring-2 ring-[var(--ink-strong)] ring-offset-2 ring-offset-[var(--popover)]' : 'hover:scale-110'
            } transition-transform duration-100`}
            style={{ background: c, boxShadow: 'inset 0 0 0 0.5px rgb(0 0 0 / 0.12)' }}
          />
        ))}
      </div>
      <div className="flex items-center justify-end gap-1 border-t border-[var(--popover-line)] pt-2.5">
        {existing && count > 1 && (
          <button
            onClick={() => {
              send('spaces.delete', existing.id)
              close()
            }}
            className="mr-auto h-7 rounded-[7px] px-2.5 text-[var(--danger)] hover:bg-[var(--danger-soft)]"
          >
            {t('common.delete')}
          </button>
        )}
        <button onClick={close} className="h-7 rounded-[7px] px-2.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
          {t('common.cancel')}
        </button>
        <button
          onClick={() => void save()}
          className="h-7 rounded-[7px] bg-[var(--accent-fill)] px-3 font-medium text-white hover:brightness-110 active:brightness-95"
        >
          {existing ? t('common.save') : t('sidebar.spaceEditor.create')}
        </button>
      </div>
    </div>
  )
}
