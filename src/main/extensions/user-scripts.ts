// chrome.userScripts, kept by the main process.
//
// Electron 44 has no userScripts API. The compat preload adds it (see
// src/preload/extension-compat.ts) and builds it on the extension's own
// chrome.scripting dynamic content scripts, which Chromium injects natively:
// at document_start, into every frame, with no IPC per page load. What that
// needs from main lives here:
//
//   - The registry: what chrome.userScripts.getScripts() returns, with the
//     code. It persists across restarts (Chrome keeps user scripts in
//     extension prefs); Electron forgets dynamic content scripts on quit, so
//     the preload registers them again whenever the extension starts.
//   - Code as files. Content scripts name files inside the extension, so
//     every `{ code }` source is written into the installed copy (ours, see
//     installer.ts) as `arc_user_scripts/<hash>.js`. The code itself is kept
//     outside the copy too, since an update replaces the copy.
//   - includeGlobs / excludeGlobs, which dynamic content scripts lack: the
//     file runs its code only when the URL passes the globs.
//
// The USER_SCRIPT world is a world the page preload creates with the CSP
// from configureWorld; the files hand their code to it through a bridge (see
// src/shared/user-script-world.ts). Where the preload does not run
// (subframes), the code runs in the extension's isolated world instead.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { bridgeSource, wrapForWorld, type WorldConfig } from '@shared/user-script-world'
import { isInside } from './installer'
import { parsePattern } from './match-pattern'

export type RunAt = 'document_start' | 'document_end' | 'document_idle'
export type ExecutionWorld = 'MAIN' | 'USER_SCRIPT'

export interface ScriptSource {
  code?: string
  file?: string
}

/** chrome.userScripts.RegisteredUserScript */
export interface UserScript {
  id: string
  matches?: string[]
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
  js?: ScriptSource[]
  allFrames?: boolean
  runAt?: RunAt
  world?: ExecutionWorld
  worldId?: string
}

/** chrome.userScripts.WorldProperties */
export interface WorldProperties {
  worldId?: string
  csp?: string
  messaging?: boolean
}

/** chrome.scripting.RegisteredContentScript, as the preload registers it. */
export interface NativeScript {
  id: string
  matches: string[]
  excludeMatches: string[]
  js: string[]
  allFrames: boolean
  runAt: RunAt
  world: 'MAIN' | 'ISOLATED'
  persistAcrossSessions: false
}

/** Native content script ids carry this prefix; the preload hides them from chrome.scripting. */
export const NATIVE_PREFIX = 'arc-us-'
/** The bridge's native id (user script ids cannot start with "_"). */
const BRIDGE_ID = `${NATIVE_PREFIX}_bridge`
/** Generated files, inside the installed copy. No leading "_": Chromium reserves those names. */
export const FILES_DIR = 'arc_user_scripts'
/** A file written for userScripts.execute() is safe from cleanup this long. */
const EXECUTE_GRACE_MS = 60_000
const SAVE_DELAY_MS = 300
const RUN_AT: readonly RunAt[] = ['document_start', 'document_end', 'document_idle']

/** A stored source: `code` is the hash of the code in the blob store. */
type StoredSource = { code: string } | { file: string }

interface StoredScript extends Omit<UserScript, 'js'> {
  js: StoredSource[]
  /** The native script's files (relative to the installed copy). */
  files: string[]
  /** The world properties the files were written for (they embed them). */
  filesFor?: string
}

interface Entry {
  scripts: StoredScript[]
  worlds: WorldProperties[]
  /** The bridge's file, when a USER_SCRIPT world script needs one. */
  bridge?: string
}

interface Prepared {
  op: 'register' | 'update'
  scripts: StoredScript[]
}

export class UserScriptError extends Error {}

export class UserScriptStore {
  private readonly entries = new Map<string, Promise<Entry>>()
  /** Entries once read, for the synchronous flush on quit. */
  private readonly loaded = new Map<string, Entry>()
  private readonly prepared = new Map<string, Map<string, Prepared>>()
  private readonly saveTimers = new Map<string, NodeJS.Timeout>()
  /**
   * Code files known to exist in our own store. Not files in the installed
   * copy: an update replaces that folder.
   */
  private readonly written = new Set<string>()
  private readonly executeFiles = new Map<string, number>()

  constructor(
    /** Folder for the registry and the code, one file and one folder per extension. */
    private readonly root: string,
    /** The extension's installed copy, or null when it is not installed. */
    private readonly installDir: (id: string) => string | null
  ) {}

  async count(id: string): Promise<number> {
    return (await this.entry(id)).scripts.length
  }

  /** chrome.userScripts.getScripts(filter) */
  async get(id: string, rawFilter: unknown): Promise<UserScript[]> {
    const ids = filterIds(rawFilter)
    const entry = await this.entry(id)
    const scripts = ids ? entry.scripts.filter((s) => ids.includes(s.id)) : entry.scripts
    return Promise.all(scripts.map((s) => this.toPublic(id, s)))
  }

  /**
   * Validate register() or update() and write the files, without changing
   * the registry: the preload registers the native scripts first and then
   * commits, so a native failure leaves nothing behind.
   */
  async prepare(id: string, op: 'register' | 'update', raw: unknown): Promise<{ token: string; native: NativeScript[] }> {
    if (!Array.isArray(raw)) throw new UserScriptError('Expected an array of scripts.')
    const entry = await this.entry(id)
    const seen = new Set<string>()
    const scripts: StoredScript[] = []
    for (const item of raw) {
      const input = item as UserScript
      const scriptId = checkId(input?.id)
      if (seen.has(scriptId)) throw new UserScriptError(`Duplicate script ID '${scriptId}'`)
      seen.add(scriptId)
      const existing = entry.scripts.find((s) => s.id === scriptId)
      if (op === 'register' && existing) throw new UserScriptError(`Duplicate script ID '${scriptId}'`)
      if (op === 'update' && !existing) throw new UserScriptError(`Script with ID '${scriptId}' does not exist or is not fully registered`)
      scripts.push(await this.normalize(id, input, existing))
    }
    const token = randomUUID()
    let map = this.prepared.get(id)
    if (!map) this.prepared.set(id, (map = new Map()))
    map.set(token, { op, scripts })
    return { token, native: scripts.map(toNative) }
  }

  async commit(id: string, token: string): Promise<void> {
    const prepared = this.prepared.get(id)?.get(token)
    if (!prepared) return
    this.prepared.get(id)!.delete(token)
    const entry = await this.entry(id)
    for (const script of prepared.scripts) {
      const i = entry.scripts.findIndex((s) => s.id === script.id)
      if (i >= 0) entry.scripts[i] = script
      else entry.scripts.push(script)
    }
    this.save(id)
  }

  discard(id: string, token: string): void {
    this.prepared.get(id)?.delete(token)
  }

  /** chrome.userScripts.unregister(filter): the ids removed. */
  async unregister(id: string, rawFilter: unknown): Promise<string[]> {
    const ids = filterIds(rawFilter)
    const entry = await this.entry(id)
    if (ids) {
      for (const scriptId of ids) {
        if (!entry.scripts.some((s) => s.id === scriptId)) throw new UserScriptError(`Nonexistent script ID '${scriptId}'`)
      }
    }
    const removed = entry.scripts.filter((s) => !ids || ids.includes(s.id)).map((s) => s.id)
    if (removed.length === 0) return []
    entry.scripts = entry.scripts.filter((s) => !removed.includes(s.id))
    this.save(id)
    return removed
  }

  /**
   * Every registered script as a native content script, with its files in
   * place, after the bridge when a script runs in the USER_SCRIPT world.
   */
  async native(id: string): Promise<NativeScript[]> {
    const entry = await this.entry(id)
    const dir = this.installDir(id)
    if (!dir) return []
    const worlds = worldsKey(entry)
    const out: NativeScript[] = []
    for (const script of entry.scripts) {
      let ok = script.filesFor === worlds || script.world === 'MAIN'
      for (const file of ok ? script.files : []) {
        if (!(await this.exists(join(dir, file)))) {
          ok = false
          break
        }
      }
      if (!ok) {
        // The world properties changed, or the installed copy was replaced
        // (an update): write the files again.
        try {
          script.files = await this.materialize(id, script.js, script)
          script.filesFor = worlds
        } catch (error) {
          console.warn(`[user-scripts] ${id}: cannot restore '${script.id}'`, error)
          continue
        }
        this.save(id)
      }
      out.push(toNative(script))
    }
    if (entry.scripts.some((s) => s.world !== 'MAIN')) {
      entry.bridge = await this.writeFile(dir, bridgeSource(worldConfigs(entry)))
      out.unshift({
        id: BRIDGE_ID,
        matches: ['<all_urls>'],
        excludeMatches: [],
        js: [entry.bridge],
        allFrames: true,
        // Before any page script: the channel is announced then.
        runAt: 'document_start',
        world: 'ISOLATED',
        persistAcrossSessions: false
      })
    }
    return out
  }

  // -- worlds ------------------------------------------------------------------------

  async configureWorld(id: string, raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') throw new UserScriptError('Expected world properties.')
    const props = raw as WorldProperties
    const world: WorldProperties = {}
    if (props.worldId !== undefined) world.worldId = checkWorldId(props.worldId)
    if (props.csp !== undefined) {
      if (typeof props.csp !== 'string') throw new UserScriptError("'csp' must be a string.")
      world.csp = props.csp
    }
    if (props.messaging !== undefined) world.messaging = props.messaging === true
    const entry = await this.entry(id)
    entry.worlds = entry.worlds.filter((w) => (w.worldId ?? '') !== (world.worldId ?? ''))
    entry.worlds.push(world)
    this.save(id)
  }

  async worlds(id: string): Promise<WorldProperties[]> {
    return (await this.entry(id)).worlds.map((w) => ({ ...w }))
  }

  async resetWorld(id: string, worldId: unknown): Promise<void> {
    const key = worldId === undefined || worldId === null ? '' : checkWorldId(worldId)
    const entry = await this.entry(id)
    const before = entry.worlds.length
    entry.worlds = entry.worlds.filter((w) => (w.worldId ?? '') !== key)
    if (entry.worlds.length !== before) this.save(id)
  }

  // -- execute -----------------------------------------------------------------------

  /** chrome.userScripts.execute(injection): the files and world for chrome.scripting.executeScript. */
  async prepareExecute(id: string, raw: unknown): Promise<{ files: string[]; world: 'MAIN' | 'ISOLATED' }> {
    const injection = raw as { js?: unknown; world?: unknown; worldId?: unknown }
    if (!injection || typeof injection !== 'object') throw new UserScriptError('Expected an injection.')
    const sources = checkSources('execute', injection.js)
    const world = checkWorld(injection.world)
    if (injection.worldId !== undefined) checkWorldId(injection.worldId)
    const stored = await Promise.all(sources.map((s) => this.storeSource(id, s)))
    const files = await this.materialize(id, stored, null)
    const now = Date.now()
    for (const file of files) this.executeFiles.set(`${id}/${file}`, now)
    return { files, world: world === 'MAIN' ? 'MAIN' : 'ISOLATED' }
  }

  // -- lifecycle ---------------------------------------------------------------------

  /** The extension was uninstalled: drop its scripts and code. */
  async forget(id: string): Promise<void> {
    clearTimeout(this.saveTimers.get(id))
    this.saveTimers.delete(id)
    this.entries.delete(id)
    this.loaded.delete(id)
    this.prepared.delete(id)
    await rm(this.registryPath(id), { force: true })
    await rm(this.blobDir(id), { recursive: true, force: true })
  }

  /** Write pending registry changes now: the app is quitting. */
  flushSync(): void {
    for (const [id, timer] of this.saveTimers) {
      clearTimeout(timer)
      const entry = this.loaded.get(id)
      if (!entry) continue
      try {
        mkdirSync(this.root, { recursive: true })
        const path = this.registryPath(id)
        writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(entry))
        renameSync(`${path}.${process.pid}.tmp`, path)
      } catch (error) {
        console.error('[user-scripts] save failed', error)
      }
    }
    this.saveTimers.clear()
  }

  // -- internals ---------------------------------------------------------------------

  private entry(id: string): Promise<Entry> {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = this.read(id).then((e) => {
        this.loaded.set(id, e)
        return e
      })
      this.entries.set(id, entry)
    }
    return entry
  }

  private async read(id: string): Promise<Entry> {
    try {
      const raw = JSON.parse(await readFile(this.registryPath(id), 'utf8')) as Partial<Entry>
      return {
        scripts: Array.isArray(raw.scripts) ? raw.scripts.filter((s) => typeof s?.id === 'string' && Array.isArray(s.js)) : [],
        worlds: Array.isArray(raw.worlds) ? raw.worlds.filter((w) => w && typeof w === 'object') : []
      }
    } catch {
      return { scripts: [], worlds: [] }
    }
  }

  private save(id: string): void {
    clearTimeout(this.saveTimers.get(id))
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id)
        void this.write(id).catch((error) => console.error('[user-scripts] save failed', error))
      }, SAVE_DELAY_MS)
    )
  }

  private async write(id: string): Promise<void> {
    const entry = await this.entries.get(id)
    if (!entry) return
    await mkdir(this.root, { recursive: true })
    const path = this.registryPath(id)
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(entry))
    await rename(tmp, path)
    await this.collect(id, entry)
  }

  /** Delete code and files nothing refers to any more. */
  private async collect(id: string, entry: Entry): Promise<void> {
    const pending = [...(this.prepared.get(id)?.values() ?? [])].flatMap((p) => p.scripts)
    const all = [...entry.scripts, ...pending]
    const blobs = new Set(all.flatMap((s) => s.js.flatMap((src) => ('code' in src ? [src.code] : []))))
    const files = new Set(all.flatMap((s) => s.files))
    if (entry.bridge) files.add(entry.bridge)
    const now = Date.now()
    for (const [key, at] of this.executeFiles) {
      if (now - at > EXECUTE_GRACE_MS) this.executeFiles.delete(key)
      else if (key.startsWith(`${id}/`)) files.add(key.slice(id.length + 1))
    }
    for (const name of await readdir(this.blobDir(id)).catch(() => [] as string[])) {
      if (blobs.has(name.replace(/\.js$/, ''))) continue
      await rm(join(this.blobDir(id), name), { force: true })
      this.written.delete(join(this.blobDir(id), name))
    }
    const dir = this.installDir(id)
    if (!dir) return
    for (const name of await readdir(join(dir, FILES_DIR)).catch(() => [] as string[])) {
      const rel = `${FILES_DIR}/${name}`
      if (!files.has(rel)) await rm(join(dir, rel), { force: true })
    }
  }

  /** Validate one script of register() / update() and write its files. */
  private async normalize(id: string, input: UserScript, existing: StoredScript | undefined): Promise<StoredScript> {
    const scriptId = input.id
    const out: StoredScript = existing ? { ...existing } : { id: scriptId, js: [], files: [] }
    if (input.matches !== undefined) out.matches = checkStrings(input.matches, 'matches')
    if (input.excludeMatches !== undefined) out.excludeMatches = checkStrings(input.excludeMatches, 'excludeMatches')
    if (input.includeGlobs !== undefined) out.includeGlobs = checkStrings(input.includeGlobs, 'includeGlobs')
    if (input.excludeGlobs !== undefined) out.excludeGlobs = checkStrings(input.excludeGlobs, 'excludeGlobs')
    if (input.allFrames !== undefined) out.allFrames = input.allFrames === true
    if (input.runAt !== undefined) {
      if (!RUN_AT.includes(input.runAt)) throw new UserScriptError(`Invalid 'runAt' for script '${scriptId}'.`)
      out.runAt = input.runAt
    }
    if (input.world !== undefined) out.world = checkWorld(input.world)
    if (input.worldId !== undefined) out.worldId = checkWorldId(input.worldId)
    if (!out.matches || out.matches.length === 0) throw new UserScriptError(`Script with ID '${scriptId}' must specify 'matches'.`)
    for (const pattern of [...out.matches, ...(out.excludeMatches ?? [])]) {
      if (!parsePattern(pattern)) throw new UserScriptError(`Script with ID '${scriptId}' has invalid match pattern '${pattern}'.`)
    }
    const globsChanged = input.includeGlobs !== undefined || input.excludeGlobs !== undefined
    if (input.js !== undefined) {
      const sources = checkSources(scriptId, input.js)
      out.js = await Promise.all(sources.map((s) => this.storeSource(id, s)))
    } else if (!existing) {
      throw new UserScriptError(`Script with ID '${scriptId}' must specify at least one js source.`)
    }
    const worldChanged = input.world !== undefined || input.worldId !== undefined
    if (!existing || input.js !== undefined || globsChanged || worldChanged) {
      out.files = await this.materialize(id, out.js, out)
      out.filesFor = worldsKey(await this.entry(id))
    }
    return out
  }

  private async storeSource(id: string, source: ScriptSource): Promise<StoredSource> {
    if (typeof source.file === 'string') {
      const file = normalize(source.file).replace(/^\.\//, '')
      const dir = this.installDir(id)
      if (!dir || !isInside(dir, join(dir, file)) || file.startsWith('..')) throw new UserScriptError(`Could not load file: '${source.file}'.`)
      return { file }
    }
    const code = source.code as string
    const hash = sha(code)
    const path = join(this.blobDir(id), `${hash}.js`)
    if (!(await this.exists(path))) {
      await mkdir(this.blobDir(id), { recursive: true })
      await writeFile(path, code)
      this.written.add(path)
    }
    return { code: hash }
  }

  /**
   * The native files for `sources`: generated ones for code, for globs and
   * for the USER_SCRIPT world (which wraps the code for the bridge), the
   * extension's own otherwise. `script` absent: userScripts.execute(), which
   * runs in the isolated world as is.
   */
  private async materialize(
    id: string,
    sources: StoredSource[],
    script: Pick<UserScript, 'includeGlobs' | 'excludeGlobs' | 'world' | 'worldId'> | null
  ): Promise<string[]> {
    const dir = this.installDir(id)
    if (!dir) throw new UserScriptError('The extension is not installed.')
    const guarded = Boolean(script?.includeGlobs?.length || script?.excludeGlobs?.length)
    const userWorld = script !== null && script.world !== 'MAIN'
    const bridge = userWorld ? bridgeSource(worldConfigs(await this.entry(id))) : ''
    const files: string[] = []
    for (const source of sources) {
      if ('file' in source && !guarded && !userWorld) {
        if (!(await this.exists(join(dir, source.file)))) throw new UserScriptError(`Could not load file: '${source.file}'.`)
        files.push(source.file)
        continue
      }
      const code =
        'code' in source
          ? await readFile(join(this.blobDir(id), `${source.code}.js`), 'utf8')
          : await readFile(join(dir, source.file), 'utf8').catch(() => {
              throw new UserScriptError(`Could not load file: '${source.file}'.`)
            })
      const wrapped = userWorld ? wrapForWorld(bridge, script?.worldId ?? '', code) : code
      const content = guarded ? guardWithGlobs(wrapped, script?.includeGlobs ?? [], script?.excludeGlobs ?? []) : wrapped
      files.push(await this.writeFile(dir, content))
    }
    return files
  }

  /** Write a generated file (named by its content) into the installed copy. */
  private async writeFile(dir: string, content: string): Promise<string> {
    const rel = `${FILES_DIR}/${sha(content)}.js`
    const path = join(dir, rel)
    if (!(await this.exists(path))) {
      await mkdir(join(dir, FILES_DIR), { recursive: true })
      await writeFile(path, content)
    }
    return rel
  }

  private async toPublic(id: string, s: StoredScript): Promise<UserScript> {
    const js = await Promise.all(
      s.js.map(async (src): Promise<ScriptSource> =>
        'file' in src ? { file: src.file } : { code: await readFile(join(this.blobDir(id), `${src.code}.js`), 'utf8').catch(() => '') }
      )
    )
    const out: UserScript = {
      id: s.id,
      matches: [...(s.matches ?? [])],
      js,
      allFrames: s.allFrames ?? false,
      runAt: s.runAt ?? 'document_idle',
      world: s.world ?? 'USER_SCRIPT'
    }
    if (s.excludeMatches?.length) out.excludeMatches = [...s.excludeMatches]
    if (s.includeGlobs?.length) out.includeGlobs = [...s.includeGlobs]
    if (s.excludeGlobs?.length) out.excludeGlobs = [...s.excludeGlobs]
    if (s.worldId !== undefined) out.worldId = s.worldId
    return out
  }

  private async exists(path: string): Promise<boolean> {
    if (this.written.has(path)) return true
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  }

  private registryPath(id: string): string {
    return join(this.root, `${id}.json`)
  }

  private blobDir(id: string): string {
    return join(this.root, id)
  }
}

function toNative(s: StoredScript): NativeScript {
  const out: NativeScript = {
    id: NATIVE_PREFIX + s.id,
    matches: [...(s.matches ?? [])],
    js: [...s.files],
    allFrames: s.allFrames ?? false,
    runAt: s.runAt ?? 'document_idle',
    world: s.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
    persistAcrossSessions: false,
    // Always given, so an update() that drops them clears them natively too.
    excludeMatches: [...(s.excludeMatches ?? [])]
  }
  return out
}

/** Chrome's glob: `*` is any run of characters, `?` one character, matched against the whole URL. */
export function globToRegExpSource(glob: string): string {
  let out = '^'
  for (const c of glob) {
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else out += c.replace(/[\\^$.|+()[\]{}/-]/g, '\\$&')
  }
  return `${out}$`
}

/**
 * Run `code` only where the URL passes the globs. A block, not a function,
 * so the script's top-level `var`s and functions stay global as in Chrome.
 */
export function guardWithGlobs(code: string, include: string[], exclude: string[]): string {
  const inc = JSON.stringify(include.map(globToRegExpSource))
  const exc = JSON.stringify(exclude.map(globToRegExpSource))
  return (
    `if ((function (u) {\n` +
    `  var t = function (s) { return new RegExp(s).test(u) };\n` +
    `  var i = ${inc}, e = ${exc};\n` +
    `  return (i.length === 0 || i.some(t)) && !e.some(t);\n` +
    `})(location.href)) {\n${code}\n}\n`
  )
}

/** World id ('' = default) → properties, as the bridge announces them. */
function worldConfigs(entry: Entry): Record<string, WorldConfig> {
  const out: Record<string, WorldConfig> = {}
  for (const w of entry.worlds) {
    const config: WorldConfig = {}
    if (w.csp !== undefined) config.csp = w.csp
    if (w.messaging !== undefined) config.messaging = w.messaging
    out[w.worldId ?? ''] = config
  }
  return out
}

function worldsKey(entry: Entry): string {
  return sha(JSON.stringify(worldConfigs(entry)))
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

function checkId(id: unknown): string {
  if (typeof id !== 'string' || id === '') throw new UserScriptError("Script's ID must not be empty")
  if (id.startsWith('_')) throw new UserScriptError(`Script's ID '${id}' must not start with '_'`)
  return id
}

function checkWorld(world: unknown): ExecutionWorld {
  if (world === undefined || world === 'USER_SCRIPT') return 'USER_SCRIPT'
  if (world === 'MAIN') return 'MAIN'
  throw new UserScriptError(`Invalid world '${String(world)}'.`)
}

function checkWorldId(worldId: unknown): string {
  if (typeof worldId !== 'string') throw new UserScriptError("'worldId' must be a string.")
  if (worldId.startsWith('_')) throw new UserScriptError(`World ID '${worldId}' must not start with '_'.`)
  return worldId
}

function checkStrings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new UserScriptError(`'${name}' must be an array of strings.`)
  return [...value]
}

function checkSources(scriptId: string, value: unknown): ScriptSource[] {
  if (!Array.isArray(value) || value.length === 0) throw new UserScriptError(`Script with ID '${scriptId}' must specify at least one js source.`)
  return value.map((raw) => {
    const s = raw as ScriptSource
    const hasCode = typeof s?.code === 'string'
    const hasFile = typeof s?.file === 'string'
    if (hasCode === hasFile) {
      throw new UserScriptError(`Script with ID '${scriptId}' must specify exactly one of 'code' or 'file' in each js source.`)
    }
    return hasCode ? { code: s.code } : { file: s.file }
  })
}

function filterIds(raw: unknown): string[] | null {
  const ids = (raw as { ids?: unknown } | null | undefined)?.ids
  if (ids === undefined || ids === null) return null
  if (!Array.isArray(ids) || ids.some((v) => typeof v !== 'string')) throw new UserScriptError("'ids' must be an array of strings.")
  return ids
}
