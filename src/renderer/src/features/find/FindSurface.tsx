import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useSurface } from '../../lib/surface'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import { useUi } from '../../stores/ui'

export function FindSurface() {
  const open = useUi((s) => s.findOpen)
  const tabId = useBrowser((s) => selectActiveTab(s)?.id)
  // Created lazily on first use, then kept (hidden) for instant re-opening.
  const [used, setUsed] = useState(false)
  if (open && !used) setUsed(true)
  const root = useSurface('find', used)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focusTick, setFocusTick] = useState(0)

  useEffect(() => {
    if (!open) return
    // Main focuses the surface's WebContents; focus the input once it has.
    void rpc('surface.setVisible', 'find', true).then(() => setFocusTick((n) => n + 1))
    return () => send('surface.setVisible', 'find', false)
  }, [open])

  useEffect(() => {
    if (!open || !tabId) return
    return () => send('find.stop', tabId)
  }, [open, tabId])

  useEffect(() => {
    if (focusTick === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusTick])

  // A second ⌘F while open re-focuses the field.
  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        if (s.findOpen && prev.findOpen) setFocusTick((n) => n + 1)
      }),
    []
  )

  if (!root || !open || !tabId) return null
  return createPortal(<FindBar tabId={tabId} inputRef={inputRef} />, root)
}

function FindBar({ tabId, inputRef }: { tabId: string; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const t = useT()
  const find = useBrowser((s) => (s.find?.tabId === tabId ? s.find : null))
  const [text, setText] = useState('')
  const close = () => useUi.setState({ findOpen: false })
  const step = (forward: boolean) => text && send('find.update', tabId, text, forward, true)

  const btn =
    'grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--ink)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)] active:bg-[var(--press)] disabled:text-[var(--ink-faint)] disabled:hover:bg-transparent'
  const none = text !== '' && find !== null && find.matches === 0
  return (
    <div className="flex h-full items-start px-3 pt-2">
      <div className="anim-pop flex h-11 w-full items-center gap-0.5 rounded-[12px] bg-[var(--popover)] pl-3 pr-1.5 text-[var(--text)] shadow-[0_4px_14px_rgb(0_0_0/0.14),0_0_0_0.5px_var(--popover-line)]">
        <Icon name="search" size={15} className="mr-1.5 text-[var(--ink)]" />
        <input
          ref={inputRef}
          value={text}
          spellCheck={false}
          placeholder={t('find.placeholder')}
          onChange={(e) => {
            setText(e.target.value)
            send('find.update', tabId, e.target.value, true, false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
            else if (e.key === 'Enter' && !e.nativeEvent.isComposing) step(!e.shiftKey)
          }}
          className="h-full min-w-0 flex-1 bg-transparent outline-none"
        />
        <span className={`shrink-0 px-1.5 text-[12px] tabular-nums ${none ? 'text-[var(--danger)]' : 'text-[var(--text-3)]'}`}>
          {text && find ? `${find.matches === 0 ? 0 : find.activeMatch}/${find.matches}` : ''}
        </span>
        <span className="mx-1 h-4 w-px shrink-0 bg-[var(--line)]" />
        <button onClick={() => step(false)} disabled={!text} className={btn} title={t('find.previous')}>
          <Icon name="up" size={15} />
        </button>
        <button onClick={() => step(true)} disabled={!text} className={btn} title={t('find.next')}>
          <Icon name="down" size={15} />
        </button>
        <button onClick={close} className={btn} title={t('find.close')}>
          <Icon name="close" size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
