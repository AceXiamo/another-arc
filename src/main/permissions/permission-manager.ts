import { randomUUID } from 'node:crypto'
import { systemPreferences, type Session, type WebContents } from 'electron'
import type { PermissionDecision, PermissionKind, PermissionPrompt, SitePermission, TabId } from '@shared/types'
import { originOf } from '@shared/url'
import type { Database } from '../persistence/database'

/** Granted without asking — harmless or gated by a user gesture already. */
const AUTO_ALLOW = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'mediaKeySystem',
  'persistent-storage',
  'background-sync',
  'speaker-selection',
  'screen-wake-lock'
])

/** Asked once per origin; the decision can be remembered. */
const PROMPTABLE = new Set<PermissionKind>([
  'media',
  'geolocation',
  'notifications',
  'midiSysex',
  'clipboard-read',
  'idle-detection',
  'window-management',
  'storage-access',
  'top-level-storage-access',
  'fileSystem',
  'openExternal'
])

/** Extensions may use these without prompting (declared in their manifest). */
const EXTENSION_ALLOW = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])

interface Pending {
  prompt: PermissionPrompt
  resolve: (granted: boolean) => void
  cleanup: () => void
}

export interface PermissionHost {
  tabIdFor(wc: WebContents): TabId | undefined
  promptsChanged(prompts: PermissionPrompt[]): void
}

/**
 * Per-origin permission decisions. Nothing is granted to a site by default;
 * remembered decisions live in SQLite, one-off ones only for the session.
 */
export class PermissionManager {
  private readonly stored = new Map<string, PermissionDecision>()
  private readonly sessionOnly = new Map<string, PermissionDecision>()
  private readonly pending = new Map<string, Pending>()
  private readonly attached = new WeakSet<Session>()

  constructor(
    private readonly db: Database,
    private readonly host: PermissionHost
  ) {
    for (const r of db.all<{ origin: string; permission: string; decision: PermissionDecision }>(
      'SELECT origin, permission, decision FROM site_permissions'
    )) {
      this.stored.set(key(r.origin, r.permission), r.decision)
    }
  }

  attach(session: Session): void {
    if (this.attached.has(session)) return
    this.attached.add(session)

    session.setPermissionRequestHandler((wc, permission, callback, details) => {
      const origin = originOf(details.requestingUrl ?? wc.getURL())
      if (!origin) return callback(false)
      if (origin.startsWith('chrome-extension://')) return callback(EXTENSION_ALLOW.has(permission))
      if (AUTO_ALLOW.has(permission)) return callback(true)
      if (!PROMPTABLE.has(permission as PermissionKind)) return callback(false)
      const kind = permission as PermissionKind
      const media = { mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined }
      const known = this.decision(origin, kind)
      if (known) return this.grant(kind, known === 'allow', media, callback)

      const extra: string[] = []
      if ('mediaTypes' in details && details.mediaTypes) {
        for (const t of details.mediaTypes) extra.push(t === 'video' ? 'camera' : 'microphone')
      }
      if ('externalURL' in details && details.externalURL) extra.push(details.externalURL)
      void this.ask(wc, origin, kind, extra).then((granted) => this.grant(kind, granted, media, callback))
    })

    session.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      const origin = originOf(requestingOrigin) ?? (wc ? originOf(wc.getURL()) : null)
      if (!origin) return false
      if (origin.startsWith('chrome-extension://')) return EXTENSION_ALLOW.has(permission)
      if (AUTO_ALLOW.has(permission)) return true
      return this.decision(origin, permission as PermissionKind) === 'allow'
    })

    // getDisplayMedia: the macOS 15 system picker handles source selection.
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true })
  }

  respond(promptId: string, decision: PermissionDecision, remember: boolean): void {
    const p = this.pending.get(promptId)
    if (!p) return
    const { origin, permission } = p.prompt
    if (remember) this.save(origin, permission, decision)
    else this.sessionOnly.set(key(origin, permission), decision)
    this.settle(promptId, decision === 'allow')
  }

  list(): SitePermission[] {
    return this.db
      .all<{ origin: string; permission: string; decision: PermissionDecision; updated_at: number }>(
        'SELECT * FROM site_permissions ORDER BY origin, permission'
      )
      .map((r) => ({
        origin: r.origin,
        permission: r.permission as PermissionKind,
        decision: r.decision,
        updatedAt: r.updated_at
      }))
  }

  reset(origin: string, permission: string): void {
    this.stored.delete(key(origin, permission))
    this.sessionOnly.delete(key(origin, permission))
    this.db.run('DELETE FROM site_permissions WHERE origin = ? AND permission = ?', origin, permission)
  }

  prompts(): PermissionPrompt[] {
    return [...this.pending.values()].map((p) => p.prompt)
  }

  private decision(origin: string, permission: PermissionKind): PermissionDecision | undefined {
    const k = key(origin, permission)
    return this.sessionOnly.get(k) ?? this.stored.get(k)
  }

  private save(origin: string, permission: string, decision: PermissionDecision): void {
    this.stored.set(key(origin, permission), decision)
    this.db.run(
      `INSERT INTO site_permissions (origin, permission, decision, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(origin, permission) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`,
      origin,
      permission,
      decision,
      Date.now()
    )
  }

  private ask(wc: WebContents, origin: string, permission: PermissionKind, details: string[]): Promise<boolean> {
    // Collapse duplicate requests from the same page into one prompt.
    for (const p of this.pending.values()) {
      if (p.prompt.origin === origin && p.prompt.permission === permission) {
        return new Promise((resolve) => {
          const previous = p.resolve
          p.resolve = (granted) => {
            previous(granted)
            resolve(granted)
          }
        })
      }
    }
    return new Promise((resolve) => {
      const id = randomUUID()
      const deny = () => this.settle(id, false)
      const onNavigate = (_e: unknown, url: string) => {
        if (originOf(url) !== origin) deny()
      }
      wc.once('destroyed', deny)
      wc.on('did-navigate', onNavigate)
      const prompt: PermissionPrompt = { id, tabId: this.host.tabIdFor(wc) ?? null, origin, permission, details }
      this.pending.set(id, {
        prompt,
        resolve,
        cleanup: () => {
          wc.removeListener('destroyed', deny)
          wc.removeListener('did-navigate', onNavigate)
        }
      })
      this.host.promptsChanged(this.prompts())
    })
  }

  private settle(id: string, granted: boolean): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    p.cleanup()
    p.resolve(granted)
    this.host.promptsChanged(this.prompts())
  }

  /** Media also needs macOS (TCC) consent for the app itself. */
  private grant(
    permission: PermissionKind,
    granted: boolean,
    details: { mediaTypes?: Array<'video' | 'audio'> },
    callback: (granted: boolean) => void
  ): void {
    if (!granted || permission !== 'media' || !details.mediaTypes?.length) return callback(granted)
    const asks = details.mediaTypes.map((t) =>
      systemPreferences.askForMediaAccess(t === 'video' ? 'camera' : 'microphone')
    )
    Promise.all(asks)
      .then((results) => callback(results.every(Boolean)))
      .catch(() => callback(false))
  }
}

function key(origin: string, permission: string): string {
  return `${origin}|${permission}`
}
