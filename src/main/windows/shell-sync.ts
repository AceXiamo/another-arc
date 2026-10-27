import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  DownloadState,
  ExtensionInfo,
  FindState,
  FolderId,
  FolderState,
  PageDialog,
  PermissionPrompt,
  Settings,
  ShellCommand,
  SpaceId,
  SpaceState,
  StatePatch,
  TabId,
  TabState,
  WindowState
} from '@shared/types'

type Keyed<T> = Record<string, Partial<T> | null>

/**
 * Batches state changes into one `StatePatch` per macrotask. A page load
 * fires a burst of events (start, navigate, title, favicon, stop); the shell
 * receives them as a single message and React renders once.
 */
export class ShellSync {
  private target: WebContents | null = null
  private patch: StatePatch = {}
  private dirty = false
  private scheduled: NodeJS.Immediate | null = null
  messages = 0

  attach(target: WebContents): void {
    this.target = target
  }

  tab(id: TabId, data: Partial<TabState> | null, full = false): void {
    this.mergeKeyed('tabs', id, data, full)
  }

  space(id: SpaceId, data: Partial<SpaceState> | null, full = false): void {
    this.mergeKeyed('spaces', id, data, full)
  }

  folder(id: FolderId, data: Partial<FolderState> | null, full = false): void {
    this.mergeKeyed('folders', id, data, full)
  }

  download(id: string, data: Partial<DownloadState> | null, full = false): void {
    this.mergeKeyed('downloads', id, data, full)
  }

  spaceOrder(order: SpaceId[]): void {
    this.patch.spaceOrder = [...order]
    this.touch()
  }

  window(data: Partial<WindowState>): void {
    this.patch.window = { ...this.patch.window, ...data }
    this.touch()
  }

  settings(data: Partial<Settings>): void {
    this.patch.settings = { ...this.patch.settings, ...data }
    this.touch()
  }

  extensions(list: ExtensionInfo[]): void {
    this.patch.extensions = list
    this.touch()
  }

  permissionPrompts(list: PermissionPrompt[]): void {
    this.patch.permissionPrompts = [...list]
    this.touch()
  }

  pageDialogs(list: PageDialog[]): void {
    this.patch.pageDialogs = [...list]
    this.touch()
  }

  find(state: FindState | null): void {
    this.patch.find = state
    this.touch()
  }

  /** Commands are delivered after any pending state so the shell sees fresh data. */
  command(cmd: ShellCommand): void {
    this.flush()
    this.send(IPC.command, cmd)
  }

  flush(): void {
    if (this.scheduled) {
      clearImmediate(this.scheduled)
      this.scheduled = null
    }
    if (!this.dirty) return
    const patch = this.patch
    this.patch = {}
    this.dirty = false
    this.send(IPC.patch, patch)
  }

  private send(channel: string, payload: unknown): void {
    const target = this.target
    if (!target || target.isDestroyed()) return
    this.messages += 1
    target.send(channel, payload)
  }

  private mergeKeyed<K extends 'tabs' | 'spaces' | 'folders' | 'downloads'>(
    key: K,
    id: string,
    data: Partial<TabState | SpaceState | FolderState | DownloadState> | null,
    full: boolean
  ): void {
    const bucket = ((this.patch[key] as Keyed<unknown> | undefined) ??= {}) as Keyed<unknown>
    if (data === null || full) {
      bucket[id] = data === null ? null : { ...data }
    } else {
      const existing = bucket[id]
      if (existing === null) return // updates after a removal are moot
      bucket[id] = existing ? { ...existing, ...data } : { ...data }
    }
    this.touch()
  }

  private touch(): void {
    this.dirty = true
    this.scheduled ??= setImmediate(() => {
      this.scheduled = null
      this.flush()
    })
  }
}
