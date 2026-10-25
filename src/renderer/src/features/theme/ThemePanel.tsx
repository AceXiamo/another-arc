import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { oklchToRgb, parseHex, rgbToOklch, toHex } from '@shared/color'
import { SPACE_COLORS } from '@shared/defaults'
import { LAYOUT } from '@shared/layout'
import { DEFAULT_SPACE_THEME, SPACE_APPEARANCES, THEME_LIMITS } from '@shared/theme'
import type { SpaceTheme } from '@shared/types'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { ColorPicker } from './ColorPicker'

/** Ring on the selected swatch (box-shadow based, so no inline box-shadow on swatches). */
const SELECTED = 'ring-2 ring-[var(--ink-strong)] ring-offset-2 ring-offset-[var(--popover)]'

/** Next gradient color: the previous one turned along the hue wheel (Arc's "analogous"). */
function nextStop(previous: string): string {
  const lch = rgbToOklch(parseHex(previous) ?? [0.5, 0.5, 0.5])
  return toHex(oklchToRgb({ l: lch.l, c: Math.max(lch.c, 0.08), h: (lch.h + 40) % 360 }))
}

export interface ThemePanelProps {
  color: string
  theme: SpaceTheme
  onColor: (color: string) => void
  onTheme: (patch: Partial<SpaceTheme>) => void
  /** Standalone ("Edit Theme…"): Cancel / Save here. Attached: Done (the space card saves). */
  standalone: boolean
  saveLabel: string
  /** Done: fold the attached panel (the draft stays in the space card). */
  onDone: () => void
  onCancel: () => void
  onSave: () => void
}

/**
 * The theme panel. It floats beside the sidebar, over the page card (the
 * shell is raised while the editor is open), so the whole sidebar stays
 * visible as the live preview. Rendered into <body> so no sidebar filter or
 * clip applies.
 */
export function ThemePanel(props: ThemePanelProps) {
  const { color, theme, onColor, onTheme, standalone } = props
  const t = useT()
  const panel = useRef<HTMLDivElement>(null)
  const stops = [color, ...theme.gradient]
  const [selected, setSelected] = useState(0)
  const index = Math.min(selected, stops.length - 1)

  // Keyboard focus starts in the panel; Escape still reaches the editor through React.
  useEffect(() => panel.current?.focus(), [])

  const setStop = (i: number, value: string) => {
    if (i === 0) onColor(value)
    else onTheme({ gradient: theme.gradient.map((c, j) => (j === i - 1 ? value : c)) })
  }
  const addStop = () => {
    if (theme.gradient.length >= THEME_LIMITS.gradientStops) return
    onTheme({ gradient: [...theme.gradient, nextStop(stops[stops.length - 1]!)] })
    setSelected(stops.length)
  }
  const removeStop = (i: number) => {
    onTheme({ gradient: theme.gradient.filter((_, j) => j !== i - 1) })
    setSelected(Math.max(0, i - 1))
  }

  const content = (
    <div className="pointer-events-none fixed inset-0 z-40">
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-label={t('theme.panel.title')}
        data-theme-panel
        className="anim-rise scroll-y pointer-events-auto absolute flex w-[264px] flex-col gap-3 rounded-[14px] bg-[var(--popover)] p-3 shadow-[var(--popover-shadow)] outline-none"
        style={{
          left: `calc(var(--sidebar-width) + ${LAYOUT.gutter}px)`,
          bottom: 48,
          maxHeight: `calc(100% - ${48 + LAYOUT.gutter * 2}px)`
        }}
      >
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[12px] font-semibold text-[var(--text-2)]">{t('theme.panel.title')}</span>
          <button
            title={t('theme.panel.resetHint')}
            onClick={() => onTheme({ ...DEFAULT_SPACE_THEME, gradient: [] })}
            className="-mr-1 h-6 rounded-[6px] px-2 text-[12px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            {t('theme.panel.reset')}
          </button>
        </div>

        <div className="flex items-center justify-between px-0.5">
          {SPACE_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setStop(index, c)}
              aria-label={t('theme.colors.preset', { color: c })}
              aria-pressed={stops[index] === c}
              className={`h-[18px] w-[18px] rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.12)] transition-transform duration-100 ${
                stops[index] === c ? SELECTED : 'hover:scale-110'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>

        <div className="flex flex-col gap-2 border-t border-[var(--popover-line)] pt-3">
          <div className="flex items-center gap-1.5" role="group" aria-label={t('theme.colors.label')}>
            {stops.map((c, i) => (
              <button
                key={i}
                data-stop={i}
                onClick={() => setSelected(i)}
                aria-label={t('theme.colors.stop', { n: i + 1 })}
                aria-pressed={i === index}
                className={`h-6 w-6 rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.15)] ${i === index ? SELECTED : ''}`}
                style={{ background: c }}
              />
            ))}
            {theme.gradient.length < THEME_LIMITS.gradientStops && (
              <button
                onClick={addStop}
                title={t('theme.colors.add')}
                aria-label={t('theme.colors.add')}
                data-add-stop
                className="grid h-6 w-6 place-items-center rounded-full text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)]"
              >
                <Icon name="plus" size={14} />
              </button>
            )}
            {index > 0 && (
              <button
                onClick={() => removeStop(index)}
                title={t('theme.colors.remove', { n: index + 1 })}
                aria-label={t('theme.colors.remove', { n: index + 1 })}
                className="ml-auto grid h-6 w-6 place-items-center rounded-[6px] text-[var(--ink)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)]"
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </div>
          <ColorPicker value={stops[index]!} onChange={(hex) => setStop(index, hex)} />
        </div>

        <div className="flex flex-col gap-1.5 border-t border-[var(--popover-line)] pt-3">
          {theme.gradient.length > 0 && (
            <SliderRow
              label={t('theme.angle.label')}
              value={theme.angle}
              max={359}
              display={`${theme.angle}°`}
              onChange={(angle) => onTheme({ angle })}
              fill={`linear-gradient(to right, ${stops.join(', ')})`}
            />
          )}
          <SliderRow
            label={t('theme.intensity.label')}
            value={theme.intensity}
            max={100}
            display={String(theme.intensity)}
            onChange={(intensity) => onTheme({ intensity })}
            fill={`linear-gradient(to right, color-mix(in oklch, ${color} 6%, var(--surface-3)), ${color})`}
          />
          <SliderRow
            label={t('theme.noise.label')}
            value={theme.noise}
            max={100}
            display={theme.noise === 0 ? t('theme.noise.off') : String(theme.noise)}
            onChange={(noise) => onTheme({ noise })}
          />
          <div className="pt-1.5">
            <div role="radiogroup" aria-label={t('theme.appearance.label')} className="flex rounded-[8px] bg-[var(--surface-3)] p-[2px]">
              {SPACE_APPEARANCES.map((a) => (
                <button
                  key={a}
                  role="radio"
                  aria-checked={theme.appearance === a}
                  data-appearance={a}
                  title={a === 'system' ? t('theme.appearance.systemHint') : undefined}
                  onClick={() => onTheme({ appearance: a })}
                  className={`h-[22px] min-w-0 flex-1 truncate rounded-[6px] px-1 text-[11.5px] ${
                    theme.appearance === a
                      ? 'bg-[var(--sb-active)] font-medium text-[var(--text)] shadow-[var(--active-shadow)]'
                      : 'text-[var(--text-2)] hover:text-[var(--text)]'
                  }`}
                >
                  {t(`theme.appearance.${a}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-1 border-t border-[var(--popover-line)] pt-2.5">
          {standalone ? (
            <>
              <button
                onClick={props.onCancel}
                className="h-7 rounded-[7px] px-2.5 text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={props.onSave}
                className="h-7 rounded-[7px] bg-[var(--accent-fill)] px-3 font-medium text-white hover:brightness-110 active:brightness-95"
              >
                {props.saveLabel}
              </button>
            </>
          ) : (
            <button
              onClick={props.onDone}
              className="h-7 rounded-[7px] px-3 font-medium text-[var(--text)] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--hover)]"
            >
              {t('theme.panel.done')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
  return createPortal(content, document.body)
}

function SliderRow({
  label,
  value,
  max,
  display,
  onChange,
  fill
}: {
  label: string
  value: number
  max: number
  display: string
  onChange: (value: number) => void
  fill?: string
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-[64px] shrink-0 truncate px-0.5 text-[12px] text-[var(--text-2)]">{label}</span>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        aria-valuetext={display}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider min-w-0 flex-1"
        style={fill ? { ['--fill' as string]: fill } : undefined}
      />
      <span className="w-[30px] shrink-0 text-right text-[11.5px] tabular-nums text-[var(--text-3)]">{display}</span>
    </label>
  )
}
