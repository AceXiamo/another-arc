import type en from '../en/shell-settings'

const zh: Record<keyof typeof en, string> = {
  // Search
  'settings.search.title': '搜索',
  'settings.search.engine': '默认搜索引擎',
  'settings.search.engineHint': '在地址栏输入非网址内容时使用',
  'settings.search.custom': '自定义…',
  'settings.search.customUrl': '自定义搜索网址',
  'settings.search.customUrlHint': '用 %s 代表搜索词，例如 https://example.com/search?q=%s',

  // Appearance
  'settings.general.title': '通用',
  'settings.defaultBrowser.label': '默认浏览器',
  'settings.defaultBrowser.isDefault': '其他应用里的链接会在 Another Arc 中打开。',
  'settings.defaultBrowser.notDefault': '其他应用里的链接目前会用别的浏览器打开。',
  'settings.defaultBrowser.make': '设为默认',
  'settings.defaultBrowser.done': '已是默认',

  'settings.appearance.title': '外观',
  'settings.appearance.language': '语言',
  'settings.appearance.theme': '主题',
  'settings.appearance.themeSystem': '跟随系统',
  'settings.appearance.themeLight': '浅色',
  'settings.appearance.themeDark': '深色',

  // Performance
  'settings.performance.title': '性能',
  'settings.performance.description': '后台标签页休眠后只保留标题、图标和前进 / 后退记录，切换回来时自动重新加载。',
  'settings.performance.discard': '后台标签页休眠',
  'settings.performance.discardHint': '闲置超过该时长的后台标签页会被释放；播放音频的标签页不会休眠',
  'settings.performance.never': '从不',
  'settings.performance.minutes': '{count} 分钟',
  'settings.performance.oneHour': '1 小时',
  'settings.performance.hours': '{count} 小时',
  'settings.performance.memoryBudget': '内存预算',
  'settings.performance.memoryBudgetHint': '整个浏览器占用超过该值时，从最久未用的后台标签页开始休眠。留空表示不限制',
  'settings.performance.noLimit': '不限制',

  // Downloads
  'settings.downloads.title': '下载',
  'settings.downloads.askWhere': '每次下载前询问保存位置',
  'settings.downloads.location': '下载位置',
  'settings.downloads.defaultFolder': '系统“下载”文件夹',
  'settings.downloads.useDefault': '恢复默认',
  'settings.downloads.change': '更改…',

  // Site permissions
  'settings.permissions.title': '网站权限',
  'settings.permissions.description': '网站默认无法使用这些能力；你在提示中选择“记住”后会出现在这里。',
  'settings.permissions.empty': '暂无已保存的网站权限',
  'settings.permissions.allowed': '允许',
  'settings.permissions.blocked': '禁止',
  'settings.permissions.reset': '重置',
  'settings.permissions.media': '摄像头 / 麦克风',
  'settings.permissions.geolocation': '位置',
  'settings.permissions.notifications': '通知',
  'settings.permissions.clipboardRead': '剪贴板读取',
  'settings.permissions.midiSysex': 'MIDI 设备',
  'settings.permissions.idleDetection': '空闲检测',
  'settings.permissions.windowManagement': '窗口管理',
  'settings.permissions.storageAccess': '第三方 Cookie',
  'settings.permissions.fileSystem': '文件编辑',
  'settings.permissions.openExternal': '打开外部应用'
}

export default zh
