/**
 * `schedule.catalog` namespace dictionaries: the Session header catalog and the
 * Sidebar row mark with its hover-card task section.
 */
import { frequencyEn, frequencyJa, frequencyEs, frequencyFr, frequencyDe, frequencyRu, frequencyPt, frequencyZh } from './frequency-locales.ts'

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

/** Japanese copy, checked against the English keys. */
export const ja = {
  ...frequencyJa,
  'trigger.label': 'リマインダー',
  'list.loading': 'リマインダーを読み込み中…',
  'list.error': 'リマインダーを読み込めませんでした。',
  'list.retry': '再試行',
  'delete.action': '削除',
  'delete.pending': '削除中…',
  'delete.label': 'リマインダーを削除: {title}',
  'list.open': 'リマインダーの詳細を開く: {title}',
  'trigger.one': '{count}件のリマインダー',
  'trigger.other': '{count}件のリマインダー',
  'list.aria': '有効なリマインダー',
  'list.nextRun': '次回実行',
  'frequency.once': '1回のみ',
  'frequency.every': '{value}{unit}ごと',
  'mark.aria': 'スケジュールされたタスク {count}件',
  'hover.more': '他 {count}件',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'trigger.label': 'Recordatorios',
  'list.loading': 'Cargando recordatorios…',
  'list.error': 'No se pudieron cargar los recordatorios.',
  'list.retry': 'Reintentar',
  'delete.action': 'Eliminar',
  'delete.pending': 'Eliminando…',
  'delete.label': 'Eliminar recordatorio: {title}',
  'list.open': 'Abrir detalles del recordatorio: {title}',
  'trigger.one': 'Recordatorio de {count}',
  'trigger.other': 'Recordatorios de {count}',
  'list.aria': 'Recordatorios activos',
  'list.nextRun': 'Próxima ejecución',
  'frequency.once': 'una vez',
  'frequency.every': 'Cada {value} {unit}',
  ...frequencyEs,
  'mark.aria': 'Tareas programadas {count}',
  'hover.more': '{count} más',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'trigger.label': 'Rappels',
  'list.loading': 'Chargement des rappels…',
  'list.error': 'Impossible de charger les rappels.',
  'list.retry': 'Réessayer',
  'delete.action': 'Supprimer',
  'delete.pending': 'Suppression…',
  'delete.label': 'Supprimer le rappel : {title}',
  'list.open': 'Détails du rappel ouvert : {title}',
  'trigger.one': 'Rappel {count}',
  'trigger.other': 'Rappels {count}',
  'list.aria': 'Rappels actifs',
  'list.nextRun': 'Prochaine exécution',
  'frequency.once': 'Une fois',
  'frequency.every': 'Chaque {value} {unit}',
  ...frequencyFr,
  'mark.aria': 'Tâches planifiées {count}',
  'hover.more': '{count} plus',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'trigger.label': 'Erinnerungen',
  'list.loading': 'Erinnerungen werden geladen…',
  'list.error': 'Erinnerungen konnten nicht geladen werden.',
  'list.retry': 'Erneut versuchen',
  'delete.action': 'Löschen',
  'delete.pending': 'Löschen…',
  'delete.label': 'Erinnerung löschen: {title}',
  'list.open': 'Offene Erinnerungsdetails: {title}',
  'trigger.one': '{count} Erinnerung',
  'trigger.other': '{count} Erinnerungen',
  'list.aria': 'Aktive Erinnerungen',
  'list.nextRun': 'Nächster Lauf',
  'frequency.once': 'Einmal',
  'frequency.every': 'Jeder {value} {unit}',
  ...frequencyDe,
  'mark.aria': '{count} geplante Aufgaben',
  'hover.more': '{count} mehr',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'trigger.label': 'Напоминания',
  'list.loading': 'Загрузка напоминаний…',
  'list.error': 'Не удалось загрузить напоминания.',
  'list.retry': 'Повторить',
  'delete.action': 'Удалить',
  'delete.pending': 'Удаление…',
  'delete.label': 'Удалить напоминание: {title}',
  'list.open': 'Открыть детали напоминания: {title}.',
  'trigger.one': '{count} напоминание',
  'trigger.other': '{count} напоминания',
  'list.aria': 'Активные напоминания',
  'list.nextRun': 'Следующий запуск',
  'frequency.once': 'Однажды',
  'frequency.every': 'Каждый {value} {unit}',
  ...frequencyRu,
  'mark.aria': '{count} запланированные задачи',
  'hover.more': '{count} подробнее',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'trigger.label': 'Lembretes',
  'list.loading': 'Carregando lembretes…',
  'list.error': 'Não foi possível carregar os lembretes.',
  'list.retry': 'Tentar novamente',
  'delete.action': 'Excluir',
  'delete.pending': 'Excluindo…',
  'delete.label': 'Excluir lembrete: {title}',
  'list.open': 'Detalhes do lembrete aberto: {title}',
  'trigger.one': '{count} lembrete',
  'trigger.other': '{count} lembretes',
  'list.aria': 'Lembretes ativos',
  'list.nextRun': 'Próxima execução',
  'frequency.once': 'Uma vez',
  'frequency.every': 'A cada {value} {unit}',
  ...frequencyPt,
  'mark.aria': '{count} tarefas agendadas',
  'hover.more': '{count} mais',
} satisfies Record<keyof typeof en, string>
