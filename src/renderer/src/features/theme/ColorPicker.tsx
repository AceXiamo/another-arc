import { useEffect, useRef, useState } from 'react'
import { hsvToRgb, normalizeHexInput, parseHex, rgbToHsv, toHex, type Hsv } from '@shared/color'
import { useT } from '../../lib/i18n'

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/**
 * Compact HSV picker: a saturation × brightness field for the current hue, a
 * hue slider and a hex field. HSV is kept locally while dragging so the hue
 * does not jump when a color passes through gray.
 */
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const t = useT()
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(parseHex(value) ?? [0, 0, 0]))
  const [hexText, setHexText] = useState(value.slice(1))
  const area = useRef<HTMLDivElement>(null)
  const lastEmitted = useRef(value)

  // Follow outside changes (another stop selected, a preset clicked).
  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    const rgb = parseHex(value)
    if (!rgb) return
    const next = rgbToHsv(rgb)
    setHsv((prev) => ({ h: next.s === 0 || next.v === 0 ? prev.h : next.h, s: next.s, v: next.v }))
    setHexText(value.slice(1))
  }, [value])

  const emit = (next: Hsv) => {
    setHsv(next)
    const hex = toHex(hsvToRgb(next))
    setHexText(hex.slice(1))
    if (hex !== lastEmitted.current) {
      lastEmitted.current = hex
      onChange(hex)
    }
  }

  const pick = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect()
    emit({ h: hsv.h, s: clamp01((e.clientX - r.left) / r.width), v: clamp01(1 - (e.clientY - r.top) / r.height) })
  }

  const onAreaKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step]
    }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    emit({ h: hsv.h, s: clamp01(hsv.s + d[0]), v: clamp01(hsv.v + d[1]) })
  }

  const commitHex = () => {
    const hex = normalizeHexInput(hexText)
    if (!hex) {
      setHexText(value.slice(1))
      return
    }
    const rgb = parseHex(hex)!
    const next = rgbToHsv(rgb)
    emit({ h: next.s === 0 || next.v === 0 ? hsv.h : next.h, s: next.s, v: next.v })
  }

  const current = toHex(hsvToRgb(hsv))
  return (
    <div className="flex flex-col gap-2">
      <div
        ref={area}
        role="slider"
        tabIndex={0}
        aria-label={t('theme.picker.area')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`}
        data-color-area
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          e.currentTarget.focus()
          pick(e)
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e)
        }}
        onKeyDown={onAreaKey}
        className="relative h-[104px] touch-none rounded-[8px] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
        style={{
          background: `linear-gradient(to top, #000, rgb(0 0 0 / 0)), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
          boxShadow: 'inset 0 0 0 0.5px rgb(0 0 0 / 0.12)'
        }}
      >
        <span
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: current,
            boxShadow: '0 0 0 2px #fff, 0 0 0 2.5px rgb(0 0 0 / 0.2), 0 1px 4px rgb(0 0 0 / 0.3)'
          }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={359}
        step={1}
        value={Math.round(hsv.h)}
        aria-label={t('theme.picker.hue')}
        onChange={(e) => emit({ ...hsv, h: Number(e.target.value), s: hsv.s || 0.6, v: hsv.v || 0.8 })}
        className="slider w-full"
        style={{
          ['--fill' as string]:
            'linear-gradient(to right, #f00 0%, #ff0 16.6%, #0f0 33.3%, #0ff 50%, #00f 66.6%, #f0f 83.3%, #f00 100%)'
        }}
      />
      <label className="field flex items-center gap-1.5 px-1.5 focus-within:shadow-[inset_0_0_0_1px_var(--focus),0_0_0_3px_color-mix(in_oklch,var(--space)_18%,transparent)]">
        <span
          aria-hidden
          className="h-[18px] w-[18px] shrink-0 rounded-[5px]"
          style={{ background: current, boxShadow: 'inset 0 0 0 0.5px rgb(0 0 0 / 0.15)' }}
        />
        <span aria-hidden className="text-[var(--text-3)]">
          #
        </span>
        <input
          value={hexText}
          maxLength={7}
          spellCheck={false}
          aria-label={t('theme.picker.hex')}
          onChange={(e) => {
            setHexText(e.target.value.replace(/^#/, ''))
            const hex = normalizeHexInput(e.target.value)
            if (hex && hex.length === 7 && e.target.value.replace(/^#/, '').length === 6) {
              const next = rgbToHsv(parseHex(hex)!)
              setHsv((prev) => ({ h: next.s === 0 || next.v === 0 ? prev.h : next.h, s: next.s, v: next.v }))
              lastEmitted.current = hex
              onChange(hex)
            }
          }}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              // Enter commits the field; it does not save the editor.
              e.stopPropagation()
              commitHex()
            }
          }}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] uppercase tabular-nums outline-none"
        />
      </label>
    </div>
  )
}
