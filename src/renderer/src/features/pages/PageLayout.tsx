import { Icon, type IconName } from '../../components/Icon'
import { Illustration, type IllustrationName } from '../../components/Illustration'

export { Toggle } from '../../components/Toggle'

export function PageLayout({
  title,
  icon,
  actions,
  back,
  header,
  children
}: {
  title: string
  /** Shown before the title (an extension's icon). */
  icon?: React.ReactNode
  actions?: React.ReactNode
  /** A page reached from another one: a link back to it above the title. */
  back?: { label: string; onClick: () => void }
  /** A page's own banner in place of the title row (it shows the title itself). */
  header?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="scroll-y h-full select-text">
      <div className={`mx-auto flex max-w-[720px] flex-col gap-7 px-8 pb-20 ${back ? 'pt-6' : 'pt-12'}`}>
        {back && (
          <button
            data-page-back
            onClick={back.onClick}
            className="-mb-5 -ml-1.5 flex h-7 w-fit items-center gap-0.5 rounded-[7px] pl-0.5 pr-2 text-[13px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)] active:bg-[var(--press)]"
          >
            <Icon name="back" size={15} strokeWidth={1.8} />
            {back.label}
          </button>
        )}
        {header ?? (
          <header className="flex min-h-8 items-center gap-3">
            {icon}
            <h1 className="min-w-0 flex-1 truncate text-[24px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
            {actions}
          </header>
        )}
        {children}
      </div>
    </div>
  )
}

export function Section({
  title,
  children,
  description,
  action
}: {
  title: string
  description?: string
  /** A small control at the end of the title line. */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-end gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-[12px] font-semibold text-[var(--text-2)]">{title}</h2>
          {description && <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-3)]">{description}</p>}
        </div>
        {action}
      </div>
      <div className="flex flex-col rounded-[12px] bg-[var(--surface-2)] shadow-[var(--card-shadow)] [&>*+*]:shadow-[inset_0_0.5px_0_var(--line)]">
        {children}
      </div>
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[50px] items-center gap-4 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-3)]">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function Select<T extends string | number>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <span className="relative inline-flex">
      <select
        value={String(value)}
        onChange={(e) => {
          const found = options.find((o) => String(o.value) === e.target.value)
          if (found) onChange(found.value)
        }}
        className="h-[28px] appearance-none rounded-[7px] bg-[var(--surface)] pl-2.5 pr-7 shadow-[inset_0_0_0_1px_var(--line),0_0.5px_1px_rgb(0_0_0/0.04)] outline-none hover:bg-[color-mix(in_oklch,var(--surface)_92%,var(--text))] focus-visible:shadow-[inset_0_0_0_1px_var(--focus),0_0_0_3px_color-mix(in_oklch,var(--space)_18%,transparent)]"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevron"
        size={12}
        strokeWidth={2}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--ink)]"
      />
    </span>
  )
}

export function SmallButton({
  children,
  onClick,
  danger,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`h-7 shrink-0 rounded-[7px] px-2.5 text-[12px] font-medium transition-[scale,background-color,color] duration-150 ease-out enabled:active:scale-[0.96] disabled:opacity-40 disabled:hover:bg-transparent ${
        danger
          ? 'text-[var(--danger)] hover:bg-[var(--danger-soft)] active:bg-[color-mix(in_oklab,var(--danger)_18%,transparent)]'
          : 'text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)] active:bg-[var(--press)]'
      }`}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ icon, children, onClick }: { icon?: IconName; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] bg-[var(--surface-2)] px-3 text-[12.5px] font-medium text-[var(--text)] shadow-[var(--card-shadow)] transition-[scale,background-color] duration-150 ease-out hover:bg-[var(--surface-3)] active:scale-[0.96]"
    >
      {icon && <Icon name={icon} size={14} strokeWidth={1.8} />}
      {children}
    </button>
  )
}

export function PrimaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-[8px] bg-[var(--accent-fill)] px-3 text-[12.5px] font-medium text-white transition-[scale,filter] duration-150 ease-out hover:brightness-110 active:scale-[0.96] active:brightness-95"
    >
      {children}
    </button>
  )
}

/** Empty list: a spot illustration, a short heading and an optional hint. */
export function EmptyNote({ art, title, hint }: { art: IllustrationName; title: string; hint?: string }) {
  return (
    <div className="anim-fade flex flex-col items-center px-6 pb-10 pt-12 text-center">
      <Illustration name={art} />
      <div className="mt-5 text-balance text-[14px] font-medium text-[var(--text-1)]">{title}</div>
      {hint && <p className="mt-1 max-w-[340px] text-pretty text-[12.5px] leading-relaxed text-[var(--text-3)]">{hint}</p>}
    </div>
  )
}
