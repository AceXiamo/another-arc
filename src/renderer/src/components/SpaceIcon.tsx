import { memo } from 'react'
import { isSpaceIconId } from '@shared/defaults'

/**
 * Space glyph. The artwork is an alpha mask painted with `currentColor`, so
 * it follows text color, theme and selection state without extra assets.
 * Callers tint it with the translucent --ink tokens (or the space accent),
 * never with full-strength text color.
 * Unknown values (older data) render as text.
 */
export const SpaceIcon = memo(function SpaceIcon({
  icon,
  size = 18,
  className = ''
}: {
  icon: string
  size?: number
  className?: string
}) {
  if (isSpaceIconId(icon)) {
    const mask = `url(./space-icons/${icon}.png) center / contain no-repeat`
    return (
      <span
        aria-hidden
        className={`inline-block shrink-0 bg-current ${className}`}
        style={{ width: size, height: size, mask, WebkitMask: mask }}
      />
    )
  }
  return (
    <span className={`grid shrink-0 place-items-center leading-none ${className}`} style={{ width: size, height: size, fontSize: size * 0.8 }}>
      {icon}
    </span>
  )
})
