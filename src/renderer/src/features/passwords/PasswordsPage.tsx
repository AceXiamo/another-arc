import { useEffect, useMemo, useState } from 'react'
import { siteOf, type SavedLogin } from '@shared/passwords'
import { internalUrl } from '@shared/url'
import { Favicon } from '../../components/Favicon'
import { Icon } from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { selectActiveTab, useBrowser } from '../../stores/browser'
import { EmptyNote, PageLayout, SmallButton } from '../pages/PageLayout'

/**
 * Every saved login, reached from Settings (or the autofill dropdown). The
 * passwords themselves stay in main: this page sees names only, a password
 * shows after Touch ID and copies straight to the clipboard from main.
 */
export default function PasswordsPage() {
  const t = useT()
  const tabId = useBrowser((s) => selectActiveTab(s)?.id)
  const [logins, setLogins] = useState<SavedLogin[] | null>(null)
  const [canSave, setCanSave] = useState(true)
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    void rpc('passwords.list').then(setLogins)
    void rpc('passwords.available').then(setCanSave)
  }, [])

  // Sorted by site so a site's accounts sit together.
  const sorted = useMemo(
    () =>
      (logins ?? [])
        .map((login) => ({ ...login, site: siteOf(login.origin) }))
        .sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)),
    [logins]
  )
  const needle = query.trim().toLowerCase()
  const visible = needle
    ? sorted.filter((l) => l.site.toLowerCase().includes(needle) || l.username.toLowerCase().includes(needle))
    : sorted

  const copy = (id: string) => {
    void rpc('passwords.copy', id).then((ok) => {
      if (!ok) return
      setCopied(id)
      setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    })
  }
  const toggle = (id: string) => {
    if (shown[id] !== undefined) {
      setShown(({ [id]: _gone, ...rest }) => rest)
      return
    }
    void rpc('passwords.reveal', id).then((password) => {
      if (password !== null) setShown((current) => ({ ...current, [id]: password }))
    })
  }
  const remove = (id: string) => {
    send('passwords.remove', id)
    setLogins((current) => current?.filter((l) => l.id !== id) ?? null)
  }

  return (
    <PageLayout
      title={t('page.passwords')}
      back={{ label: t('page.settings'), onClick: () => tabId && send('tabs.navigate', tabId, internalUrl('settings')) }}
    >
      <p className="-mt-5 text-[12.5px] leading-relaxed text-[var(--text-3)]">{t('passwords.settings.description')}</p>
      {!canSave ? (
        <div className="rounded-[12px] bg-[var(--surface-2)] px-4 py-3.5 text-[var(--text-3)] shadow-[var(--card-shadow)]">
          {t('passwords.settings.unavailable')}
        </div>
      ) : logins !== null && logins.length === 0 ? (
        <div className="rounded-[12px] bg-[var(--surface-2)] px-4 py-3.5 text-[var(--text-3)] shadow-[var(--card-shadow)]">
          {t('passwords.settings.empty')}
        </div>
      ) : (
        logins !== null && (
          <>
            <label className="flex h-9 items-center gap-2 rounded-[10px] bg-[var(--surface-2)] pl-3 pr-1.5 shadow-[var(--card-shadow)] focus-within:shadow-[inset_0_0_0_1px_var(--focus),0_0_0_3px_color-mix(in_oklch,var(--space)_18%,transparent)]">
              <Icon name="search" size={15} className="text-[var(--ink)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) {
                    e.preventDefault()
                    setQuery('')
                  }
                }}
                placeholder={t('passwords.page.search')}
                spellCheck={false}
                className="h-full min-w-0 flex-1 bg-transparent outline-none"
              />
              {query && (
                <button
                  title={t('passwords.page.clearSearch')}
                  aria-label={t('passwords.page.clearSearch')}
                  onClick={() => setQuery('')}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-[var(--ink)] hover:bg-[var(--hover)] hover:text-[var(--ink-strong)] active:bg-[var(--press)]"
                >
                  <Icon name="close" size={13} strokeWidth={1.8} />
                </button>
              )}
            </label>
            <div className="-mt-4 flex flex-col">
              {visible.map((login) => {
                const revealed = shown[login.id]
                return (
                  <div
                    key={login.id}
                    data-login={login.id}
                    // Off-screen rows skip layout and paint: hundreds of logins stay cheap.
                    className="group flex h-12 shrink-0 items-center gap-3 rounded-[8px] px-2 [contain-intrinsic-size:auto_48px] [content-visibility:auto] hover:bg-[var(--hover)]"
                  >
                    <Favicon url={login.origin} favicon={null} title={login.site} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[var(--text-1)] group-hover:text-[var(--text)]" title={login.origin}>
                        {login.site}
                      </div>
                      <div className="truncate text-[12px] text-[var(--text-3)]">
                        {login.username || t('passwords.autofill.noUsername')}
                      </div>
                    </div>
                    {revealed !== undefined ? (
                      <span className="max-w-[40%] shrink truncate font-mono text-[12.5px] text-[var(--text-1)]">{revealed}</span>
                    ) : (
                      <span className="shrink-0 text-[12px] text-[var(--text-3)] group-hover:hidden group-focus-within:hidden">
                        {login.timesUsed > 0
                          ? t('passwords.settings.used', { count: login.timesUsed })
                          : t('passwords.settings.neverUsed')}
                      </span>
                    )}
                    <div
                      className={`shrink-0 items-center gap-0.5 ${
                        revealed !== undefined || copied === login.id ? 'flex' : 'hidden group-hover:flex group-focus-within:flex'
                      }`}
                    >
                      <SmallButton onClick={() => copy(login.id)}>
                        {copied === login.id ? t('passwords.settings.copied') : t('passwords.settings.copy')}
                      </SmallButton>
                      <SmallButton onClick={() => toggle(login.id)}>
                        {revealed !== undefined ? t('passwords.settings.hide') : t('passwords.settings.show')}
                      </SmallButton>
                      <SmallButton danger onClick={() => remove(login.id)}>
                        {t('passwords.settings.remove')}
                      </SmallButton>
                    </div>
                  </div>
                )
              })}
              {visible.length === 0 && (
                <EmptyNote art="no-results" title={t('passwords.page.noMatches')} hint={t('passwords.page.noMatchesHint')} />
              )}
            </div>
          </>
        )
      )}
    </PageLayout>
  )
}
