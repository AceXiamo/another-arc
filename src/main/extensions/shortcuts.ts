// chrome.commands keyboard shortcuts. electron-chrome-extensions lists an
// extension's commands but binds none and never fires commands.onCommand;
// this module does the binding. Shortcuts use Chrome's manifest syntax
// ("Command+Shift+Y", "MacCtrl+Alt+K"), so a manifest's suggested_key and a
// shortcut the user picked are stored and compared the same way.
//
// Matching runs in before-input-event for every page and the shell (after
// the browser's reserved shortcuts), keyed by physical key code like
// keymap.ts.

import { parseShortcut, signature } from '@shared/shortcuts'
import type { ExtensionCommand } from '@shared/types'
import type { KeyLike } from '../shortcuts/keymap'

export { formatShortcut, parseShortcut, shortcutFromKey } from '@shared/shortcuts'

export interface ManifestCommand {
  name: string
  description: string
  /** Chrome syntax, '' when the manifest suggests none. */
  suggested: string
  global: boolean
}

export class ExtensionShortcuts {
  private readonly manifests = new Map<string, ManifestCommand[]>()
  /** User choices: extension id → command name → Chrome syntax ('' = none). */
  private readonly overrides = new Map<string, Map<string, string>>()
  private readonly index = new Map<string, { id: string; name: string }>()

  constructor(
    initial: unknown,
    private readonly persist: (all: Record<string, Record<string, string>>) => void
  ) {
    if (!initial || typeof initial !== 'object') return
    for (const [id, raw] of Object.entries(initial as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const map = new Map<string, string>()
      for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string' && (value === '' || parseShortcut(value))) map.set(name, value)
      }
      if (map.size > 0) this.overrides.set(id, map)
    }
  }

  /** The extension's manifest commands (on load); [] when it is unloaded. */
  setCommands(id: string, commands: ManifestCommand[]): void {
    if (commands.length > 0) this.manifests.set(id, commands)
    else this.manifests.delete(id)
    this.rebuild()
  }

  /** Uninstalled: forget the user's choices too. */
  forget(id: string): void {
    this.manifests.delete(id)
    if (this.overrides.delete(id)) this.save()
    this.rebuild()
  }

  list(id: string): ExtensionCommand[] {
    return (this.manifests.get(id) ?? []).map((c) => ({
      name: c.name,
      description: c.description,
      shortcut: this.effective(id, c),
      global: c.global
    }))
  }

  /**
   * Set (or with '' clear) a command's shortcut. A shortcut another command
   * holds moves here, as Chrome's shortcut page does. Returns the ids whose
   * shortcuts changed, or null when `shortcut` is not a valid shortcut.
   */
  set(id: string, name: string, shortcut: string): string[] | null {
    if (shortcut !== '' && !parseShortcut(shortcut)) return null
    if (!this.manifests.get(id)?.some((c) => c.name === name)) return []
    const changed = new Set([id])
    if (shortcut !== '') {
      const owner = this.index.get(signature(parseShortcut(shortcut)!))
      if (owner && !(owner.id === id && owner.name === name)) {
        this.override(owner.id, owner.name, '')
        changed.add(owner.id)
      }
    }
    this.override(id, name, shortcut)
    this.save()
    this.rebuild()
    return [...changed]
  }

  /** The command bound to a keyDown, if any. */
  match(input: KeyLike): { id: string; name: string } | null {
    if (input.type !== 'keyDown' || this.index.size === 0) return null
    if (!input.meta && !input.control && !input.alt) return null
    return this.index.get(`${input.meta ? 'M' : ''}${input.control ? 'C' : ''}${input.alt ? 'A' : ''}${input.shift ? 'S' : ''}:${input.code}`) ?? null
  }

  private effective(id: string, c: ManifestCommand): string {
    return this.overrides.get(id)?.get(c.name) ?? c.suggested
  }

  private override(id: string, name: string, shortcut: string): void {
    let map = this.overrides.get(id)
    if (!map) this.overrides.set(id, (map = new Map()))
    map.set(name, shortcut)
  }

  private rebuild(): void {
    this.index.clear()
    for (const [id, commands] of this.manifests) {
      for (const c of commands) {
        const parsed = parseShortcut(this.effective(id, c))
        // First come, first served, as Chrome assigns suggested keys.
        if (parsed && !this.index.has(signature(parsed))) this.index.set(signature(parsed), { id, name: c.name })
      }
    }
  }

  private save(): void {
    this.persist(Object.fromEntries([...this.overrides].map(([id, map]) => [id, Object.fromEntries(map)])))
  }
}
