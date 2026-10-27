import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkArgs, McpHttpServer, ToolError, type McpTool } from '../../src/main/agent/mcp-server'

const TOKEN = 'secret-token'

const echo: McpTool = {
  name: 'echo',
  title: 'Echo',
  description: 'Echo the text back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' }, times: { type: 'integer', minimum: 1 } }, required: ['text'] },
  run: (args, client) => ({ content: [{ type: 'text', text: `${client.name}:${String(args.text).repeat(Number(args.times ?? 1))}` }] })
}

const failing: McpTool = {
  name: 'fail',
  title: 'Fail',
  description: 'Always fails',
  inputSchema: { type: 'object' },
  run: () => {
    throw new ToolError('the page is gone')
  }
}

let server: McpHttpServer
let url: string

beforeEach(async () => {
  server = new McpHttpServer({ name: 'test', title: 'Test', version: '1.0.0', instructions: 'Be nice', tools: [echo, failing], token: () => TOKEN })
  await server.listen(0)
  url = `http://127.0.0.1:${server.listeningPort}/mcp`
})

afterEach(() => server.close())

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      ...headers
    },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
}

const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: '2.0', id, method, params })

describe('McpHttpServer', () => {
  it('initializes, negotiates the version and issues a session', async () => {
    const res = await post(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1' } }))
    expect(res.status).toBe(200)
    expect(res.json.result.protocolVersion).toBe('2025-06-18')
    expect(res.json.result.capabilities.tools).toBeDefined()
    expect(res.json.result.instructions).toBe('Be nice')
    expect(res.headers.get('mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(server.clients()[0]?.name).toBe('Claude Code')
  })

  it('answers unknown protocol versions with its newest one', async () => {
    const res = await post(rpc('initialize', { protocolVersion: '1999-01-01', clientInfo: { name: 'x' } }))
    expect(res.json.result.protocolVersion).toBe('2025-11-25')
  })

  it('accepts notifications with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(res.json).toBeNull()
  })

  it('lists and calls tools, naming the client from its session', async () => {
    const init = await post(rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex' } }))
    const session = init.headers.get('mcp-session-id')!
    const list = await post(rpc('tools/list', {}, 2), { 'Mcp-Session-Id': session })
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(['echo', 'fail'])
    const call = await post(rpc('tools/call', { name: 'echo', arguments: { text: 'ab', times: 2 } }, 3), { 'Mcp-Session-Id': session })
    expect(call.json.result.content[0].text).toBe('codex:abab')
  })

  it('serves sessions it never issued', async () => {
    const call = await post(rpc('tools/call', { name: 'echo', arguments: { text: 'x' } }), { 'Mcp-Session-Id': 'stale' })
    expect(call.json.result.content[0].text).toBe(':x')
  })

  it('reports tool failures and bad arguments as tool errors', async () => {
    const failed = await post(rpc('tools/call', { name: 'fail', arguments: {} }))
    expect(failed.json.result).toEqual({ content: [{ type: 'text', text: 'the page is gone' }], isError: true })
    const invalid = await post(rpc('tools/call', { name: 'echo', arguments: { times: 2 } }))
    expect(invalid.json.result.isError).toBe(true)
    expect(invalid.json.result.content[0].text).toContain('text is required')
  })

  it('uses JSON-RPC errors for protocol problems', async () => {
    expect((await post(rpc('tools/call', { name: 'nope' }))).json.error.code).toBe(-32602)
    expect((await post(rpc('resources/list'))).json.error.code).toBe(-32601)
    const parse = await post('{not json')
    expect(parse.status).toBe(400)
    expect(parse.json.error.code).toBe(-32700)
  })

  it('handles batches', async () => {
    const res = await post([rpc('ping', {}, 1), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('ping', {}, 2)])
    expect(res.json).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} }
    ])
  })

  it('requires the token', async () => {
    const missing = await post(rpc('ping'), { Authorization: '' })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')
    expect((await post(rpc('ping'), { Authorization: 'Bearer wrong-token!' })).status).toBe(401)
  })

  it('refuses web pages: foreign Origin or a rebound Host', async () => {
    expect((await post(rpc('ping'), { Origin: 'https://evil.example' })).status).toBe(403)
    // fetch() will not let us forge Host, so speak HTTP directly.
    const { request } = await import('node:http')
    const status = await new Promise<number>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port: server.listeningPort, path: '/mcp', method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } },
        (res) => resolve(res.statusCode ?? 0)
      )
      req.end(JSON.stringify(rpc('ping')))
    })
    expect(status).toBe(403)
  })

  it('only serves /mcp, and only POST and DELETE', async () => {
    const get = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(get.status).toBe(405)
    const other = await fetch(url.replace('/mcp', '/other'), { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(other.status).toBe(404)
  })
})

describe('checkArgs', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      fields: { type: 'array' as const, items: { type: 'object' as const, properties: { ref: { type: 'string' as const } }, required: ['ref'] } },
      mode: { type: 'string' as const, enum: ['a', 'b'] }
    }
  }

  it('walks nested arrays and objects', () => {
    expect(checkArgs({ fields: [{ ref: 'e1' }] }, schema)).toBeNull()
    expect(checkArgs({ fields: [{}] }, schema)).toBe('fields[0].ref is required')
    expect(checkArgs({ fields: 'x' }, schema)).toBe('fields must be an array')
    expect(checkArgs({ mode: 'c' }, schema)).toBe('mode must be one of a, b')
  })
})
