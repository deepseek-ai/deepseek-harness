/** `plan` namespace dictionaries (the composer plan chip's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.label': '计划',
  'preview.title': '计划',
  'preview.document': '计划 · Markdown',
  'preview.action': '打开',
  'preview.open': '在侧边栏打开计划',
  'preview.full': '查看全文',
  'preview.openNamed': '打开计划：{title}',
  'preview.loading': '正在读取计划…',
  'preview.failed': '无法读取计划',
  'preview.invalidAddress': '计划地址无效',
  'preview.historyUnavailable': '无法读取会话历史',
  'preview.notFound': '未找到这份计划',
  'preview.unavailable': '计划预览不可用',
  'preview.expired': '临时计划预览已失效，请从仍在等待审批的卡片重新打开。',
  'chip.on.aria': '计划模式已开启，按下关闭',
  'chip.on.title': '计划模式已开启 — 点击关闭（/plan off）',
  'chip.exitFailed': '退出计划模式失败',
} satisfies Record<string, string>

/** The plan namespace key union. */
export type PlanKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'chip.label': 'Plan',
  'preview.title': 'Plan',
  'preview.document': 'Plan · Markdown',
  'preview.action': 'Open',
  'preview.open': 'Open plan in sidebar',
  'preview.full': 'View full plan',
  'preview.openNamed': 'Open plan: {title}',
  'preview.loading': 'Loading plan…',
  'preview.failed': 'Could not load plan',
  'preview.invalidAddress': 'Invalid plan address',
  'preview.historyUnavailable': 'Session history is unavailable',
  'preview.notFound': 'This plan was not found',
  'preview.unavailable': 'Plan preview is unavailable',
  'preview.expired': 'This temporary plan preview has expired. Reopen it from the pending review card.',
  'chip.on.aria': 'Plan mode on, press to turn off',
  'chip.on.title': 'Plan mode on — click to turn off (/plan off)',
  'chip.exitFailed': 'Failed to exit plan mode',
} satisfies Record<PlanKey, string>
