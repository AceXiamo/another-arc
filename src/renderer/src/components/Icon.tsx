import { memo } from 'react'

// Hand-picked line icons (24x24 grid, stroke = currentColor). Inline SVG keeps
// the shell free of icon fonts and network requests. Callers color icons with
// the translucent --ink tokens, never with full-strength text color.
const PATHS = {
  back: 'M14.5 17.5L9 12l5.5-5.5',
  forward: 'M9.5 17.5L15 12 9.5 6.5',
  reload: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  stop: 'M7 7l10 10M17 7L7 17',
  close: 'M7.5 7.5l9 9M16.5 7.5l-9 9',
  plus: 'M12 5.5v13M5.5 12h13',
  sidebar:
    'M6.5 4.5h11a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17V7a2.5 2.5 0 0 1 2.5-2.5zM9.5 4.5v15',
  lock: 'M8 10.5V8a4 4 0 0 1 8 0v2.5M7 10.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 18v-6A1.5 1.5 0 0 1 7 10.5z',
  warning:
    'M10.3 5.2L3.6 17a2 2 0 0 0 1.7 3h13.4a2 2 0 0 0 1.7-3L13.7 5.2a2 2 0 0 0-3.4 0zM12 10v3.5M12 16.8v.01',
  search: 'M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6zM19.5 19.5l-3.9-3.9',
  globe:
    'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z',
  puzzle:
    'M10 4.5a2 2 0 1 1 4 0V6h3.5a.5.5 0 0 1 .5.5V10h-1.5a2 2 0 1 0 0 4H18v3.5a.5.5 0 0 1-.5.5H14v-1.5a2 2 0 1 0-4 0V18H6.5a.5.5 0 0 1-.5-.5V14h1.5a2 2 0 1 0 0-4H6V6.5a.5.5 0 0 1 .5-.5H10z',
  download: 'M12 4.5v10.5M7.5 11l4.5 4.5 4.5-4.5M5.5 19.5h13',
  settings:
    'M12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM19.2 13.2a7.3 7.3 0 0 0 0-2.4l1.9-1.5-1.9-3.3-2.3.9a7.4 7.4 0 0 0-2-1.2L14.5 3.3h-3.8l-.4 2.4a7.4 7.4 0 0 0-2 1.2L6 6l-1.9 3.3 1.9 1.5a7.3 7.3 0 0 0 0 2.4l-1.9 1.5L6 18l2.3-.9a7.4 7.4 0 0 0 2 1.2l.4 2.4h3.8l.4-2.4a7.4 7.4 0 0 0 2-1.2l2.3.9 1.9-3.3z',
  history: 'M12 8v4.2l2.8 1.8M4 12a8 8 0 1 0 2.3-5.6M4 4.5v3.5h3.5',
  pin: 'M9 4.5h6l-1 5.5 3 3v1H7v-1l3-3zM12 14v5.5',
  volume: 'M5 10v4h3l4 3.5v-11L8 10zM15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.5 7.5 0 0 1 0 10.4',
  muted: 'M5 10v4h3l4 3.5v-11L8 10zM15.5 10l4 4M19.5 10l-4 4',
  up: 'M6.5 14.5L12 9l5.5 5.5',
  down: 'M6.5 9.5L12 15l5.5-5.5',
  copy: 'M10 9h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 20h-8a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 10 9zM15.5 9V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5',
  trash: 'M5 7h14M10 11v5.5M14 11v5.5M6.5 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7M9.5 7V5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v2',
  folder:
    'M4 7a1.5 1.5 0 0 1 1.5-1.5h3.8l2 2h7.2A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z',
  // Same back panel as `folder`, with the front flap tipped open.
  folderOpen:
    'M4 17.5V7a1.5 1.5 0 0 1 1.5-1.5h3.8l2 2h5.7A1.5 1.5 0 0 1 18.5 9v1.5M4 17.5l2.3-6a1.5 1.5 0 0 1 1.4-1H20a1 1 0 0 1 .95 1.3l-2.1 6.2A1.5 1.5 0 0 1 17.4 19H5.5A1.5 1.5 0 0 1 4 17.5z',
  file: 'M13.5 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V8zM13.5 3.5V8H18',
  check: 'M5.5 12.5l4.5 4.5 8.5-9.5',
  crash:
    'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM8.6 9.4l2 2M10.6 9.4l-2 2M13.4 9.4l2 2M15.4 9.4l-2 2M9 16c1.8-1.3 4.2-1.3 6 0',
  offline:
    'M3.5 3.5l17 17M8.8 16.2a4.5 4.5 0 0 1 6 0M5.6 12.9a9 9 0 0 1 3.6-2.1M18.4 12.9a9 9 0 0 0-2.7-1.8M2.5 9.5a13.5 13.5 0 0 1 4.3-2.8M21.5 9.5a13.5 13.5 0 0 0-9.2-3.5M12 19.5v.01',
  pause: 'M9 6v12M15 6v12',
  play: 'M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2a.8.8 0 0 0-1.2.7z',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  bolt: 'M13 3.5L5.5 13.5h6l-1 7 7.5-10h-6z',
  external: 'M14 4.5h5.5V10M19.5 4.5L11 13M17.5 13.5v5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h5',
  chevron: 'M7 10l5 5 5-5',
  shield: 'M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3z',
  camera:
    'M4.5 8.5A1.5 1.5 0 0 1 6 7h2l1.5-2h5L16 7h2a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18 19H6a1.5 1.5 0 0 1-1.5-1.5zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  mic: 'M12 3.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 1 12 3.5zM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5v3.5',
  location: 'M12 20.5s6-5.4 6-10.5a6 6 0 0 0-12 0c0 5.1 6 10.5 6 10.5zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5zM10 20h4',
  clipboard:
    'M9 5H7.5A1.5 1.5 0 0 0 6 6.5v12A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 16.5 5H15M9.5 3.5h5a.5.5 0 0 1 .5.5v1.5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z',
  enter: 'M19 5.5v6a2 2 0 0 1-2 2H6M9.5 10l-3.5 3.5L9.5 17'
} as const

export type IconName = keyof typeof PATHS

export const Icon = memo(function Icon({
  name,
  size = 16,
  strokeWidth = 1.7,
  className
}: {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
})
