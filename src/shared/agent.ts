// Agents (MCP): what the shell needs to show and configure the agent server.
// The server itself lives in src/main/agent and is only loaded when enabled.

/** Default local port of the MCP endpoint (changeable in Settings). */
export const AGENT_DEFAULT_PORT = 47800

/** Name agents register the browser under (`claude mcp add <name> …`). */
export const AGENT_SERVER_NAME = 'another-arc'

/** Path of the Streamable HTTP endpoint. */
export const AGENT_PATH = '/mcp'

export interface AgentClient {
  /** Display name, e.g. "Claude Code". */
  name: string
  lastSeen: number
}

export interface AgentInfo {
  enabled: boolean
  running: boolean
  port: number
  /** Full endpoint URL, e.g. http://127.0.0.1:47800/mcp. */
  url: string
  token: string
  /** Why an enabled server is not running. */
  error: 'portInUse' | 'failed' | null
  /** Clients seen since the server started, most recent first. */
  clients: AgentClient[]
}

/** What `agent.copy` puts on the clipboard. */
export type AgentSnippet = 'token' | 'claude' | 'codex' | 'json'

export const AGENT_SNIPPETS: readonly AgentSnippet[] = ['token', 'claude', 'codex', 'json']

export function agentUrl(port: number): string {
  return `http://127.0.0.1:${port}${AGENT_PATH}`
}

/** Ready-to-paste client configuration for one MCP client. */
export function agentSnippet(kind: AgentSnippet, url: string, token: string): string {
  switch (kind) {
    case 'token':
      return token
    case 'claude':
      return `claude mcp add --scope user --transport http ${AGENT_SERVER_NAME} ${url} --header "Authorization: Bearer ${token}"`
    case 'codex':
      return [`[mcp_servers.${AGENT_SERVER_NAME}]`, `url = "${url}"`, `http_headers = { Authorization = "Bearer ${token}" }`].join('\n')
    case 'json':
      return JSON.stringify(
        { mcpServers: { [AGENT_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2
      )
  }
}
