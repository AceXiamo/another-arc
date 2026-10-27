import type en from '../en/passwords'

const zh: typeof en = {
  'passwords.autofill.manage': '已保存的密码…',
  'passwords.autofill.noUsername': '无用户名',

  'passwords.save.message': '保存 {origin} 的这个密码？',
  'passwords.save.messageNoUser': '保存这个密码？',
  'passwords.save.save': '保存',
  'passwords.save.notNow': '暂不',
  'passwords.save.reason': '验证一下是你本人，才能显示这个密码',

  'passwords.settings.section': '密码',
  'passwords.settings.description': '只存在这台 Mac 上，用登录钥匙串加密，不会同步到任何地方。',
  'passwords.settings.empty': '还没有保存的密码',
  'passwords.settings.unavailable': 'macOS 没有给本应用密钥，无法保存密码',
  'passwords.settings.used': '用过 {count} 次',
  'passwords.settings.neverUsed': '没用过',
  'passwords.settings.copy': '复制',
  'passwords.settings.copied': '已复制',
  'passwords.settings.show': '显示',
  'passwords.settings.hide': '隐藏',
  'passwords.settings.remove': '删除',
  'passwords.settings.noTouchID': '显示密码需要触控 ID，可以改用复制',
  'passwords.settings.saved': '已保存的密码',
  'passwords.settings.summary': '{count} 个密码，{sites} 个网站',

  'passwords.page.search': '搜索网站或用户名',
  'passwords.page.clearSearch': '清除搜索',
  'passwords.page.noMatches': '没有匹配的密码',
  'passwords.page.noMatchesHint': '试试网站名或用户名的一部分',

  'passwords.import.count': '{count} 个密码',
  'passwords.import.result': '密码：导入 {count} 个，跳过 {skipped} 个',
  'passwords.import.inKeychain': '另有 {count} 个存在那个浏览器自己的钥匙串条目里，读不出来'
}

export default zh
