import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain, nativeImage, type BaseWindow, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import type { Translate } from '@shared/i18n'
import type { ExtensionInfo } from '@shared/types'
import {
  EXTENSION_ID,
  ExtensionInstallStatus,
  MV2DeprecationStatus,
  WEB_STORE_IPC,
  WEB_STORE_METHODS,
  WEB_STORE_ORIGIN,
  WebGlStatus,
  WebStoreResult,
  type WebStoreMethod,
  type WebStoreReply
} from '@shared/web-store'
import { describeError } from '../app/i18n'
import { parseCrx, unzip } from './crx'
import type { ExtensionManager } from './extension-manager'
import { parseManifestText } from './installer'

/** `sourcePath` of an extension installed from the store: updates download it again. */
const SOURCE_PREFIX = 'chrome-web-store:'
const MAX_CRX_BYTES = 256 * 1024 * 1024
const ICON_TIMEOUT_MS = 4000

export function webStoreSource(id: string): string {
  return SOURCE_PREFIX + id
}

/** The store id an extension was installed from, if it came from the store. */
export function webStoreIdOf(sourcePath: string): string | null {
  const id = sourcePath.startsWith(SOURCE_PREFIX) ? sourcePath.slice(SOURCE_PREFIX.length) : ''
  return EXTENSION_ID.test(id) ? id : null
}

/**
 * Download an extension's current package from the store and unpack it into
 * a temporary folder (the caller installs from it, then removes it). Goes
 * through `session` so the system proxy applies, verifies the package's
 * signature and id, and writes the public key into manifest.json so the
 * unpacked copy keeps the store's id (its data and messaging depend on it).
 */
export async function downloadFromWebStore(session: Session, id: string): Promise<string> {
  if (!EXTENSION_ID.test(id)) throw new Error(`Invalid extension id: ${id}`)
  const url = new URL('https://clients2.google.com/service/update2/crx')
  url.searchParams.set('response', 'redirect')
  url.searchParams.set('acceptformat', 'crx3')
  url.searchParams.set('prodversion', process.versions.chrome)
  url.searchParams.set('x', new URLSearchParams({ id, installsource: 'ondemand', uc: '' }).toString())
  const res = await session.fetch(url.toString())
  if (!res.ok) throw new Error(`The store answered ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  if (body.length > MAX_CRX_BYTES) throw new Error('The package is too large')
  const crx = parseCrx(body)
  if (crx.id !== id) throw new Error(`The store sent ${crx.id} instead of ${id}`)

  const dir = await mkdtemp(join(tmpdir(), 'arc-web-store-'))
  try {
    await unzip(crx.archive, dir)
    const manifestPath = join(dir, 'manifest.json')
    const manifest = parseManifestText(await readFile(manifestPath, 'utf8'))
    manifest.key = crx.publicKey.toString('base64')
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    return dir
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export interface WebStoreHost {
  extensions: ExtensionManager
  /** The session extensions live in (downloads go through it too). */
  session: Session
  isTab(wc: WebContents): boolean
  window(): BaseWindow | null
  confirm(message: string, detail: string): Promise<boolean>
  toast(message: string): void
  readonly t: Translate
}

/**
 * Main's side of the Chrome Web Store bridge (see src/preload/web-store.ts):
 * the store's own "Add to Chrome" / "Remove from Chrome" buttons install
 * into our extension manager. Only the store's top frame, in a tab, is heard;
 * every install is confirmed by the user in a native dialog first.
 */
export class WebStore {
  private readonly installing = new Set<string>()

  constructor(private readonly host: WebStoreHost) {
    ipcMain.handle(WEB_STORE_IPC.call, (event, method: unknown, args: unknown) => this.handle(event, method, args))
  }

  private async handle(event: IpcMainInvokeEvent, method: unknown, args: unknown): Promise<WebStoreReply | undefined> {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || frame.origin !== WEB_STORE_ORIGIN || !this.host.isTab(event.sender)) return
    if (!WEB_STORE_METHODS.includes(method as WebStoreMethod) || !Array.isArray(args)) return
    try {
      return await this.call(event.sender, method as WebStoreMethod, args)
    } catch (error) {
      return { value: undefined, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async call(sender: WebContents, method: WebStoreMethod, args: unknown[]): Promise<WebStoreReply> {
    const ext = this.host.extensions
    switch (method) {
      case 'beginInstallWithManifest3':
        return this.beginInstall(sender, args[0])
      case 'completeInstall':
      case 'install':
        return { value: WebStoreResult.SUCCESS }
      case 'getExtensionStatus':
        return { value: this.status(String(args[0])) }
      case 'getFullChromeVersion':
        return { value: { version_number: process.versions.chrome } }
      case 'getMV2DeprecationStatus':
        return { value: MV2DeprecationStatus.INACTIVE }
      case 'getWebGLStatus':
        return {
          value: app.getGPUFeatureStatus().webgl.startsWith('enabled') ? WebGlStatus.WEBGL_ALLOWED : WebGlStatus.WEBGL_BLOCKED
        }
      case 'getReferrerChain':
        // An empty serialized referrer chain, as Chrome sends without one.
        return { value: 'EgIIAA==' }
      case 'getBrowserLogin':
      case 'getStoreLogin':
        return { value: '' }
      case 'setStoreLogin':
      case 'enableAppLauncher':
      case 'getIsLauncherEnabled':
        return { value: true }
      case 'isInIncognitoMode':
      case 'isPendingCustodianApproval':
        return { value: false }
      case 'management.getAll':
        return { value: ext.info().map(managementInfo) }
      case 'management.get': {
        const info = ext.info().find((e) => e.id === args[0])
        return info ? { value: managementInfo(info) } : { value: undefined, error: `Failed to find extension with id ${String(args[0])}.` }
      }
      case 'management.setEnabled': {
        const id = String(args[0])
        if (!ext.info().some((e) => e.id === id)) return { value: undefined, error: `Failed to find extension with id ${id}.` }
        await ext.setEnabled(id, args[1] === true)
        return { value: undefined }
      }
      case 'management.uninstall':
        return this.uninstall(sender, String(args[0]))
    }
  }

  private status(id: string): string {
    const info = this.host.extensions.info().find((e) => e.id === id)
    if (!info) return ExtensionInstallStatus.INSTALLABLE
    return info.enabled ? ExtensionInstallStatus.ENABLED : ExtensionInstallStatus.DISABLED
  }

  private async beginInstall(sender: WebContents, details: unknown): Promise<WebStoreReply> {
    const { t } = this.host
    const d = (details ?? {}) as { id?: unknown; manifest?: unknown; localizedName?: unknown; iconUrl?: unknown }
    const id = typeof d.id === 'string' ? d.id : ''
    if (!EXTENSION_ID.test(id)) return { value: WebStoreResult.INVALID_ID }
    if (this.installing.has(id)) return { value: WebStoreResult.INSTALL_IN_PROGRESS }
    if (this.status(id) !== ExtensionInstallStatus.INSTALLABLE) return { value: WebStoreResult.ALREADY_INSTALLED }
    let manifest: Record<string, unknown>
    try {
      manifest = typeof d.manifest === 'string' ? parseManifestText(d.manifest) : {}
    } catch {
      return { value: WebStoreResult.MANIFEST_ERROR }
    }
    const name =
      (typeof d.localizedName === 'string' && d.localizedName.trim()) ||
      (typeof manifest.name === 'string' && !manifest.name.startsWith('__MSG_') ? manifest.name : '') ||
      id

    if (!(await this.confirmInstall(name, manifest, typeof d.iconUrl === 'string' ? d.iconUrl : null))) {
      return { value: WebStoreResult.USER_CANCELLED }
    }
    this.installing.add(id)
    let dir: string | null = null
    try {
      dir = await downloadFromWebStore(this.host.session, id)
      const info = await this.host.extensions.install(dir, { sourcePath: webStoreSource(id) })
      if (!sender.isDestroyed()) sender.send(WEB_STORE_IPC.installed, managementInfo(info))
      this.host.toast(t('webStore.installed', { name: info.name }))
      return { value: WebStoreResult.SUCCESS }
    } catch (error) {
      const message = describeError(error, t)
      this.host.toast(t('webStore.installFailed', { name, error: message }))
      return { value: WebStoreResult.INSTALL_ERROR, error: message }
    } finally {
      this.installing.delete(id)
      if (dir) await rm(dir, { recursive: true, force: true })
    }
  }

  /** Chrome's "Add “X”?" dialog: the extension's icon, what it can reach, Add / Cancel. */
  private async confirmInstall(name: string, manifest: Record<string, unknown>, iconUrl: string | null): Promise<boolean> {
    const { t } = this.host
    const options: Electron.MessageBoxOptions = {
      type: 'none',
      message: t('webStore.confirm.title', { name }),
      detail: permissionSummary(manifest, t),
      buttons: [t('webStore.confirm.add'), t('common.cancel')],
      defaultId: 0,
      cancelId: 1,
      ...(iconUrl ? { icon: await this.fetchIcon(iconUrl) } : {})
    }
    if (!options.icon) delete options.icon
    const parent = this.host.window()
    const res = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    return res.response === 0
  }

  private async fetchIcon(url: string): Promise<Electron.NativeImage | undefined> {
    try {
      if (new URL(url).protocol !== 'https:') return undefined
      const res = await this.host.session.fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) })
      if (!res.ok) return undefined
      const image = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
      return image.isEmpty() ? undefined : image.resize({ width: 64, height: 64, quality: 'best' })
    } catch {
      return undefined
    }
  }

  private async uninstall(sender: WebContents, id: string): Promise<WebStoreReply> {
    const { t } = this.host
    const info = this.host.extensions.info().find((e) => e.id === id)
    if (!info) return { value: undefined, error: `Failed to find extension with id ${id}.` }
    if (!(await this.host.confirm(t('dialog.uninstall.title', { name: info.name }), t('dialog.uninstall.detail')))) {
      return { value: undefined, error: 'User cancelled uninstall' }
    }
    await this.host.extensions.uninstall(id)
    if (!sender.isDestroyed()) sender.send(WEB_STORE_IPC.uninstalled, id)
    return { value: undefined }
  }
}

/** chrome.management.ExtensionInfo, as much of it as the store reads. */
function managementInfo(info: ExtensionInfo) {
  return {
    id: info.id,
    name: info.name,
    shortName: info.name,
    description: info.description,
    version: info.version,
    enabled: info.enabled,
    mayDisable: true,
    isApp: false,
    type: 'extension',
    installType: 'normal',
    offlineEnabled: false,
    optionsUrl: info.optionsUrl ?? '',
    homepageUrl: '',
    updateUrl: '',
    permissions: info.permissions,
    hostPermissions: info.hostPermissions,
    icons: []
  }
}

/** What the extension asks to reach, in a line or two (Chrome's install prompt, simplified). */
function permissionSummary(manifest: Record<string, unknown>, t: Translate): string {
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  const hosts = new Set([
    ...strings(manifest.host_permissions),
    ...strings(manifest.permissions).filter((p) => p.includes('://') || p === '<all_urls>'),
    ...scripts.flatMap((s) => strings((s as { matches?: unknown })?.matches))
  ])
  const allSites = [...hosts].some((h) => h === '<all_urls>' || /^(\*|https?):\/\/\*\/\*$/.test(h))
  const sites = [...new Set([...hosts].map((h) => h.replace(/^[^:]+:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '')))].filter(
    (h) => h && h !== '*'
  )
  const apis = strings(manifest.permissions).filter((p) => !p.includes('://') && p !== '<all_urls>')
  const lines = [
    allSites
      ? t('webStore.confirm.allSites')
      : sites.length > 0
        ? t('webStore.confirm.someSites', { sites: sites.slice(0, 4).join(', ') + (sites.length > 4 ? ' …' : '') })
        : '',
    apis.length > 0 ? t('webStore.confirm.apis', { apis: apis.join(', ') }) : ''
  ].filter(Boolean)
  return lines.length > 0 ? lines.join('\n') : t('webStore.confirm.noPermissions')
}
