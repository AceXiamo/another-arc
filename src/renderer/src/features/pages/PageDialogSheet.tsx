import { useEffect, useId, useRef, useState } from 'react'
import type { Translate } from '@shared/i18n'
import type { PageDialog } from '@shared/types'
import { useT } from '../../lib/i18n'
import { send } from '../../lib/rpc'
import { selectActiveDialog, useBrowser } from '../../stores/browser'

/** "example.com says", with the port when there is one; never the page's own words. */
function heading(origin: string, t: Translate): string {
  if (/^https?:\/\//.test(origin)) {
    try {
      return t('pageDialog.says', { host: new URL(origin).host })
    } catch {
      // Fall through to the generic heading.
    }
  }
  return t('pageDialog.thisPageSays')
}

/**
 * A page's alert() / confirm() / prompt(), as a sheet at the top of its page
 * card. The shell is raised over the page while it shows (see effects.ts), so
 * the page stays visible but dimmed and the sidebar keeps working; switching
 * tabs cancels it in main. The page itself stays blocked until it is answered.
 */
export function PageDialogSheet() {
  const dialog = useBrowser(selectActiveDialog)
  return dialog ? <Sheet key={dialog.id} dialog={dialog} /> : null
}

function Sheet({ dialog }: { dialog: PageDialog }) {
  const t = useT()
  const [text, setText] = useState(dialog.defaultText)
  const [suppress, setSuppress] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const ok = useRef<HTMLButtonElement>(null)
  const answered = useRef(false)
  const titleId = useId()
  const messageId = useId()
  const cancelable = dialog.kind !== 'alert'

  const answer = (accept: boolean) => {
    if (answered.current) return
    answered.current = true
    send('pageDialogs.respond', dialog.id, accept, text, suppress)
  }

  // Main focuses the shell when it is raised; whatever is focused here gets the keys.
  useEffect(() => {
    if (field.current) {
      field.current.focus()
      field.current.select()
    } else {
      ok.current?.focus()
    }
  }, [])

  return (
    <div className="anim-fade absolute inset-0 z-30" style={{ background: 'var(--overlay)' }}>
      <div className="flex justify-center px-4 pt-3">
        <form
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={dialog.message ? messageId : undefined}
          onSubmit={(e) => {
            e.preventDefault()
            answer(true)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            answer(!cancelable)
          }}
          className="anim-pop w-full max-w-[440px] rounded-[12px] bg-[var(--popover)] p-4 text-[var(--text)] shadow-[0_8px_28px_rgb(0_0_0/0.18),0_0_0_0.5px_var(--popover-line)]"
        >
          <div id={titleId} className="truncate text-[13px] font-semibold">
            {heading(dialog.origin, t)}
          </div>
          {dialog.message && (
            <div
              id={messageId}
              className="mt-1.5 max-h-[40vh] select-text overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-snug text-[var(--text-2)]"
            >
              {dialog.message}
            </div>
          )}
          {dialog.kind === 'prompt' && (
            <input
              ref={field}
              value={text}
              spellCheck={false}
              aria-labelledby={titleId}
              onChange={(e) => setText(e.target.value)}
              className="mt-3 h-8 w-full rounded-[7px] bg-[var(--hover)] px-2.5 text-[13px] outline-none focus:shadow-[inset_0_0_0_1.5px_var(--focus)]"
            />
          )}
          {dialog.canSuppress && (
            <label className="mt-3 flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
              <input type="checkbox" className="m-0" checked={suppress} onChange={(e) => setSuppress(e.target.checked)} />
              {t('pageDialog.suppress')}
            </label>
          )}
          <div className="mt-4 flex justify-end gap-2">
            {cancelable && (
              <button
                type="button"
                onClick={() => answer(false)}
                className="h-7 rounded-[7px] px-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--hover)] active:bg-[var(--press)]"
              >
                {t('common.cancel')}
              </button>
            )}
            <button
              ref={ok}
              type="submit"
              className="h-7 min-w-[64px] rounded-[7px] bg-[var(--accent-fill)] px-3 text-[12.5px] font-medium text-white hover:brightness-110 active:brightness-95"
            >
              {t('pageDialog.ok')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
