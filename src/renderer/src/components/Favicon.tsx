import { memo, useState } from 'react'
import { parseInternalUrl } from '@shared/url'
import { faviconSrc } from '../lib/rpc'
import { Icon, type IconName } from './Icon'

const INTERNAL_ICONS: Record<string, IconName> = {
  settings: 'settings',
  extensions: 'puzzle',
  history: 'history',
  downloads: 'download',
  passwords: 'lock'
}

/**
 * Hues for letter monograms, spaced around OKLCH and skipping the muddy
 * yellow-olive band. Every entry reads well at the fixed lightness below.
 */
const MONOGRAM_HUES = [22, 48, 72, 142, 168, 196, 228, 258, 288, 322] as const

/** FNV-1a: cheap and stable, so a host keeps its color across restarts. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function monogramFor(url: string, title: string): { letter: string; hue: number | null } {
  let host = ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') host = parsed.hostname.replace(/^www\./, '')
  } catch {
    // not a URL
  }
  // Punycode hosts start with "xn--"; the title has the readable name.
  const source = host && !host.startsWith('xn--') ? host : title.trim()
  const letter = (Array.from(source)[0] ?? '').toUpperCase()
  if (!letter) return { letter: '•', hue: null }
  return { letter, hue: MONOGRAM_HUES[hash(host || source) % MONOGRAM_HUES.length]! }
}

/**
 * Cached favicon with a letter fallback; never hits the network from the shell.
 * `framed` sets the icon on a tile `size` wide (list rows); the letter
 * fallback then fills the whole tile.
 */
export const Favicon = memo(function Favicon({
  url,
  favicon,
  title,
  size = 16,
  framed = false
}: {
  url: string
  favicon: string | null
  title: string
  size?: number
  framed?: boolean
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const internal = parseInternalUrl(url)
  if (internal) {
    return (
      <span className="grid shrink-0 place-items-center text-[var(--ink)]" style={{ width: size, height: size }}>
        <Icon name={INTERNAL_ICONS[internal] ?? 'globe'} size={size} strokeWidth={1.6} />
      </span>
    )
  }
  if (!favicon || failed === favicon) return <Monogram url={url} title={title} size={size} framed={framed} />
  const inner = framed ? Math.round(size * 0.58) : size
  const img = (
    <img
      src={faviconSrc(favicon)}
      width={inner}
      height={inner}
      className="relative shrink-0 rounded-[3px] object-contain"
      decoding="async"
      draggable={false}
      alt=""
      onLoad={() => setLoaded(favicon)}
      onError={() => setFailed(favicon)}
    />
  )
  if (!framed) return img
  return (
    <span
      className="relative grid shrink-0 place-items-center bg-[var(--icon-tile)] shadow-[var(--card-shadow)]"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.27) }}
    >
      {/* An icon fetched on first display can take a moment: the letter
          stands in, but only if the wait is noticeable. */}
      {loaded !== favicon && (
        <span className="absolute inset-0 [animation:fade-in_0.2s_ease-out_0.3s_backwards]">
          <Monogram url={url} title={title} size={size} framed />
        </span>
      )}
      {img}
    </span>
  )
})

/**
 * Letter monogram tinted from the host. Plain CSS (no canvas): the tile mixes
 * toward --surface and the letter toward --text, so the pair stays readable
 * in light and dark themes.
 */
function Monogram({ url, title, size, framed }: { url: string; title: string; size: number; framed: boolean }) {
  const { letter, hue } = monogramFor(url, title)
  return (
    <span
      aria-hidden
      className={`grid shrink-0 select-none place-items-center font-semibold leading-none ${
        hue === null
          ? 'bg-[var(--press)] text-[var(--text-2)]'
          : 'bg-[color-mix(in_oklab,oklch(0.64_0.15_var(--h))_38%,var(--surface))] text-[color-mix(in_oklab,oklch(0.6_0.15_var(--h))_68%,var(--text))]'
      }`}
      style={
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.27),
          fontSize: Math.round(size * (framed ? 0.5 : 0.6)),
          '--h': hue ?? 0
        } as React.CSSProperties
      }
    >
      {letter}
    </span>
  )
}
