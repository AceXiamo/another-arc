import type en from '../en/shell-sidebar'

const zh: Record<keyof typeof en, string> = {
  'sidebar.header.toggleSidebar': '切换侧边栏 (⌘S)',
  'sidebar.header.back': '后退 (⌘[)',
  'sidebar.header.forward': '前进 (⌘])',
  'sidebar.header.stop': '停止',
  'sidebar.header.reload': '重新加载 (⌘R)',

  'sidebar.address.placeholder': '搜索或输入网址',
  'sidebar.address.resetZoom': '恢复实际大小 (⌘0)',
  'sidebar.address.copyUrl': '拷贝网址 (⇧⌘C)',

  'sidebar.tabs.mute': '静音',
  'sidebar.tabs.unmute': '取消静音',
  'sidebar.tabs.close': '关闭标签页 (⌘W)',

  'sidebar.folders.renameLabel': '文件夹名称',
  'sidebar.folders.empty': '将标签页拖到这里',
  'sidebar.folders.unloadTab': '关闭 (⌘W)，仍保留在侧边栏中',

  'sidebar.resizer.hint': '拖动调整宽度，双击恢复默认',

  'sidebar.spaceBar.settings': '设置 (⌘,)',
  'sidebar.spaceBar.downloads': '下载 (⇧⌘J)',
  'sidebar.spaceBar.newSpace': '新建空间',

  'sidebar.spaceEditor.titleNew': '新建空间',
  'sidebar.spaceEditor.titleEdit': '编辑空间',
  'sidebar.spaceEditor.namePlaceholder': '空间名称',
  'sidebar.spaceEditor.create': '创建',

  'sidebar.permission.cameraAndMicrophone': '想要使用你的摄像头和麦克风',
  'sidebar.permission.camera': '想要使用你的摄像头',
  'sidebar.permission.microphone': '想要使用你的麦克风',
  'sidebar.permission.geolocation': '想要获取你的位置',
  'sidebar.permission.notifications': '想要向你发送通知',
  'sidebar.permission.clipboardRead': '想要查看剪贴板中的文字和图片',
  'sidebar.permission.midiSysex': '想要完全控制 MIDI 设备',
  'sidebar.permission.idleDetection': '想要了解你何时在使用设备',
  'sidebar.permission.windowManagement': '想要管理所有显示器上的窗口',
  'sidebar.permission.storageAccess': '想要使用你在其他网站上的 Cookie 和数据',
  'sidebar.permission.fileSystem': '想要编辑本地文件',
  'sidebar.permission.openExternal': '想要打开外部应用（{scheme}:）',
  'sidebar.permission.other': '想要使用 {permission}',
  'sidebar.permission.remember': '记住我的选择'
}

export default zh
