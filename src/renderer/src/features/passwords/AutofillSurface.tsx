import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { AUTOFILL_MAX_ROWS, AUTOFILL_ROW_HEIGHT, type AutofillEntry } from '@shared/passwords'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { useSurface } from '../../lib/surface'
import { useUi } from '../../stores/ui'

/**
 * The list of saved sign-ins over a focused field. Main decides what is in
 * it, where it goes and which row the arrow keys have picked; the password
 * is never here — a click only sends the row's id back, and main writes the
 * credential into the page itself.
 *
 * It never has the keyboard: arrow keys stay in the page's field, and the
 * page forwards them through main. Sizes come from `@shared/passwords`,
 * which main uses to size the surface, so the card fills it exactly.
 */
export function AutofillSurface() {
  const autofill = useUi((s) => s.autofill)
  // Created lazily on first use, then kept (hidden) for instant re-opening.
  const [used, setUsed] = useState(false)
  if (autofill && !used) setUsed(true)
  const root = useSurface('autofill', used)

  if (!root || !autofill || autofill.entries.length === 0) return null
  return createPortal(<Dropdown {...autofill} />, root)
}

/** Pick on press: the press moves the keyboard here, and main waits for this before closing. */
function onPress(action: () => void) {
  return (event: React.MouseEvent) => {
    event.preventDefault()
    action()
  }
}

function Dropdown({ entries, active, above }: { entries: readonly AutofillEntry[]; active: number; above: boolean }) {
  const t = useT()
  const rows = useRef<HTMLDivElement | null>(null)

  // Keep the row picked with the arrow keys in view once the list scrolls.
  useEffect(() => {
    if (active >= 0) rows.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    // Room for the shadow on the sides and away from the field; the card
    // itself touches the edge facing the field.
    <div className={`flex h-full px-1.5 ${above ? 'items-end pt-1.5' : 'items-start pb-1.5'}`}>
      <div className="anim-pop w-full rounded-[7px] bg-[var(--popover)] p-1 text-[var(--text)] shadow-[0_3px_10px_rgb(0_0_0/0.12),0_1px_2px_rgb(0_0_0/0.06),0_0_0_0.5px_var(--popover-line)]">
        <div
          ref={rows}
          role="listbox"
          className="overflow-y-auto [scrollbar-width:thin]"
          style={{ maxHeight: AUTOFILL_MAX_ROWS * AUTOFILL_ROW_HEIGHT }}
        >
          {entries.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseDown={onPress(() => send('passwords.fill', entry.id))}
              style={{ height: AUTOFILL_ROW_HEIGHT }}
              className={`flex w-full items-center gap-2.5 rounded-[4px] px-1.5 text-left ${
                index === active ? 'bg-[var(--hover)]' : 'hover:bg-[var(--hover)]'
              }`}
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[5px] bg-[var(--accent-soft)] text-[var(--accent)]">
                <Icon name="lock" size={13} />
              </span>
              <span className="min-w-0 flex-1">
                {entry.username ? (
                  <span className="block truncate text-[13px] font-medium leading-[17px]">{entry.username}</span>
                ) : (
                  <span className="block truncate text-[13px] leading-[17px] text-[var(--text-3)]">{t('passwords.autofill.noUsername')}</span>
                )}
                <span className="block text-[12px] leading-[14px] tracking-[0.02em] text-[var(--text-3)]">••••••••</span>
              </span>
            </button>
          ))}
        </div>
        <div className="mx-1.5 my-1 h-px bg-[var(--line)]" />
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={onPress(() => send('passwords.manage'))}
          className="flex h-7 w-full items-center gap-2.5 rounded-[4px] px-1.5 text-left text-[12.5px] text-[var(--text-2)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <span className="grid w-6 shrink-0 place-items-center">
            <Icon name="settings" size={13} />
          </span>
          {t('passwords.autofill.manage')}
        </button>
      </div>
    </div>
  )
}
