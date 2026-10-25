import { useEffect, useState } from 'react'
import type { ImportableBrowser } from '@shared/ext-import'
import { LOCALES, type MessageKey } from '@shared/i18n'
import type { SearchEngineId, Settings, SitePermission } from '@shared/types'
import { isValidSearchTemplate, SEARCH_ENGINES } from '@shared/url'
import { useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { PageLayout, Row, Section, Select, SmallButton, Toggle } from './PageLayout'

const PERMISSION_LABELS: Record<string, MessageKey> = {
  media: 'settings.permissions.media',
  geolocation: 'settings.permissions.geolocation',
  notifications: 'settings.permissions.notifications',
  'clipboard-read': 'settings.permissions.clipboardRead',
  midiSysex: 'settings.permissions.midiSysex',
  'idle-detection': 'settings.permissions.idleDetection',
  'window-management': 'settings.permissions.windowManagement',
  'storage-access': 'settings.permissions.storageAccess',
  'top-level-storage-access': 'settings.permissions.storageAccess',
  fileSystem: 'settings.permissions.fileSystem',
  openExternal: 'settings.permissions.openExternal'
}

const LANGUAGE_OPTIONS = LOCALES.map((l) => ({ value: l.id, label: l.name }))

function update(patch: Partial<Settings>) {
  send('settings.update', patch)
}

export default function SettingsPage() {
  const t = useT()
  const settings = useBrowser((s) => s.settings)
  const [custom, setCustom] = useState(settings.customSearchUrl)
  const [permissions, setPermissions] = useState<SitePermission[]>([])
  const [budget, setBudget] = useState(String(settings.memoryBudgetMB || ''))

  const loadPermissions = () => void rpc('permissions.list').then(setPermissions)
  useEffect(loadPermissions, [])

  // Every installed browser and what it would bring over. The scan is
  // read-only; picking another profile re-runs it for that browser.
  const [browsers, setBrowsers] = useState<ImportableBrowser[]>([])
  const [profiles, setProfiles] = useState<Record<string, string>>({})
  useEffect(() => {
    void rpc('import.browsers', profiles).then(setBrowsers)
  }, [profiles])

  const offers = (b: ImportableBrowser) =>
    [
      ...(b.bookmarks ? [t('browserImport.settings.bookmarks', b.bookmarks)] : []),
      ...(b.extensions > 0 ? [t('browserImport.settings.extensions', { count: b.extensions })] : []),
      ...(b.logins ? [t('browserImport.settings.logins', { hosts: b.logins.hosts })] : [])
    ].join(' · ')

  const engines: Array<{ value: SearchEngineId; label: string }> = [
    ...(Object.entries(SEARCH_ENGINES) as Array<[SearchEngineId, { name: string }]>).map(([value, e]) => ({
      value,
      label: e.name
    })),
    { value: 'custom', label: t('settings.search.custom') }
  ]

  const permissionLabel = (permission: string) => {
    const key = Object.hasOwn(PERMISSION_LABELS, permission) ? PERMISSION_LABELS[permission] : undefined
    return key ? t(key) : permission
  }

  return (
    <PageLayout title={t('page.settings')}>
      <Section title={t('settings.search.title')}>
        <Row label={t('settings.search.engine')} hint={t('settings.search.engineHint')}>
          <Select value={settings.searchEngine} options={engines} onChange={(searchEngine) => update({ searchEngine })} />
        </Row>
        {settings.searchEngine === 'custom' && (
          <Row label={t('settings.search.customUrl')} hint={t('settings.search.customUrlHint')}>
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => isValidSearchTemplate(custom) && update({ customSearchUrl: custom })}
              aria-invalid={custom !== '' && !isValidSearchTemplate(custom)}
              className="field h-[28px] w-72 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--danger)]"
              placeholder="https://…?q=%s"
            />
          </Row>
        )}
      </Section>

      <Section title={t('settings.appearance.title')}>
        <Row label={t('settings.appearance.language')}>
          <Select value={settings.language} options={LANGUAGE_OPTIONS} onChange={(language) => update({ language })} />
        </Row>
        <Row label={t('settings.appearance.theme')}>
          <Select
            value={settings.theme}
            options={[
              { value: 'system', label: t('settings.appearance.themeSystem') },
              { value: 'light', label: t('settings.appearance.themeLight') },
              { value: 'dark', label: t('settings.appearance.themeDark') }
            ]}
            onChange={(theme) => update({ theme })}
          />
        </Row>
      </Section>

      <Section title={t('settings.performance.title')} description={t('settings.performance.description')}>
        <Row label={t('settings.performance.discard')} hint={t('settings.performance.discardHint')}>
          <Select
            value={settings.discardAfterMinutes}
            options={[
              { value: 0, label: t('settings.performance.never') },
              { value: 5, label: t('settings.performance.minutes', { count: 5 }) },
              { value: 15, label: t('settings.performance.minutes', { count: 15 }) },
              { value: 30, label: t('settings.performance.minutes', { count: 30 }) },
              { value: 60, label: t('settings.performance.oneHour') },
              { value: 180, label: t('settings.performance.hours', { count: 3 }) }
            ]}
            onChange={(discardAfterMinutes) => update({ discardAfterMinutes })}
          />
        </Row>
        <Row label={t('settings.performance.memoryBudget')} hint={t('settings.performance.memoryBudgetHint')}>
          <input
            value={budget}
            inputMode="numeric"
            onChange={(e) => setBudget(e.target.value.replace(/\D/g, ''))}
            onBlur={() => update({ memoryBudgetMB: Math.min(131072, Number(budget) || 0) })}
            placeholder={t('settings.performance.noLimit')}
            className="field h-[28px] w-24 text-right tabular-nums"
          />
          <span className="text-[12px] text-[var(--text-3)]">MB</span>
        </Row>
      </Section>

      <Section title={t('settings.downloads.title')}>
        <Row label={t('settings.downloads.askWhere')}>
          <Toggle checked={settings.downloadAskWhere} onChange={(downloadAskWhere) => update({ downloadAskWhere })} />
        </Row>
        <Row label={t('settings.downloads.location')} hint={settings.downloadDir || t('settings.downloads.defaultFolder')}>
          {settings.downloadDir && (
            <SmallButton onClick={() => update({ downloadDir: '' })}>{t('settings.downloads.useDefault')}</SmallButton>
          )}
          <SmallButton onClick={() => void rpc('settings.pickDownloadDir')}>{t('settings.downloads.change')}</SmallButton>
        </Row>
      </Section>

      {browsers.length > 0 && (
        <Section title={t('browserImport.settings.section')}>
          {browsers.map((b) => (
            <Row key={b.id} label={b.name} hint={offers(b)}>
              {b.profiles.length > 1 && (
                <Select
                  value={b.profileDir}
                  options={b.profiles.map((p) => ({ value: p.dir, label: p.name }))}
                  onChange={(dir) => setProfiles((chosen) => ({ ...chosen, [b.id]: dir }))}
                />
              )}
              <SmallButton onClick={() => send('import.run', b.id, b.profileDir)}>
                {t('browserImport.settings.import')}
              </SmallButton>
            </Row>
          ))}
        </Section>
      )}

      <Section title={t('settings.permissions.title')} description={t('settings.permissions.description')}>
        {permissions.length === 0 ? (
          <div className="px-4 py-3.5 text-[var(--text-3)]">{t('settings.permissions.empty')}</div>
        ) : (
          permissions.map((p) => (
            <Row key={`${p.origin}|${p.permission}`} label={p.origin} hint={permissionLabel(p.permission)}>
              <span
                className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${
                  p.decision === 'allow' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--hover)] text-[var(--text-2)]'
                }`}
              >
                {p.decision === 'allow' ? t('settings.permissions.allowed') : t('settings.permissions.blocked')}
              </span>
              <SmallButton
                onClick={() => {
                  send('permissions.reset', p.origin, p.permission)
                  setPermissions((list) => list.filter((x) => x !== p))
                }}
              >
                {t('settings.permissions.reset')}
              </SmallButton>
            </Row>
          ))
        )}
      </Section>
    </PageLayout>
  )
}
