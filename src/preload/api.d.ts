import type { RpcArgs, RpcMethod, RpcResult } from '../shared/ipc'
import type { ShellCommand, ShellSnapshot, StatePatch } from '../shared/types'

export interface ActionTabInfo {
  title?: string
  text?: string
  color?: string
  iconModified?: number
}

export interface ExtensionAction {
  id: string
  title?: string
  popup?: string
  text?: string
  color?: string
  iconModified?: number
  tabs: Record<string, ActionTabInfo>
}

export interface ActionState {
  activeTabId?: number
  actions: ExtensionAction[]
}

export interface ArcApi {
  invoke<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): Promise<Awaited<RpcResult<M>>>
  snapshot(): Promise<ShellSnapshot>
  onPatch(cb: (patch: StatePatch) => void): () => void
  onCommand(cb: (cmd: ShellCommand) => void): () => void
  actions: {
    invoke(partition: string, name: string, ...args: unknown[]): Promise<unknown>
    onUpdate(cb: () => void): () => void
  }
}

declare global {
  interface Window {
    arc: ArcApi
  }
}
