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

  'arcImport.settings.section': '从 Arc 导入',
  'arcImport.settings.everything': '侧边栏和扩展',
  'arcImport.settings.sidebarHint': '{folders} 个文件夹中的 {tabs} 个置顶标签页，{favorites} 个收藏',
  'arcImport.settings.extensionsHint': '{count} 个扩展',
  'arcImport.settings.import': '导入…',
  'arcImport.palette.command': '从 Arc 导入…',
  'arcImport.palette.keywords': 'import,arc,bookmarks,folders,pinned,favorites,sidebar,导入,书签,文件夹,置顶,收藏',
  'arcImport.notFound': '没有在这台 Mac 上找到 Arc 的侧边栏数据',
  'arcImport.nothing': 'Arc 的侧边栏里没有可导入的内容',
  'arcImport.confirm.message': '导入 Arc 的侧边栏？',
  'arcImport.confirm.detail':
    '找到 {spaces} 个空间中的 {tabs} 个置顶标签页、{folders} 个文件夹，以及 {favorites} 个收藏。\n\n置顶标签页和文件夹会放进同名空间（没有就新建；Arc 未命名的空间对应你的第一个空间）。收藏会变成收藏图块。不会重复添加，再导入一次也没关系。Today 标签页、笔记和画板不会导入。',
  'arcImport.confirm.import': '导入',
  'arcImport.all.message': '从 Arc 导入？',
  'arcImport.all.sidebar': '侧边栏：{folders} 个文件夹中的 {tabs} 个置顶标签页，{favorites} 个收藏',
  'arcImport.all.extensions': '扩展（{count} 个）：{names}',
  'arcImport.all.note': '置顶标签页和文件夹会放进同名空间，不会重复添加，再导一次也没关系。扩展数据（钱包、设置、登录状态）不会复制。',
  'arcImport.all.notNow': '以后再说',
  'arcImport.all.installing': '正在从 Arc 安装 {count} 个扩展…',
  'arcImport.result.message': '已从 Arc 导入',
  'arcImport.result.detail':
    '新增 {tabs} 个置顶标签页、{folders} 个文件夹和 {favorites} 个收藏；{duplicates} 项已存在，已跳过。网站图标会陆续显示。'
}

export default zh
