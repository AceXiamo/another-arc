import { memo, useState } from 'react'
import { parseInternalUrl } from '@shared/url'
import { faviconSrc } from '../lib/rpc'
import { Icon, type IconName } from './Icon'

const INTERNAL_ICONS: Record<string, IconName> = {
  settings: 'settings',
  extensions: 'puzzle',
  history: 'history',
  downloads: 'download'
}

function letterFor(url: string, title: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    if (host) return host[0]!.toUpperCase()
  } catch {
    // not a URL
  }
  return (title.trim()[0] ?? '•').toUpperCase()
}

/** Cached favicon with a letter fallback; never hits the network from the shell. */
export const Favicon = memo(function Favicon({
  url,
  favicon,
  title,
  size = 16
}: {
  url: string
  favicon: string | null
  title: string
  size?: number
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const internal = parseInternalUrl(url)
  if (internal) {
    return (
      <span className="grid shrink-0 place-items-center text-[var(--ink)]" style={{ width: size, height: size }}>
        <Icon name={INTERNAL_ICONS[internal] ?? 'globe'} size={size} strokeWidth={1.6} />
      </span>
    )
  }
  if (!favicon || failed === favicon) {
    return (
      <span
        className="grid shrink-0 place-items-center rounded-[4px] bg-[var(--press)] font-semibold leading-none text-[var(--text-2)]"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.58) }}
      >
        {letterFor(url, title)}
      </span>
    )
  }
  return (
    <img
      src={faviconSrc(favicon)}
      width={size}
      height={size}
      className="shrink-0 rounded-[3px] object-contain"
      decoding="async"
      draggable={false}
      alt=""
      onError={() => setFailed(favicon)}
    />
  )
})
