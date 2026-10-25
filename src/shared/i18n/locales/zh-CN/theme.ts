import type en from '../en/theme'

const zh: Record<keyof typeof en, string> = {
  'theme.menu.edit': '编辑主题…',

  'theme.panel.title': '主题',
  'theme.panel.open': '自定义主题',
  'theme.panel.done': '完成',
  'theme.panel.reset': '重置',
  'theme.panel.resetHint': '恢复默认的色调与颗粒',

  'theme.colors.label': '颜色',
  'theme.colors.stop': '颜色 {n}',
  'theme.colors.add': '添加渐变色',
  'theme.colors.remove': '移除颜色 {n}',
  'theme.colors.preset': '使用 {color}',

  'theme.picker.area': '饱和度与亮度',
  'theme.picker.hue': '色相',
  'theme.picker.hex': '十六进制颜色',

  'theme.angle.label': '角度',
  'theme.intensity.label': '浓度',
  'theme.noise.label': '颗粒',
  'theme.noise.off': '关',

  'theme.appearance.label': '外观',
  'theme.appearance.system': '跟随设置',
  'theme.appearance.light': '浅色',
  'theme.appearance.dark': '深色',
  'theme.appearance.systemHint': '跟随“设置”中的外观'
}

export default zh
