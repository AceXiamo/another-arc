import type en from '../en/shell-pages'

const zh: Record<keyof typeof en, string> = {
  // History page
  'history.clearData': '清除浏览数据…',
  'history.searchPlaceholder': '搜索历史记录',
  'history.today': '今天',
  'history.yesterday': '昨天',
  'history.empty': '暂无历史记录',
  'history.emptyHint': '你访问过的网页会显示在这里。',
  'history.noMatches': '没有匹配的记录',
  'history.noMatchesHint': '试试更短的关键词，或网址的一部分。',
  'history.clearSearch': '清除搜索',

  // Downloads page
  'downloads.started': '正在下载“{name}”',
  'downloads.openFolder': '打开文件夹',
  'downloads.open': '打开',
  'downloads.retry': '重试',
  'downloads.today': '今天',
  'downloads.yesterday': '昨天',
  'downloads.earlier': '更早',
  'downloads.left': '剩余 {time}',
  'downloads.dragHint': '可以拖到访达或其他应用里',
  'downloads.clearCompleted': '清除已完成',
  'downloads.empty': '暂无下载',
  'downloads.emptyHint': '下载的文件会显示在这里。',
  'downloads.pause': '暂停',
  'downloads.resume': '继续',
  'downloads.showInFinder': '在访达中显示',
  'downloads.remove': '从列表移除',
  'downloads.status.cancelled': '已取消',
  'downloads.status.interrupted': '已中断',
  'downloads.status.paused': '已暂停 · {size}',


  // Empty space placeholder
  'status.empty.title': '{space} 里还没有标签页',
  'status.empty.fallbackSpace': '空间',
  'status.empty.nothingOpen': '没有打开的标签页',
  'status.empty.newTab': '按{keys}打开新标签页',

  // Crash page
  'status.crash.title': '页面崩溃了',
  'status.crash.body': '{host} 的渲染进程意外退出。可能是内存不足或页面出现了问题。',

  // Certificate error page
  'status.cert.title': '你的连接不是私密连接',
  'status.cert.body': '攻击者可能正试图从 {host} 窃取你的信息（例如密码或信用卡信息）。',
  'status.cert.back': '返回安全页面',
  'status.cert.advanced': '高级',
  'status.cert.hideAdvanced': '隐藏详情',
  'status.cert.advancedBody':
    '此服务器无法证明它是 {host}；其安全证书不受信任。仅在你完全了解风险时继续。该例外仅在本次运行期间有效。',
  'status.cert.proceed': '继续前往 {host}（不安全）',

  // Network error page
  'status.net.title': '无法访问此网站',
  'status.net.back': '返回',
  'status.net.nameNotResolved': '{host} 的服务器 IP 地址无法找到。',
  'status.net.offline': '{host} 无法连接：你似乎已断开网络。',
  'status.net.refused': '{host} 拒绝了连接请求。',
  'status.net.timedOut': '{host} 响应时间过长。',
  'status.net.closed': '{host} 意外终止了连接。',
  'status.net.blocked': '{host} 已被扩展程序拦截。',
  'status.net.changed': '{host} 网络发生了变化。',
  'status.net.invalidUrl': '{host} 的网址无效。',
  'status.net.generic': '{host} 暂时无法访问，或已永久移至新地址。',

  // A page's alert() / confirm() / prompt()
  'pageDialog.says': '{host} 显示',
  'pageDialog.thisPageSays': '此网页显示',
  'pageDialog.ok': '确定',
  'pageDialog.suppress': '禁止此网页再显示对话框'
}

export default zh
