import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SPACE_COLORS, SPACE_ICONS } from '@shared/defaults'
import { sanitizeSpaceTheme } from '@shared/theme'
import type { SpaceTheme } from '@shared/types'
import { SpaceIcon } from '../../components/SpaceIcon'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { previewChrome } from '../../lib/theme'
import { optimisticSpace, useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'
import { ThemePanel } from '../theme/ThemePanel'

/** Resolves once the shell state shows `spaceId` as the active space (or after a short wait). */
function whenActive(spaceId: string): Promise<void> {
  return new Promise((resolve) => {
    if (useBrowser.getState().window.activeSpaceId === spaceId) return resolve()
    const timer = setTimeout(done, 500)
    const stop = useBrowser.subscribe((s) => s.window.activeSpaceId === spaceId && done())
    function done() {
      clearTimeout(timer)
      stop()
      resolve()
    }
  })
}

/**
 * Space editor: name, icon and colors in a card above the space bar, plus the
 * theme panel (gradient, intensity, grain, appearance) floating beside the
 * sidebar. Every change previews live on the chrome; Cancel / Escape restores
 * the saved look, Save persists it.
 */
export function SpaceEditor({ target }: { target: string }) {
  const t = useT()
  const existing = useBrowser((s) => (target === 'new' ? undefined : s.spaces[target]))
  const count = useBrowser((s) => s.spaceOrder.length)
  const panel = useUi((s) => s.themePanel)
  const [name, setName] = useState(existing?.name ?? '')
  const [icon, setIcon] = useState<string>(existing?.icon ?? SPACE_ICONS[count % SPACE_ICONS.length]!.id)
  const [color, setColor] = useState(existing?.color ?? SPACE_COLORS[count % SPACE_COLORS.length]!)
  const [theme, setTheme] = useState<SpaceTheme>(() => sanitizeSpaceTheme(existing?.theme ?? null))
  const nameRef = useRef<HTMLInputElement>(null)
  const themeButton = useRef<HTMLButtonElement>(null)
  const saving = useRef(false)
  const close = () => {
    // A peeking sidebar stayed open for the editor; let it go unless the pointer is on it.
    const peek = useUi.getState().peek && document.querySelector('aside')?.matches(':hover') === true
    useUi.setState({ spaceEditor: null, themePanel: null, peek })
  }
  /** Fold the attached panel; focus goes back to the card so Escape still reaches it. */
  const closePanel = () => {
    useUi.setState({ themePanel: null })
    themeButton.current?.focus()
  }

  useEffect(() => {
    if (useUi.getState().themePanel === 'standalone') return
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  // Live preview on the chrome; unmounting goes back to the active space's saved look.
  useEffect(() => previewChrome({ color, theme }), [color, theme])
  useEffect(() => () => previewChrome(null), [])

  const save = async () => {
    if (saving.current) return
    saving.current = true
    const input = { name: name.trim() || t('space.untitled'), icon, color, theme }
    if (existing) {
      optimisticSpace(existing.id, input)
      send('spaces.update', existing.id, input)
    } else {
      try {
        await whenActive(await rpc('spaces.create', input))
      } catch (error) {
        console.error('[rpc] spaces.create', error)
        saving.current = false
        return
      }
    }
    close()
  }

  /** Escape, or a click on the page area: fold the attached panel first, else cancel. */
  const dismiss = () => {
    if (useUi.getState().themePanel === 'attached') closePanel()
    else close()
  }

  const standalone = panel === 'standalone'
  const presetColor = (SPACE_COLORS as readonly string[]).includes(color)
  const customLook = theme.gradient.length > 0 || !presetColor
  const swatchRing = 'ring-2 ring-[var(--ink-strong)] ring-offset-2 ring-offset-[var(--popover)]'

  return (
    <div
      className="contents"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          dismiss()
        }
        // Enter saves, except on a focused button (it presses the button).
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && !(e.target instanceof HTMLButtonElement)) void save()
      }}
    >
      {!standalone && (
        <div
          data-space-editor
          className="anim-rise no-drag absolute inset-x-2 bottom-12 z-20 flex flex-col gap-3 rounded-[14px] bg-[var(--popover)] p-3 shadow-[var(--popover-shadow)]"
        >
          <div className="px-0.5 text-[12px] font-semibold text-[var(--text-2)]">
            {existing ? t('sidebar.spaceEditor.titleEdit') : t('sidebar.spaceEditor.titleNew')}
          </div>
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
          {/* Ten swatches: one row, or two rows of five in a narrow sidebar. */}
          <div className="@container px-0.5">
            <div className="grid grid-cols-5 justify-items-center gap-y-2 @min-[212px]:grid-cols-10">
              {SPACE_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={c}
                  aria-pressed={color === c && !customLook}
                  className={`h-[18px] w-[18px] rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12)] ${color === c && !customLook ? swatchRing : 'hover:scale-110'} transition-transform duration-100`}
                  style={{ background: c }}
                />
              ))}
              {/* Opens the theme panel; shows the custom look once there is one. */}
              <button
                ref={themeButton}
                data-theme-open
                onClick={() => useUi.setState({ themePanel: panel ? null : 'attached' })}
                title={t('theme.panel.open')}
                aria-label={t('theme.panel.open')}
                aria-expanded={panel !== null}
                className={`h-[18px] w-[18px] rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12)] ${customLook || panel ? swatchRing : 'hover:scale-110'} transition-transform duration-100`}
                style={{
                  background: customLook
                    ? `linear-gradient(135deg, ${[color, ...theme.gradient, ...(theme.gradient.length ? [] : [color])].join(', ')})`
                    : 'conic-gradient(from 210deg, #ef4444, #eab308, #22c55e, #14b8a6, #3b82f6, #7c6cf2, #ec4899, #ef4444)'
                }}
              />
            </div>
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
      )}
      {/* The shell is raised over the page while editing; the page area dismisses like Escape. */}
      {createPortal(
        <div
          data-editor-outside
          className="fixed bottom-0 right-0 top-0 z-[25]"
          style={{ left: 'var(--sidebar-width)' }}
          onPointerDown={dismiss}
        />,
        document.body
      )}
      {panel && (
        <ThemePanel
          color={color}
          theme={theme}
          onColor={setColor}
          onTheme={(patch) => setTheme((prev) => sanitizeSpaceTheme({ ...prev, ...patch }, prev))}
          standalone={standalone}
          saveLabel={existing ? t('common.save') : t('sidebar.spaceEditor.create')}
          onDone={closePanel}
          onCancel={close}
          onSave={() => void save()}
        />
      )}
    </div>
  )
}
