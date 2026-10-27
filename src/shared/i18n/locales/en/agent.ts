const en = {
  // Settings
  'agent.settings.section': 'Agents (MCP)',
  'agent.settings.description':
    'Let AI agents such as Claude Code or Codex use this browser over the Model Context Protocol: read pages, click, type and run scripts in your tabs, signed in as you.',
  'agent.settings.enable': 'Allow agents to use the browser',
  'agent.settings.enableHint': 'Only programs on this Mac that have the access token can connect',
  'agent.settings.server': 'Server',
  'agent.settings.running': 'Running at {url}',
  'agent.settings.starting': 'Starting…',
  'agent.settings.portInUse': 'Port {port} is taken by another app; choose another one',
  'agent.settings.failed': 'Could not start on port {port}',
  'agent.settings.port': 'Port',
  'agent.settings.token': 'Access token',
  'agent.settings.tokenHint': 'A new token disconnects every agent until you set it up again',
  'agent.settings.copy': 'Copy',
  'agent.settings.copied': 'Copied',
  'agent.settings.regenerate': 'New token',
  'agent.settings.claude': 'Claude Code',
  'agent.settings.claudeHint': 'Run the copied command once in a terminal',
  'agent.settings.codex': 'Codex',
  'agent.settings.codexHint': 'Paste into ~/.codex/config.toml',
  'agent.settings.json': 'Other MCP clients',
  'agent.settings.jsonHint': 'Streamable HTTP with a bearer token (Cursor, Windsurf…)',
  'agent.settings.copyCommand': 'Copy command',
  'agent.settings.copyConfig': 'Copy config',
  'agent.settings.clients': 'Connected recently',
  'agent.settings.justNow': 'just now',
  'agent.settings.minutesAgo': '{count} min ago',

  // Sidebar
  'agent.tab.working': 'An agent is working in this tab',

  // The agent's cursor, over the page ({target} is what it acts on, may be empty)
  'agent.cursor.click': 'Clicking {target}',
  'agent.cursor.hover': 'Pointing at {target}',
  'agent.cursor.type': 'Typing in {target}',
  'agent.cursor.fill': 'Filling in {target}',
  'agent.cursor.drag': 'Dragging {target}',
  'agent.cursor.scroll': 'Scrolling',
  'agent.cursor.key': 'Pressing {target}',
  'agent.cursor.read': 'Reading the page',
  'agent.cursor.find': 'Looking for {target}'
}

export default en
