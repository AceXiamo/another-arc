import { useUi } from '../stores/ui'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-[52px] left-2 z-40 flex flex-col items-start gap-1.5"
      style={{ maxWidth: 'calc(var(--sidebar-width) - 16px)' }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="anim-rise max-w-full truncate rounded-[10px] bg-[var(--popover)] px-3 py-[7px] text-[12.5px] font-medium shadow-[var(--popover-shadow)]"
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
