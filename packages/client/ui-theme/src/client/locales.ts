/** `settings.theme` namespace dictionaries (the Appearance and font settings rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',
  'fontSize.text.title': '字号大小',
  'fontSize.text.description': '仅影响会话内容的字号',
  'fontSize.text.increase': '增大字号',
  'fontSize.text.decrease': '减小字号',
  'fontSize.code.title': '代码字号',
  'fontSize.code.description': '用于代码块、行内代码与工具输出',
  'fontSize.code.increase': '增大代码字号',
  'fontSize.code.decrease': '减小代码字号',
  'fontSize.terminal.title': '终端字号',
  'fontSize.terminal.description': '用于侧栏终端',
  'fontSize.terminal.increase': '增大终端字号',
  'fontSize.terminal.decrease': '减小终端字号',
  'fontSize.unit': 'px',
  'fontFamily.text.title': '正文字体',
  'fontFamily.text.description': '用于界面与会话正文。多个字体用逗号分隔，留空使用默认字体',
  'fontFamily.code.title': '代码字体',
  'fontFamily.code.description': '用于代码块、行内代码与工具输出。多个字体用逗号分隔，留空使用默认字体',
  'fontFamily.terminal.title': '终端字体',
  'fontFamily.terminal.description': '用于侧栏终端。多个字体用逗号分隔，留空使用默认字体',
  'fontFamily.placeholder': '默认',
  'fontSize.more': '更多字体设置',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',
  'fontSize.text.title': 'Font size',
  'fontSize.text.description': 'Only affects conversation content',
  'fontSize.text.increase': 'Increase font size',
  'fontSize.text.decrease': 'Decrease font size',
  'fontSize.code.title': 'Code font size',
  'fontSize.code.description': 'Used for code blocks, inline code, and tool output',
  'fontSize.code.increase': 'Increase code font size',
  'fontSize.code.decrease': 'Decrease code font size',
  'fontSize.terminal.title': 'Terminal font size',
  'fontSize.terminal.description': 'Used for the sidebar terminal',
  'fontSize.terminal.increase': 'Increase terminal font size',
  'fontSize.terminal.decrease': 'Decrease terminal font size',
  'fontSize.unit': 'px',
  'fontFamily.text.title': 'Text font',
  'fontFamily.text.description': 'Used for the interface and conversation text. Separate fonts with commas; leave empty for the default',
  'fontFamily.code.title': 'Code font',
  'fontFamily.code.description': 'Used for code blocks, inline code, and tool output. Separate fonts with commas; leave empty for the default',
  'fontFamily.terminal.title': 'Terminal font',
  'fontFamily.terminal.description': 'Used for the sidebar terminal. Separate fonts with commas; leave empty for the default',
  'fontFamily.placeholder': 'Default',
  'fontSize.more': 'More font settings',
} satisfies Record<ThemeKey, string>
