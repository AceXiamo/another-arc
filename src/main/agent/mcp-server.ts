import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

// A Model Context Protocol server over Streamable HTTP, small enough to read
// in one sitting: JSON-RPC 2.0 in a POST, JSON back. The browser never starts
// a request itself, so there is no SSE stream (GET answers 405), which the
// transport allows. No Electron in here: the protocol is unit tested on its own.
//
// Who may talk to it:
// - It listens on 127.0.0.1 only.
// - Host must name the loopback address: a web page that rebinds its own
//   domain to 127.0.0.1 still sends its own Host and is turned away.
// - Requests carrying an Origin come from a web page, which no MCP client
//   is, so they are refused too.
// - Every request needs `Authorization: Bearer <token>`.

/** Protocol revisions we speak, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

const MAX_BODY = 8 << 20
/** Sessions are only used to name clients; old ones are forgotten. */
const MAX_SESSIONS = 64

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpToolResult {
  content: McpContent[]
  isError?: boolean
}

/** JSON Schema subset the arguments are checked against. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: ReadonlyArray<string | number>
  minimum?: number
  maximum?: number
  additionalProperties?: boolean
}

export interface McpClientInfo {
  /** Session id issued on `initialize`; null for clients that never sent one. */
  session: string | null
  name: string
  version: string
}

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: JsonSchema & { type: 'object' }
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
  run(args: Record<string, unknown>, client: McpClientInfo): Promise<McpToolResult> | McpToolResult
}

export interface McpServerOptions {
  name: string
  title: string
  version: string
  instructions: string
  tools: readonly McpTool[]
  /** Read on every request, so regenerating it takes effect at once. */
  token(): string
}

/** Thrown by tools for failures the agent should read (shown as a tool error, not a protocol error). */
export class ToolError extends Error {}

interface RpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

interface RpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

export interface McpSession extends McpClientInfo {
  lastSeen: number
}

export class McpHttpServer {
  private server: Server | null = null
  private port = 0
  private readonly sessions = new Map<string, McpSession>()
  private readonly tools: Map<string, McpTool>

  constructor(private readonly options: McpServerOptions) {
    this.tools = new Map(options.tools.map((t) => [t.name, t]))
  }

  /** Resolves once listening; rejects with the socket error (EADDRINUSE…). */
  listen(port: number): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res))
    // Tool calls can take a while (page loads); never cut them off.
    server.requestTimeout = 0
    server.headersTimeout = 30_000
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (error) => console.error('[agent]', error))
        this.server = server
        this.port = (server.address() as { port: number }).port
        resolve()
      })
    })
  }

  get listeningPort(): number {
    return this.port
  }

  close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  /** Clients with a session, most recently active first. */
  clients(): McpSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.trustedHost(req.headers.host)) return reply(res, 403, { error: 'Host not allowed' })
    if (req.headers.origin !== undefined && req.headers.origin !== 'null') {
      return reply(res, 403, { error: 'Requests from web pages are not allowed' })
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/mcp') return reply(res, 404, { error: 'Not found' })
    if (!this.authorized(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      return reply(res, 401, { error: 'Missing or wrong token. Copy it from Another Arc → Settings → Agents.' })
    }
    const session = header(req, 'mcp-session-id')
    if (req.method === 'DELETE') {
      if (session) this.sessions.delete(session)
      return reply(res, 200, {})
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE')
      return reply(res, 405, { error: 'Method not allowed' })
    }

    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return reply(res, 400, rpcError(null, -32700, 'Parse error'))
    }
    const messages = Array.isArray(body) ? body : [body]
    if (messages.length === 0) return reply(res, 400, rpcError(null, -32600, 'Empty batch'))

    const client = this.client(session)
    const responses: RpcResponse[] = []
    let newSession: string | null = null
    for (const message of messages) {
      const response = await this.dispatch(message as RpcMessage, client, (s) => (newSession = s))
      if (response) responses.push(response)
    }
    if (newSession) res.setHeader('Mcp-Session-Id', newSession)
    if (responses.length === 0) return reply(res, 202, null)
    return reply(res, 200, Array.isArray(body) ? responses : responses[0])
  }

  private trustedHost(host: string | undefined): boolean {
    if (!host) return false
    const port = String(this.port)
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
  }

  private authorized(header: string | undefined): boolean {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '')
    const expected = Buffer.from(this.options.token())
    const given = Buffer.from(match?.[1]?.trim() ?? '')
    return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected)
  }

  private client(session: string | undefined): McpClientInfo {
    const known = session ? this.sessions.get(session) : undefined
    if (known) {
      known.lastSeen = Date.now()
      return known
    }
    // A session we never issued (say, from before a restart): serve it
    // rather than force the client through a re-initialize it may not do.
    return { session: null, name: '', version: '' }
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC
  // ---------------------------------------------------------------------------

  private async dispatch(
    message: RpcMessage,
    client: McpClientInfo,
    startSession: (id: string) => void
  ): Promise<RpcResponse | null> {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return rpcError(null, -32600, 'Invalid request')
    }
    const id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null
    // Notifications (no id) and responses to requests we never make need no answer.
    if (typeof message.method !== 'string') return null
    const isNotification = message.id === undefined
    const params = (message.params ?? {}) as Record<string, unknown>
    try {
      const result = await this.call(message.method, params, client, startSession)
      return isNotification ? null : { jsonrpc: '2.0', id, result }
    } catch (error) {
      if (isNotification) return null
      if (error instanceof RpcFailure) return rpcError(id, error.code, error.message)
      return rpcError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  private async call(
    method: string,
    params: Record<string, unknown>,
    client: McpClientInfo,
    startSession: (id: string) => void
  ): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        const info = (params.clientInfo ?? {}) as { name?: unknown; title?: unknown; version?: unknown }
        const session = randomUUID()
        this.sessions.set(session, {
          session,
          name: String(info.title || info.name || '').slice(0, 80),
          version: String(info.version ?? '').slice(0, 40),
          lastSeen: Date.now()
        })
        this.pruneSessions()
        startSession(session)
        return {
          protocolVersion: (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.name, title: this.options.title, version: this.options.version },
          instructions: this.options.instructions
        }
      }
      case 'ping':
        return {}
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return {}
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: { title: t.title, ...t.annotations } } : {})
          }))
        }
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? this.tools.get(params.name) : undefined
        if (!tool) throw new RpcFailure(-32602, `Unknown tool: ${String(params.name)}`)
        const args = (params.arguments ?? {}) as Record<string, unknown>
        const problem = checkArgs(args, tool.inputSchema)
        if (problem) return textResult(`Invalid arguments: ${problem}`, true)
        try {
          return await tool.run(args, client)
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true)
        }
      }
      default:
        throw new RpcFailure(-32601, `Method not found: ${method}`)
    }
  }

  private pruneSessions(): void {
    if (this.sessions.size <= MAX_SESSIONS) return
    const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)
    for (const s of oldest.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(s.session!)
  }
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

export function textResult(text: string, isError = false): McpToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

/** First problem with `value` against `schema`, or null. */
export function checkArgs(value: unknown, schema: JsonSchema, path = ''): string | null {
  const at = path || 'arguments'
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at} must be an object`
      const obj = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) return `${path ? `${path}.` : ''}${key} is required`
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key]
        if (!sub) {
          if (schema.additionalProperties === false) return `unknown property ${path ? `${path}.` : ''}${key}`
          continue
        }
        if (v === undefined || v === null) continue
        const problem = checkArgs(v, sub, path ? `${path}.${key}` : key)
        if (problem) return problem
      }
      return null
    }
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be an array`
      if (schema.items) {
        for (let i = 0; i < value.length; i += 1) {
          const problem = checkArgs(value[i], schema.items, `${at}[${i}]`)
          if (problem) return problem
        }
      }
      return null
    }
    case 'string':
      if (typeof value !== 'string') return `${at} must be a string`
      break
    case 'boolean':
      if (typeof value !== 'boolean') return `${at} must be true or false`
      break
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a number`
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${at} must be an integer`
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be ≥ ${schema.minimum}`
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be ≤ ${schema.maximum}`
      break
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) return `${at} must be one of ${schema.enum.join(', ')}`
  return null
}

function rpcError(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    res.writeHead(status).end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }).end(text)
}
