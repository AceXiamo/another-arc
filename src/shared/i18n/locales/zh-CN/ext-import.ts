import type en from '../en/ext-import'

const zh: Record<keyof typeof en, string> = {
  'extImport.button': '从 {browser} 导入',
  'extImport.button.busy': '正在导入…',
  'extImport.button.title': '复制你在 {browser} 个人资料“{profile}”中启用的扩展',
  'extImport.palette.command': '从 {browser} 导入扩展…',
  'extImport.palette.keywords': '导入, 导入扩展, 迁移扩展',

  'extImport.confirm.message': '要从你的 {browser} 个人资料“{profile}”导入扩展吗？',
  'extImport.confirm.toImport': '将导入（{count} 个）：',
  'extImport.confirm.skipped': '将跳过（{count} 个）：',
  'extImport.confirm.note': '只复制扩展本身的文件，扩展数据（钱包、设置、登录状态）仍留在 {browser} 中。不会改动 {browser}。',
  'extImport.confirm.import': '导入',
  'extImport.item': '{name} {version}',
  'extImport.itemWithReason': '{name}：{reason}',

  'extImport.skip.disabled': '在 {browser} 中已停用',
  'extImport.skip.installed': '已安装',
  'extImport.skip.manifestVersion': '不支持 manifest 版本 {version}',
  'extImport.skip.unreadable': '文件缺失或无法读取',
  'extImport.skip.crashes': '会导致本浏览器崩溃',
  'extImport.skip.newTab': '会替换新标签页，本浏览器不支持',

  'extImport.nothing.message': '你的 {browser} 个人资料“{profile}”中没有可导入的新扩展',
  'extImport.notFound.message': '没有找到 {browser} 的扩展',
  'extImport.notFound.detail': '在 {path} 中查找最近使用的 {browser} 个人资料',

  'extImport.result.done': '已从 {browser} 导入扩展',
  'extImport.result.partial': '部分扩展未能从 {browser} 导入',
  'extImport.result.failed': '未能从 {browser} 导入扩展',
  'extImport.result.count': '已导入：{count} / {total}',
  'extImport.result.failedHeading': '未能导入（{count} 个）：',
  'extImport.result.dataNote':
    '扩展数据不会被复制：钱包、设置和登录状态仍留在 {browser} 中。请用助记词重新恢复每个钱包，并重新登录各个扩展。',

  'arcImport.notFound': '没有在这台 Mac 上找到 Arc 的侧边栏数据',
  'arcImport.nothing': 'Arc 的侧边栏里没有可导入的内容',
  'arcImport.confirm.message': '导入 Arc 的侧边栏？',
  'arcImport.confirm.detail':
    '找到 {spaces} 个空间中的 {tabs} 个置顶标签页、{folders} 个文件夹，以及 {favorites} 个收藏。\n\n置顶标签页和文件夹会放进同名空间（没有就新建；Arc 未命名的空间对应你的第一个空间）。收藏会变成收藏图块。不会重复添加，再导入一次也没关系。Today 标签页、笔记和画板不会导入。',
  'arcImport.confirm.import': '导入',
  'arcImport.result.message': '已从 Arc 导入',
  'arcImport.result.detail':
    '新增 {tabs} 个置顶标签页、{folders} 个文件夹和 {favorites} 个收藏；{duplicates} 项已存在，已跳过。网站图标会陆续显示。',

  // 从其他浏览器导入：书签、扩展、登录态
  'browserImport.settings.section': '从其他浏览器导入',
  'browserImport.settings.profile': '配置',
  'browserImport.settings.import': '导入…',
  'browserImport.settings.bookmarks': '{folders} 个文件夹中的 {tabs} 个书签',
  'browserImport.settings.extensions': '{count} 个扩展',
  'browserImport.settings.logins': '{hosts} 个网站的登录状态',
  'browserImport.palette.command': '从其他浏览器导入…',
  'browserImport.palette.keywords':
    'import,browser,arc,chrome,edge,brave,bookmarks,folders,favorites,cookies,logins,导入,浏览器,书签,文件夹,收藏,登录',
  'browserImport.nothing': '{browser} 里没有可导入的内容',
  'browserImport.all.message': '从 {browser} 导入？',
  'browserImport.all.profile': '配置：{profile}',
  'browserImport.all.bookmarks': '书签：{folders} 个文件夹中的 {tabs} 个，{favorites} 个收藏',
  'browserImport.all.extensions': '扩展（{count} 个）：{names}',
  'browserImport.all.session':
    '登录状态：{hosts} 个网站的 {cookies} 个 cookie，以及 {mb} MB 网站数据（localStorage，以及 {sites} 个网站的 IndexedDB）',
  'browserImport.all.note':
    '书签会放进同名空间，不会重复添加，再导一次也没关系。扩展自身的数据（钱包、设置、扩展内的账号）不会复制。',
  'browserImport.all.notNow': '以后再说',
  'browserImport.all.installing': '正在安装 {count} 个扩展…',
  'browserImport.confirm.import': '导入',
  'browserImport.result.message': '已从 {browser} 导入',
  'browserImport.result.bookmarks':
    '新增 {tabs} 个书签、{folders} 个文件夹和 {favorites} 个收藏；{duplicates} 项已存在，已跳过。网站图标会陆续显示。',
  'browserImport.session.checkbox': '同时导入登录状态',
  'browserImport.session.note':
    'macOS 会先让你允许访问 {browser} 的钥匙串条目，不允许就读不出它的 cookie。网站数据在下次启动时移入：localStorage 会替换这个配置现有的，旧的留一份备份在旁边；IndexedDB 按网站逐个合并，本地已经有数据的网站一律不动。扩展自身的存储一概不复制。建议先退出 {browser}，让它把数据都写完。把会话绑定到设备的网站（passkey、设备绑定会话）仍然需要重新登录。',
  'browserImport.session.importing': '正在从 {browser} 导入登录状态…',
  'browserImport.session.result.cookies': '登录状态：导入 {count} 个 cookie，跳过 {skipped} 个',
  'browserImport.session.result.partitioned': '另有 {count} 个属于嵌入式站点，无法迁移',
  'browserImport.session.result.staged': '网站数据（{mb} MB，含 {sites} 个网站的 IndexedDB）已就绪，重启后生效',
  'browserImport.session.result.noKey': '登录状态：没能读取 {browser} 的钥匙串条目，cookie 未导入',
  'browserImport.session.result.unreadable': '登录状态：没能读取 {browser} 的 cookie 数据库',
  'browserImport.session.restart.message': '重启以完成网站数据导入？',
  'browserImport.session.restart.detail':
    '{browser} 的 localStorage 和 IndexedDB 已经复制好了。它们要在没有页面打开时移入，所以重启后才会生效。',
  'browserImport.session.restart.now': '立即重启',
  'browserImport.session.restart.later': '稍后',

  'extWindow.fallbackTitle': '扩展',
  'extWindow.menu.close': '关闭窗口',
  'extWindow.button.openTitle': '{title}（点按关闭）'
}

export default zh
