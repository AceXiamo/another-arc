import type en from '../en/agent'

const zh: typeof en = {
  'agent.settings.section': 'Agent（MCP）',
  'agent.settings.description':
    '让 Claude Code、Codex 这类 AI Agent 通过 Model Context Protocol 使用这个浏览器：以你的登录身份读取网页，在标签页里点击、输入、运行脚本。',
  'agent.settings.enable': '允许 Agent 使用浏览器',
  'agent.settings.enableHint': '只有这台 Mac 上持有访问令牌的程序才能连接',
  'agent.settings.server': '服务',
  'agent.settings.running': '运行中：{url}',
  'agent.settings.starting': '正在启动…',
  'agent.settings.portInUse': '端口 {port} 被其他应用占用了，换一个吧',
  'agent.settings.failed': '无法在端口 {port} 上启动',
  'agent.settings.port': '端口',
  'agent.settings.token': '访问令牌',
  'agent.settings.tokenHint': '换新令牌后，所有 Agent 都要重新配置才能连上',
  'agent.settings.copy': '复制',
  'agent.settings.copied': '已复制',
  'agent.settings.regenerate': '换新令牌',
  'agent.settings.claude': 'Claude Code',
  'agent.settings.claudeHint': '在终端里运行一次复制的命令',
  'agent.settings.codex': 'Codex',
  'agent.settings.codexHint': '粘贴到 ~/.codex/config.toml',
  'agent.settings.json': '其他 MCP 客户端',
  'agent.settings.jsonHint': 'Streamable HTTP + Bearer 令牌（Cursor、Windsurf 等）',
  'agent.settings.copyCommand': '复制命令',
  'agent.settings.copyConfig': '复制配置',
  'agent.settings.clients': '最近连接',
  'agent.settings.justNow': '刚刚',
  'agent.settings.minutesAgo': '{count} 分钟前',

  'agent.tab.working': '有 Agent 正在这个标签页里工作',

  'agent.cursor.click': '点击 {target}',
  'agent.cursor.hover': '指向 {target}',
  'agent.cursor.type': '输入到 {target}',
  'agent.cursor.fill': '填写 {target}',
  'agent.cursor.drag': '拖动 {target}',
  'agent.cursor.scroll': '滚动页面',
  'agent.cursor.key': '按下 {target}',
  'agent.cursor.read': '阅读页面',
  'agent.cursor.find': '查找 {target}'
}

export default zh
