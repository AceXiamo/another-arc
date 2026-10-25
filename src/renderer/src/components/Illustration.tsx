import { memo } from 'react'
import type { FileKind } from '@shared/file-kind'

// Generated artwork stored as two-layer alpha-mask sprites: the left half of
// each PNG is the soft fill, the right half is the line art. Both layers are
// painted with theme tokens, so a single file follows light/dark and the
// space color. Files are 2x the CSS sizes below.

type Layers = { fill: string; line: string }

/** Line color: ink with a hint of the tint, opaque against the page surface. */
const inkWith = (tint: string, amount: number) =>
  `color-mix(in oklab, ${tint} ${amount}%, color-mix(in oklab, var(--text) 62%, var(--surface)))`

const TONES = {
  space: { fill: 'var(--accent-soft)', line: inkWith('var(--accent)', 34) },
  danger: { fill: 'var(--danger-soft)', line: inkWith('var(--danger)', 58) }
} satisfies Record<string, Layers>

const maskLayer = (src: string, half: 'fill' | 'line', color: string): React.CSSProperties => {
  const mask = `url(${src}) ${half === 'fill' ? '0' : '100%'} 0 / 200% 100% no-repeat`
  return { background: color, mask, WebkitMask: mask }
}

function Layered({ src, width, height, layers, className = '', children }: {
  src: string
  width: number
  height: number
  layers: Layers
  className?: string
  children?: React.ReactNode
}) {
  return (
    <span
      aria-hidden
      className={`relative block shrink-0 ${className}`}
      style={{ width, height, '--art-fill': layers.fill, '--art-line': layers.line } as React.CSSProperties}
    >
      <span className="absolute inset-0" style={maskLayer(src, 'fill', 'var(--art-fill)')} />
      <span className="absolute inset-0" style={maskLayer(src, 'line', 'var(--art-line)')} />
      {children}
    </span>
  )
}

/** CSS size of each spot illustration. */
const ART = {
  'no-tabs': [141, 104],
  offline: [160, 45],
  crash: [128, 100],
  certificate: [104, 107],
  history: [123, 102],
  'no-results': [105, 112],
  downloads: [123, 100],
  extensions: [124, 105]
} as const satisfies Record<string, readonly [number, number]>

export type IllustrationName = keyof typeof ART

/**
 * Calm spot illustration for empty and error states. `children` are laid
 * over the art (positioned absolutely by the caller) and can use
 * `var(--art-line)` / `var(--art-fill)`.
 */
export const Illustration = memo(function Illustration({
  name,
  tone = 'space',
  className,
  children
}: {
  name: IllustrationName
  tone?: keyof typeof TONES
  className?: string
  children?: React.ReactNode
}) {
  const [width, height] = ART[name]
  return (
    <Layered src={`./illustrations/${name}.png`} width={width} height={height} layers={TONES[tone]} className={className}>
      {children}
    </Layered>
  )
})

/** OKLCH hue and chroma per file type; generic files stay neutral. */
const FILE_TINTS: Record<FileKind, [hue: number, chroma: number]> = {
  archive: [72, 0.14],
  pdf: [25, 0.17],
  image: [195, 0.12],
  video: [300, 0.15],
  audio: [345, 0.15],
  disk: [235, 0.07],
  document: [255, 0.15],
  spreadsheet: [150, 0.14],
  code: [280, 0.1],
  generic: [0, 0]
}

/**
 * Document icon for a file type (30x38). The fill mixes with --surface-2,
 * the card color it sits on; the line mixes toward --text, so it darkens in
 * light mode and lightens in dark mode.
 */
export const FileIcon = memo(function FileIcon({ kind, className }: { kind: FileKind; className?: string }) {
  const [h, c] = FILE_TINTS[kind]
  const tint = `oklch(0.64 ${c} ${h})`
  return (
    <Layered
      src={`./file-icons/${kind}.png`}
      width={30}
      height={38}
      className={className}
      layers={{
        // A neutral fill reads heavier than a tinted one at the same mix.
        fill: `color-mix(in oklab, ${tint} ${c > 0 ? 24 : 15}%, var(--surface-2))`,
        line: `color-mix(in oklab, ${tint} 72%, var(--text))`
      }}
    />
  )
})
