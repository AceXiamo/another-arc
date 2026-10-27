import { createPortal } from 'react-dom'
import { useEffect, useState } from 'react'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useSurface } from '../../lib/surface'
import { useUi } from '../../stores/ui'

/**
 * "Save this password?" over the page, after a sign-in goes through. Main
 * holds the credential until this answers; nothing is stored on its own.
 */
export function SavePasswordPrompt() {
  const prompt = useUi((s) => s.passwordPrompt)
  const [used, setUsed] = useState(false)
  if (prompt && !used) setUsed(true)
  const root = useSurface('passwordSave', used)

  useEffect(() => {
    if (!prompt) return
    void rpc('surface.setVisible', 'passwordSave', true)
    return () => send('surface.setVisible', 'passwordSave', false)
  }, [prompt])

  if (!root || !prompt) return null
  return createPortal(<Prompt origin={prompt.origin} username={prompt.username} />, root)
}

function Prompt({ origin, username }: { origin: string; username: string }) {
  const t = useT()
  const answer = (accept: boolean) => {
    send('passwords.resolveSave', accept)
    useUi.setState({ passwordPrompt: null })
  }
  const host = origin.replace(/^https?:\/\//, '')
  return (
    <div className="flex h-full items-start px-3 pt-2">
      <div className="anim-pop w-full rounded-[12px] bg-[var(--popover)] p-3 text-[var(--text)] shadow-[0_4px_14px_rgb(0_0_0/0.14),0_0_0_0.5px_var(--popover-line)]">
        <div className="text-[13px] font-medium">
          {username ? t('passwords.save.message', { origin: host }) : t('passwords.save.messageNoUser')}
        </div>
        {username && <div className="mt-0.5 truncate text-[12px] text-[var(--text-3)]">{username}</div>}
        <div className="mt-2.5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => answer(false)}
            className="h-7 rounded-[7px] px-2.5 text-[12.5px] text-[var(--ink)] hover:bg-[var(--hover)] active:bg-[var(--press)]"
          >
            {t('passwords.save.notNow')}
          </button>
          <button
            type="button"
            onClick={() => answer(true)}
            className="h-7 rounded-[7px] bg-[var(--accent-fill)] px-3 text-[12.5px] font-medium text-white hover:brightness-110 active:brightness-95"
          >
            {t('passwords.save.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
