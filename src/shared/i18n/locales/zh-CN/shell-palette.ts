import type en from '../en/shell-palette'

const zh: Record<keyof typeof en, string> = {
  'palette.input.searchPlaceholder': '搜索或输入网址',
  'palette.input.editUrlPlaceholder': '输入网址或搜索',

  'palette.command.openPage': '打开{page}',
  'palette.command.newSpace': '新建空间',
  'palette.command.reopenClosedTab': '重新打开关闭的标签页',
  'palette.command.toggleSidebar': '切换侧边栏',
  'palette.command.loadUnpackedExtension': '加载已解压的扩展…',

  'palette.keywords.newSpace': '新建空间',
  'palette.keywords.reopenClosedTab': '重新打开, 恢复',
  'palette.keywords.toggleSidebar': '侧边栏',
  'palette.keywords.loadUnpackedExtension': '安装扩展',

  'palette.hint.switchToTab': '切换到标签页',
  'palette.hint.current': '当前',
  'palette.hint.go': '前往',
  'palette.hint.command': '命令',

  'palette.subtitle.searchWith': '使用 {engine} 搜索',

  'find.placeholder': '在页面中查找',
  'find.previous': '上一个 (⇧↩)',
  'find.next': '下一个 (↩)',
  'find.close': '关闭 (Esc)'
}

export default zh
