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

/** Japanese copy, checked against the English keys. */
export const ja = {
  'pin.sidebar': '左サイドバーに固定',
  'unpin.sidebar': '左サイドバーから固定解除',
  'pin.conversation': '会話タブに固定',
  'unpin.conversation': '会話タブから固定解除',
  'pin.rightbar': '右サイドバーに固定',
  'unpin.rightbar': '右サイドバーから固定解除',
  'pinLabel': '{action}: {name}',
  'install': '他のプラグインを探す',
  'create': 'プラグインを作成',
  'createPrompt.sidebar': '左サイドバーにエントリを持つ DSH プラグインを作成します。',
  'createPrompt.conversation': 'DSH 会話ビュープラグインを作成します。',
  'createPrompt.rightbar': '右サイドバーにエントリを持つ DSH プラグインを作成します。',
} satisfies Record<keyof typeof en, string>
