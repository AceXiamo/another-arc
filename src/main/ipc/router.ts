import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { IPC, type RpcArgs, type RpcMethod, type RpcResult } from '@shared/ipc'
import { ValidationError, type Validator } from './validate'

type Handler<M extends RpcMethod> = (
  ctx: { sender: WebContents },
  ...args: RpcArgs<M>
) => RpcResult<M> | Promise<RpcResult<M>>

interface Entry {
  validate: Validator<unknown[]>
  fn: (ctx: { sender: WebContents }, ...args: unknown[]) => unknown
}

/**
 * Single typed entry point for shell → main calls. Every call is checked for
 * (1) a trusted sender — the shell's own main frame — and (2) well-formed
 * arguments, before any handler runs.
 */
export class RpcRouter {
  private readonly handlers = new Map<string, Entry>()

  constructor(private readonly isTrustedSender: (event: IpcMainInvokeEvent) => boolean) {}

  handle<M extends RpcMethod, A extends RpcArgs<M>>(
    method: M,
    validate: Validator<A>,
    fn: Handler<M>
  ): void {
    if (this.handlers.has(method)) throw new Error(`Duplicate RPC handler ${method}`)
    this.handlers.set(method, {
      validate: validate as unknown as Validator<unknown[]>,
      fn: fn as unknown as Entry['fn']
    })
  }

  install(): void {
    ipcMain.handle(IPC.invoke, async (event, method: unknown, ...args: unknown[]) => {
      if (!this.isTrustedSender(event)) {
        throw new Error('Untrusted IPC sender')
      }
      const entry = typeof method === 'string' ? this.handlers.get(method) : undefined
      if (!entry) throw new Error(`Unknown RPC method ${String(method)}`)
      let parsed: unknown[]
      try {
        parsed = entry.validate(args, method as string)
      } catch (error) {
        if (error instanceof ValidationError) console.warn(`[ipc] ${error.message}`)
        throw error
      }
      return entry.fn({ sender: event.sender }, ...parsed)
    })
  }

  /** Method names (used by tests to ensure every RPC has a handler). */
  methods(): string[] {
    return [...this.handlers.keys()]
  }
}
