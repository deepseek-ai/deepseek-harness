/**
 * `schedule.catalog` namespace dictionaries: the Session header catalog and the
 * Sidebar row mark with its hover-card task section.
 */
import { frequencyEn, frequencyZh } from './frequency-locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'schedule.catalog'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger.label': '提醒',
  'list.loading': '正在加载提醒…',
  'list.error': '无法加载提醒。',
  'list.retry': '重试',
  'delete.action': '删除',
  'delete.pending': '正在删除…',
  'delete.label': '删除提醒：{title}',
  'list.open': '打开提醒详情：{title}',
  'trigger.one': '{count} 个提醒',
  'trigger.other': '{count} 个提醒',
  'list.aria': '活动提醒',
  'list.nextRun': '下次运行',
  'frequency.once': '单次',
  'frequency.every': '{value}{unit}一次',
  ...frequencyZh,
  'mark.aria': '{count} 个自动化任务',
  'hover.more': '另有 {count} 个任务',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<ScheduleCatalogKey, string> = {
  'trigger.label': 'Reminders',
  'list.loading': 'Loading reminders…',
  'list.error': 'Could not load reminders.',
  'list.retry': 'Retry',
  'delete.action': 'Delete',
  'delete.pending': 'Deleting…',
  'delete.label': 'Delete reminder: {title}',
  'list.open': 'Open reminder details: {title}',
  'trigger.one': '{count} reminder',
  'trigger.other': '{count} reminders',
  'list.aria': 'Active reminders',
  'list.nextRun': 'Next run',
  'frequency.once': 'Once',
  'frequency.every': 'Every {value} {unit}',
  ...frequencyEn,
  'mark.aria': '{count} scheduled tasks',
  'hover.more': '{count} more',
}

/** Key domain of the Schedule catalog namespace. */
export type ScheduleCatalogKey = keyof typeof zh
