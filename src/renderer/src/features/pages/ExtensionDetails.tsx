import { useEffect, useRef, useState } from 'react'
import type { MessageKey } from '@shared/i18n'
import { formatShortcut, shortcutFromKey } from '@shared/shortcuts'
import type { ExtensionCommand, ExtensionDetails as Details, ExtensionError, ExtensionInfo } from '@shared/types'
import { Icon } from '../../components/Icon'
import { formatBytes } from '../../lib/format'
import { useLocale, useT } from '../../lib/i18n'
import { rpc, send } from '../../lib/rpc'
import { useBrowser } from '../../stores/browser'
import { toast } from '../../stores/ui'
import { ExtensionIcon, useExtensionsNav } from './extension-ui'
import { PageLayout, Row, SecondaryButton, Section, SmallButton, Toggle } from './PageLayout'

/** chrome.* permission → what it lets the extension do. Unknown ones show their name. */
const PERMISSIONS: Record<string, MessageKey> = {
  activeTab: 'extensions.perm.activeTab',
  alarms: 'extensions.perm.alarms',
  background: 'extensions.perm.background',
  bookmarks: 'extensions.perm.bookmarks',
  clipboardRead: 'extensions.perm.clipboardRead',
  clipboardWrite: 'extensions.perm.clipboardWrite',
  'clipboard-write': 'extensions.perm.clipboardWrite',
  contextMenus: 'extensions.perm.contextMenus',
  cookies: 'extensions.perm.cookies',
  debugger: 'extensions.perm.debugger',
  declarativeNetRequest: 'extensions.perm.declarativeNetRequest',
  declarativeNetRequestWithHostAccess: 'extensions.perm.declarativeNetRequest',
  declarativeNetRequestFeedback: 'extensions.perm.declarativeNetRequestFeedback',
  downloads: 'extensions.perm.downloads',
  favicon: 'extensions.perm.favicon',
  fontSettings: 'extensions.perm.fontSettings',
  gcm: 'extensions.perm.gcm',
  geolocation: 'extensions.perm.geolocation',
  history: 'extensions.perm.history',
  identity: 'extensions.perm.identity',
  idle: 'extensions.perm.idle',
  management: 'extensions.perm.management',
  nativeMessaging: 'extensions.perm.nativeMessaging',
  notifications: 'extensions.perm.notifications',
  offscreen: 'extensions.perm.offscreen',
  privacy: 'extensions.perm.privacy',
  proxy: 'extensions.perm.proxy',
  scripting: 'extensions.perm.scripting',
  sessions: 'extensions.perm.sessions',
  sidePanel: 'extensions.perm.sidePanel',
  storage: 'extensions.perm.storage',
  'system.cpu': 'extensions.perm.system',
  'system.memory': 'extensions.perm.system',
  'system.display': 'extensions.perm.system',
  'system.storage': 'extensions.perm.system',
  tabGroups: 'extensions.perm.tabGroups',
  tabs: 'extensions.perm.tabs',
  topSites: 'extensions.perm.topSites',
  tts: 'extensions.perm.tts',
  unlimitedStorage: 'extensions.perm.unlimitedStorage',
  userScripts: 'extensions.perm.userScripts',
  webNavigation: 'extensions.perm.webNavigation',
  webRequest: 'extensions.perm.webRequest',
  webRequestBlocking: 'extensions.perm.webRequestBlocking'
}

const BROAD_HOSTS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'])

export default function ExtensionDetails({ id }: { id: string }) {
  const t = useT()
  const nav = useExtensionsNav()
  const ext = useBrowser((s) => s.extensions.find((e) => e.id === id))
  const details = useDetails(id, ext)
  const [busy, setBusy] = useState(false)
  const back = { label: t('page.extensions'), onClick: () => nav.open(null) }

  if (!ext) {
    return (
      <PageLayout title={t('page.extensions')} back={back}>
        <p className="px-1 text-[13px] text-[var(--text-3)]">{t('extensions.detail.notFound')}</p>
      </PageLayout>
    )
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const broad = ext.hostPermissions.some((h) => BROAD_HOSTS.has(h))
  const hosts = ext.hostPermissions.filter((h) => !BROAD_HOSTS.has(h) && /:\/\//.test(h))
  return (
    <PageLayout
      title={ext.name}
      back={back}
      icon={<ExtensionIcon ext={ext} size={32} />}
      actions={
        <label className="flex shrink-0 items-center gap-2 text-[12.5px] text-[var(--text-2)]">
          {t('extensions.action.enable')}
          <Toggle
            checked={ext.enabled}
            label={t('extensions.action.enable')}
            onChange={(v) => void run(() => rpc('extensions.setEnabled', ext.id, v))}
          />
        </label>
      }
    >
      <div className="-mt-4 flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-x-1.5 px-1 text-[12px] tabular-nums text-[var(--text-3)]">
          <span>{ext.version}</span>
          <span aria-hidden>·</span>
          <span>{ext.fromStore ? t('extensions.detail.fromStore') : t('extensions.detail.unpacked')}</span>
          <span aria-hidden>·</span>
          <span>MV{ext.manifestVersion}</span>
        </p>
        {ext.description && (
          <p className="max-w-[60ch] text-pretty px-1 text-[13px] leading-relaxed text-[var(--text-2)]">{ext.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {ext.optionsUrl && (
            <SecondaryButton icon="sliders" onClick={() => send('extensions.openOptions', ext.id)}>
              {t('extensions.action.options')}
            </SecondaryButton>
          )}
          {ext.hasAction && (
            <SecondaryButton icon="pin" onClick={() => send('extensions.setPinned', ext.id, !ext.pinned)}>
              {ext.pinned ? t('extensions.action.unpin') : t('extensions.action.pin')}
            </SecondaryButton>
          )}
          {ext.enabled && (
            <SecondaryButton icon="reload" onClick={() => void run(() => rpc('extensions.reload', ext.id))}>
              {t('extensions.action.reload')}
            </SecondaryButton>
          )}
          {(ext.fromStore || details?.sourceExists) && (
            <SecondaryButton icon="download" onClick={() => void run(() => rpc('extensions.update', ext.id))}>
              {t('extensions.action.update')}
            </SecondaryButton>
          )}
          <div className="flex-1" />
          <SmallButton danger disabled={busy} onClick={() => void rpc('extensions.uninstall', ext.id)}>
            {t('extensions.action.remove')}
          </SmallButton>
        </div>
        {!ext.enabled && <p className="px-1 text-[12px] text-[var(--text-3)]">{t('extensions.detail.off')}</p>}
      </div>

      <Section title={t('extensions.access.title')} description={t('extensions.access.reloadNote')}>
        {ext.userScripts !== null && (
          <Row label={t('extensions.access.userScripts')} hint={t('extensions.access.userScriptsHint')}>
            <Toggle
              checked={ext.userScripts}
              label={t('extensions.access.userScripts')}
              onChange={(v) => void run(() => rpc('extensions.setUserScripts', ext.id, v))}
            />
          </Row>
        )}
        <Row label={t('extensions.access.fileUrls')} hint={t('extensions.access.fileUrlsHint')}>
          <Toggle
            checked={ext.fileAccess}
            label={t('extensions.access.fileUrls')}
            onChange={(v) => void run(() => rpc('extensions.setFileAccess', ext.id, v))}
          />
        </Row>
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="flex-1">{t('extensions.access.sites')}</span>
            <span className="text-[12.5px] text-[var(--text-2)]">
              {broad
                ? t('extensions.access.allSites')
                : hosts.length > 0
                  ? t('extensions.access.someSites')
                  : t('extensions.access.noSites')}
            </span>
          </div>
          {broad && (
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--danger)]">
              <Icon name="warning" size={13} strokeWidth={1.9} />
              {t('extensions.access.broad')}
            </p>
          )}
          {!broad && hosts.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {hosts.map((h) => (
                <code
                  key={h}
                  className="rounded-[5px] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line)]"
                >
                  {h}
                </code>
              ))}
            </div>
          )}
        </div>
      </Section>

      {ext.commands.length > 0 && (
        <Section title={t('extensions.shortcuts.title')} description={t('extensions.shortcuts.hint')}>
          {ext.commands.map((c) => (
            <Row key={c.name} label={commandLabel(c, t)}>
              <ShortcutRecorder ext={ext} command={c} />
            </Row>
          ))}
        </Section>
      )}

      <Section title={t('extensions.permissions.title')}>
        {ext.permissions.length === 0 ? (
          <div className="px-4 py-3 text-[12.5px] text-[var(--text-3)]">{t('extensions.permissions.none')}</div>
        ) : (
          <ul className="flex flex-col py-1.5">
            {[...new Set(ext.permissions)].map((p) => (
              <li key={p} className="flex items-center gap-3 px-4 py-1.5">
                <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--ink-faint)]" aria-hidden />
                <span className="min-w-0 flex-1 text-[13px]">{Object.hasOwn(PERMISSIONS, p) ? t(PERMISSIONS[p]!) : p}</span>
                <code className="shrink-0 font-mono text-[11px] text-[var(--text-3)]">{p}</code>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {details && details.errors.length > 0 && (
        <Section
          title={t('extensions.errors.title')}
          action={
            ext.errorCount > (ext.error ? 1 : 0) && (
              <SmallButton onClick={() => send('extensions.clearErrors', ext.id)}>{t('extensions.errors.clear')}</SmallButton>
            )
          }
        >
          {details.errors.map((e, i) => (
            <ErrorRow key={`${e.at}-${i}`} error={e} />
          ))}
        </Section>
      )}

      <Section title={t('extensions.details.title')}>
        <Row label={t('extensions.details.id')}>
          <code className="font-mono text-[12px] text-[var(--text-2)]">{ext.id}</code>
          <IconButton
            icon="copy"
            label={t('extensions.details.copyId')}
            onClick={() => void navigator.clipboard.writeText(ext.id).then(() => toast(t('extensions.details.copied')))}
          />
        </Row>
        <Row
          label={t('extensions.details.source')}
          hint={
            ext.fromStore
              ? undefined
              : details && !details.sourceExists
                ? t('extensions.details.sourceGone')
                : t('extensions.details.sourceHint')
          }
        >
          {ext.fromStore && details?.storeUrl ? (
            <IconButton
              icon="external"
              label={t('extensions.details.openStore')}
              onClick={() => send('tabs.create', { url: details.storeUrl! })}
            />
          ) : (
            <>
              <span className="max-w-[260px] truncate font-mono text-[11.5px] text-[var(--text-3)]" title={ext.sourcePath} dir="rtl">
                {ext.sourcePath}
              </span>
              <IconButton icon="folder" label={t('extensions.details.reveal')} onClick={() => send('extensions.reveal', ext.id)} />
            </>
          )}
        </Row>
        <Row label={t('extensions.details.installed')}>
          <InstalledAt at={ext.installedAt} />
        </Row>
        <Row label={t('extensions.details.size')}>
          <span className="text-[12.5px] tabular-nums text-[var(--text-2)]">{details ? formatBytes(details.size) : '—'}</span>
        </Row>
      </Section>
    </PageLayout>
  )
}

/** Size, source and errors, fetched again whenever the extension changes. */
function useDetails(id: string, ext: ExtensionInfo | undefined): Details | null {
  const [details, setDetails] = useState<Details | null>(null)
  const version = ext ? `${ext.version}|${ext.errorCount}|${ext.enabled}|${ext.error ?? ''}` : ''
  useEffect(() => {
    let alive = true
    rpc('extensions.details', id).then(
      (d) => alive && setDetails(d),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [id, version])
  return details
}

function commandLabel(c: ExtensionCommand, t: ReturnType<typeof useT>): string {
  if (c.name === '_execute_action' || c.name === '_execute_browser_action' || c.name === '_execute_page_action') {
    return c.description || t('extensions.shortcuts.activate')
  }
  if (c.name === '_execute_side_panel') return c.description || t('extensions.shortcuts.sidePanel')
  return c.description || c.name
}

/**
 * Click, then press keys. While recording, the browser's and extensions'
 * own shortcuts stand down (main is told), so ⌘-combinations reach it.
 */
function ShortcutRecorder({ ext, command }: { ext: ExtensionInfo; command: ExtensionCommand }) {
  const t = useT()
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!recording) return
    send('extensions.recordShortcut', true)
    const stop = () => setRecording(false)
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey
      if (e.key === 'Escape' && plain) return stop()
      if ((e.key === 'Backspace' || e.key === 'Delete') && plain && !e.shiftKey) {
        void rpc('extensions.setShortcut', ext.id, command.name, '')
        return stop()
      }
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return
      const shortcut = shortcutFromKey({
        code: e.code,
        meta: e.metaKey,
        control: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey
      })
      if (!shortcut) {
        setProblem(t('extensions.shortcuts.invalid'))
        return
      }
      void rpc('extensions.setShortcut', ext.id, command.name, shortcut).then((result) => {
        if (result === 'ok') stop()
        else
          setProblem(
            result === 'reserved'
              ? t('extensions.shortcuts.reserved', {
                  keys: formatShortcut(shortcut)
                })
              : t('extensions.shortcuts.invalid')
          )
      })
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', stop)
      send('extensions.recordShortcut', false)
    }
  }, [recording, ext.id, command.name, t])

  const label = recording
    ? t('extensions.shortcuts.recording')
    : command.shortcut
      ? formatShortcut(command.shortcut)
      : t('extensions.shortcuts.none')
  return (
    <div className="flex items-center gap-2">
      {recording && problem && (
        <span className="anim-fade max-w-[220px] text-right text-[11.5px] leading-snug text-[var(--danger)]">{problem}</span>
      )}
      <button
        ref={ref}
        aria-label={t('extensions.shortcuts.record', {
          command: command.description || command.name
        })}
        onClick={() => {
          setProblem(null)
          setRecording((v) => !v)
        }}
        onBlur={() => setRecording(false)}
        className={`h-7 min-w-[84px] rounded-[7px] px-2.5 text-[12.5px] tabular-nums transition-[box-shadow,background-color,scale] duration-150 ease-out active:scale-[0.96] ${
          recording
            ? 'bg-[var(--accent-soft)] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--focus)]'
            : command.shortcut
              ? 'bg-[var(--surface)] font-medium tracking-[0.04em] text-[var(--text)] shadow-[inset_0_0_0_1px_var(--line),0_0.5px_1px_rgb(0_0_0/0.04)] hover:bg-[color-mix(in_oklch,var(--surface)_92%,var(--text))]'
              : 'text-[var(--text-3)] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--hover)]'
        }`}
      >
        {label}
      </button>
    </div>
  )
}

function ErrorRow({ error }: { error: ExtensionError }) {
  const t = useT()
  const locale = useLocale()
  const file = error.source ? error.source.replace(/^chrome-extension:\/\/[a-p]{32}\//, '') : ''
  return (
    <div className="flex flex-col gap-1 px-4 py-2.5">
      <p className="line-clamp-4 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[var(--danger)]">
        {error.message}
      </p>
      <p className="flex flex-wrap gap-x-1.5 text-[11.5px] tabular-nums text-[var(--text-3)]">
        {error.at === 0 ? (
          <span>{t('extensions.errors.load')}</span>
        ) : (
          <>
            {file && (
              <span className="font-mono">
                {file}
                {error.line ? `:${error.line}` : ''}
              </span>
            )}
            <span>
              {new Date(error.at).toLocaleTimeString(locale, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
              })}
            </span>
            {error.count > 1 && <span>{t('extensions.errors.repeat', { count: error.count })}</span>}
          </>
        )}
      </p>
    </div>
  )
}

function InstalledAt({ at }: { at: number }) {
  const locale = useLocale()
  return (
    <span className="text-[12.5px] tabular-nums text-[var(--text-2)]">
      {new Date(at).toLocaleDateString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      })}
    </span>
  )
}

function IconButton({ icon, label, onClick }: { icon: 'copy' | 'external' | 'folder'; label: string; onClick: () => void }) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-[7px] text-[var(--ink)] transition-[scale,background-color,color] duration-150 ease-out hover:bg-[var(--hover)] hover:text-[var(--ink-strong)] active:scale-[0.96] active:bg-[var(--press)]"
    >
      <Icon name={icon} size={14} strokeWidth={1.8} />
    </button>
  )
}
