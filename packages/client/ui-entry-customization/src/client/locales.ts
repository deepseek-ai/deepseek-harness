/** Copy for the More menu rows: pin actions, footer actions, and Creator draft prompts per region. */
export const en = {
  'pin.sidebar': 'Pin to left sidebar',
  'unpin.sidebar': 'Unpin from left sidebar',
  'pin.conversation': 'Pin to conversation tabs',
  'unpin.conversation': 'Unpin from conversation tabs',
  'pin.rightbar': 'Pin to right sidebar',
  'unpin.rightbar': 'Unpin from right sidebar',
  pinLabel: '{action}: {name}',
  install: 'Browse other plugins',
  create: 'Create your plugin',
  'createPrompt.sidebar': 'Create a DSH plugin with a left sidebar entry.',
  'createPrompt.conversation': 'Create a DSH conversation view plugin.',
  'createPrompt.rightbar': 'Create a DSH plugin with a right sidebar entry.',
} as const

/** Chinese counterpart of the entry-customization dictionary. */
export const zh: Record<keyof typeof en, string> = {
  'pin.sidebar': '固定到左侧栏',
  'unpin.sidebar': '从左侧栏取消固定',
  'pin.conversation': '固定到会话标签栏',
  'unpin.conversation': '从会话标签栏取消固定',
  'pin.rightbar': '固定到右侧栏',
  'unpin.rightbar': '从右侧栏取消固定',
  pinLabel: '{action}：{name}',
  install: '浏览更多插件',
  create: '创建你的插件',
  'createPrompt.sidebar': '创建一个带左侧栏入口的 DSH 插件。',
  'createPrompt.conversation': '创建一个 DSH 会话视图插件。',
  'createPrompt.rightbar': '创建一个带右侧栏入口的 DSH 插件。',
}
