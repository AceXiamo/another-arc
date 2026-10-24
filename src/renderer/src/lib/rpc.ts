import type { RpcArgs, RpcMethod, RpcResult } from '@shared/ipc'

/** Typed call into the main process. */
export function rpc<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): Promise<Awaited<RpcResult<M>>> {
  return window.arc.invoke(method, ...args)
}

/** Fire-and-forget variant that logs failures instead of throwing. */
export function send<M extends RpcMethod>(method: M, ...args: RpcArgs<M>): void {
  window.arc.invoke(method, ...args).catch((error: unknown) => console.error(`[rpc] ${method}`, error))
}

export function faviconSrc(url: string): string {
  return `favicon://i/?u=${encodeURIComponent(url)}`
}
