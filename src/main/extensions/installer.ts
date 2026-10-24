import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rm, copyFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LocalizedError } from '../app/i18n'

const MAX_FILES = 20_000
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
// _metadata holds Web Store signatures; Chromium refuses unpacked extensions containing it.
const SKIP = new Set(['.git', '.DS_Store', '__MACOSX', '_metadata'])
/** manifest_version values the installer accepts. */
export const SUPPORTED_MANIFEST_VERSIONS: readonly number[] = [2, 3]
/** Chromium's per-version install folder: `<version>_<n>` (e.g. `4.21.0_0`). */
const VERSION_FOLDER = /^\d+(?:\.\d+)*_\d+$/

export interface ManifestSummary {
  name: string
  version: string
  description: string
  manifestVersion: number
  hasAction: boolean
  permissions: string[]
  hostPermissions: string[]
  optionsPage: string | null
  iconPath: string | null
}

/** True when `child` is `parent` or lies inside it (after resolving `..`). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
}

/** Chrome tolerates comments in manifest.json; strip them before parsing. */
export function parseManifestText(text: string): Record<string, unknown> {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += c
    }
  }
  const value = JSON.parse(out.replace(/^﻿/, ''))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalizedError('install.notObject')
  return value as Record<string, unknown>
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return parseManifestText(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** Resolve `__MSG_key__` placeholders using the default locale. */
export async function localizeMessage(dir: string, manifest: Record<string, unknown>, value: unknown): Promise<string> {
  if (typeof value !== 'string') return ''
  const m = /^__MSG_(\w+)__$/.exec(value)
  if (!m) return value
  const locales = [String(manifest.default_locale ?? 'en'), 'zh_CN', 'en']
  for (const locale of locales) {
    if (!/^[\w-]+$/.test(locale)) continue
    const messages = await readJson(join(dir, '_locales', locale, 'messages.json'))
    const entry = messages && Object.entries(messages).find(([k]) => k.toLowerCase() === m[1]!.toLowerCase())
    const text = entry && (entry[1] as { message?: unknown }).message
    if (typeof text === 'string') return text
  }
  return value
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export async function readManifest(dir: string): Promise<ManifestSummary> {
  const manifest = await readJson(join(dir, 'manifest.json'))
  if (!manifest) throw new LocalizedError('install.noManifest')
  const mv = Number(manifest.manifest_version)
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(mv)) {
    throw new LocalizedError('install.unsupportedVersion', { version: String(manifest.manifest_version) })
  }
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new LocalizedError('install.missingNameVersion')
  }
  const action = mv === 3 ? manifest.action : (manifest.browser_action ?? manifest.page_action)
  const permissions = stringArray(manifest.permissions)
  const hostPermissions =
    mv === 3 ? stringArray(manifest.host_permissions) : permissions.filter((p) => p.includes('://') || p === '<all_urls>')
  const contentMatches = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts.flatMap((cs) => stringArray((cs as { matches?: unknown }).matches))
    : []
  const options =
    (manifest.options_ui as { page?: unknown } | undefined)?.page ?? manifest.options_page ?? null
  const icons = (manifest.icons ?? {}) as Record<string, unknown>
  const iconKey = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => Math.abs(a - 48) - Math.abs(b - 48))[0]
  const iconRel = iconKey !== undefined ? icons[String(iconKey)] : null
  const iconPath = typeof iconRel === 'string' && isInside(dir, join(dir, iconRel)) ? join(dir, iconRel) : null
  return {
    name: await localizeMessage(dir, manifest, manifest.name),
    version: manifest.version,
    description: await localizeMessage(dir, manifest, manifest.description),
    manifestVersion: mv,
    hasAction: typeof action === 'object' && action !== null,
    permissions: permissions.filter((p) => !p.includes('://') && p !== '<all_urls>'),
    hostPermissions: [...new Set([...hostPermissions, ...contentMatches])],
    optionsPage: typeof options === 'string' ? options : null,
    iconPath
  }
}

/**
 * Compare dotted version strings numerically ("1.10" > "1.9"). Missing or
 * non-numeric parts count as 0. Returns <0, 0 or >0 like a sort comparator.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (Number.parseInt(pa[i] ?? '', 10) || 0) - (Number.parseInt(pb[i] ?? '', 10) || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * The folder to install from. A folder with manifest.json is used as is. A
 * Chromium profile's `Extensions/<id>` folder has no manifest, only one
 * `<version>_<n>` folder per downloaded version: pick the newest by manifest
 * version, so "Update from source" follows the other browser's updates.
 * Anything else is returned unchanged (and fails in readManifest).
 */
export async function resolveExtensionSource(dir: string): Promise<string> {
  if (await isFile(join(dir, 'manifest.json'))) return dir
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return dir
  }
  let best: { path: string; version: string; n: number } | null = null
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_FOLDER.test(entry.name)) continue
    const path = join(dir, entry.name)
    const manifest = await readJson(join(path, 'manifest.json'))
    if (!manifest || typeof manifest.version !== 'string') continue
    const n = Number(entry.name.slice(entry.name.lastIndexOf('_') + 1))
    const order = best ? compareVersions(manifest.version, best.version) || n - best.n : 1
    if (order > 0) best = { path, version: manifest.version, n }
  }
  return best?.path ?? dir
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Copy an unpacked extension into the managed extensions directory.
 * Symlinks are skipped (they could point outside the extension) and every
 * destination path is checked to stay inside the target folder.
 */
export async function copyExtensionTree(source: string, target: string): Promise<void> {
  const root = resolve(source)
  const info = await stat(root)
  if (!info.isDirectory()) throw new LocalizedError('install.notFolder')
  let files = 0
  let bytes = 0

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const from = join(dir, entry.name)
      const rel = relative(root, from)
      const to = join(target, rel)
      if (!isInside(target, to)) throw new LocalizedError('install.illegalPath', { path: rel })
      const meta = await lstat(from)
      if (meta.isSymbolicLink()) continue
      if (meta.isDirectory()) {
        await mkdir(to, { recursive: true })
        await walk(from)
      } else if (meta.isFile()) {
        files += 1
        bytes += meta.size
        if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES) throw new LocalizedError('install.tooLarge')
        await copyFile(from, to)
      }
    }
  }

  await mkdir(target, { recursive: true })
  await walk(root)
}

/** Install `source` as a fresh managed copy under `extensionsDir`. */
export async function installCopy(source: string, extensionsDir: string): Promise<string> {
  source = await resolveExtensionSource(source)
  await readManifest(source)
  const dir = join(extensionsDir, randomUUID())
  try {
    await copyExtensionTree(source, dir)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

/**
 * Replace the contents of `installDir` with a new copy of `source`, keeping
 * the same path (and therefore the same unpacked extension id). Returns a
 * rollback function that restores the previous contents.
 */
export async function replaceCopy(source: string, installDir: string): Promise<{ commit(): Promise<void>; rollback(): Promise<void> }> {
  source = await resolveExtensionSource(source)
  await readManifest(source)
  const staging = `${installDir}.new-${Date.now()}`
  const backup = `${installDir}.old-${Date.now()}`
  try {
    await copyExtensionTree(source, staging)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  await rename(installDir, backup)
  await rename(staging, installDir)
  return {
    commit: () => rm(backup, { recursive: true, force: true }),
    rollback: async () => {
      await rm(installDir, { recursive: true, force: true })
      await rename(backup, installDir)
    }
  }
}

export async function removeCopy(installDir: string, extensionsDir: string): Promise<void> {
  if (!isInside(extensionsDir, installDir) || resolve(installDir) === resolve(extensionsDir)) return
  await rm(installDir, { recursive: true, force: true })
}
