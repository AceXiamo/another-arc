import { app, session, type Session } from 'electron'
import { DEFAULT_PROFILE_ID } from '@shared/defaults'
import type { ProfileId } from '@shared/types'
import type { ProfileRecord } from '../persistence/records'
import type { SessionStore } from '../persistence/session-store'

/**
 * A profile is an isolated browsing session (cookies, cache, storage,
 * extensions). Every space points at one; all spaces share the default
 * profile today, and per-space isolation only needs another record here.
 */
export class ProfileManager {
  private readonly profiles = new Map<ProfileId, ProfileRecord>()
  private readonly configured = new WeakSet<Session>()
  private onSessionCreated: ((profile: ProfileRecord, ses: Session) => void) | null = null

  constructor(private readonly store: SessionStore) {
    for (const p of store.loadProfiles()) this.profiles.set(p.id, p)
    if (!this.profiles.has(DEFAULT_PROFILE_ID)) {
      const profile: ProfileRecord = {
        id: DEFAULT_PROFILE_ID,
        name: 'Default',
        partition: 'persist:default',
        createdAt: Date.now()
      }
      store.saveProfile(profile)
      this.profiles.set(profile.id, profile)
    }
  }

  /** Called once per session the first time it is used (permissions, downloads…). */
  setSessionInitializer(fn: (profile: ProfileRecord, ses: Session) => void): void {
    this.onSessionCreated = fn
  }

  get(id: ProfileId): ProfileRecord {
    return this.profiles.get(id) ?? this.profiles.get(DEFAULT_PROFILE_ID)!
  }

  all(): ProfileRecord[] {
    return [...this.profiles.values()]
  }

  sessionFor(id: ProfileId): Session {
    const profile = this.get(id)
    const ses = session.fromPartition(profile.partition)
    if (!this.configured.has(ses)) {
      this.configured.add(ses)
      configureSession(ses)
      this.onSessionCreated?.(profile, ses)
    }
    return ses
  }

  defaultSession(): Session {
    return this.sessionFor(DEFAULT_PROFILE_ID)
  }
}

/**
 * Present a plain Chrome user agent. Electron's default UA advertises
 * "Electron/x" and the app name, which some sites (notably Google sign-in)
 * treat as an embedded, unsupported browser.
 */
export function chromeUserAgent(): string {
  const chrome = process.versions.chrome
  const major = chrome.split('.')[0]
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function acceptLanguages(): string {
  const locale = app.getLocale() || 'en-US'
  const langs = [locale, locale.split('-')[0]!, 'en-US', 'en']
  return [...new Set(langs)].join(',')
}

function configureSession(ses: Session): void {
  ses.setUserAgent(chromeUserAgent(), acceptLanguages())
}
