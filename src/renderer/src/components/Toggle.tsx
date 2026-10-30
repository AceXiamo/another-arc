/**
 * Switch. Only transform and opacity animate: the "on" fill fades in over
 * the track instead of transitioning background-color.
 */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative h-[22px] w-[38px] shrink-0 overflow-hidden rounded-full bg-[color-mix(in_oklch,var(--text)_16%,transparent)]"
    >
      <span
        className={`absolute inset-0 rounded-full bg-[var(--accent-fill)] transition-opacity duration-150 ${checked ? 'opacity-100' : 'opacity-0'}`}
      />
      <span
        className={`absolute left-0 top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2),0_0_0_0.5px_rgb(0_0_0/0.06)] transition-transform duration-150 ease-out ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  )
}
