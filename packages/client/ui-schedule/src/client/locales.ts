/**
 * `schedule.catalog` namespace dictionaries: the Session header catalog and the
 * Sidebar row mark with its hover-card task section.
 */
import { frequencyEn, frequencyJa, frequencyEs, frequencyFr, frequencyDe, frequencyRu, frequencyPt, frequencyZh } from './frequency-locales.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'schedule.catalog'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger.label': '自动化任务',
  'list.loading': '正在加载自动化任务…',
  'list.error': '无法加载自动化任务。',
  'list.retry': '重试',
  'delete.action': '删除',
  'delete.pending': '正在删除…',
  'delete.label': '删除自动化任务：{title}',
  'list.open': '打开自动化任务详情：{title}',
  'trigger.one': '{count} 个自动化任务',
  'trigger.other': '{count} 个自动化任务',
  'list.aria': '已开启的自动化任务',
  'list.nextRun': '下次运行',
  'frequency.once': '单次',
  'frequency.every': '{value}{unit}一次',
  ...frequencyZh,
  'mark.aria': '{count} 个自动化任务',
  'hover.more': '另有 {count} 个任务',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<ScheduleCatalogKey, string> = {
  'trigger.label': 'Automation tasks',
  'list.loading': 'Loading automation tasks…',
  'list.error': 'Could not load automation tasks.',
  'list.retry': 'Retry',
  'delete.action': 'Delete',
  'delete.pending': 'Deleting…',
  'delete.label': 'Delete automation task: {title}',
  'list.open': 'Open automation task details: {title}',
  'trigger.one': '{count} automation task',
  'trigger.other': '{count} automation tasks',
  'list.aria': 'Enabled automation tasks',
  'list.nextRun': 'Next run',
  'frequency.once': 'Once',
  'frequency.every': 'Every {value} {unit}',
  ...frequencyEn,
  'mark.aria': '{count} automation tasks',
  'hover.more': '{count} more',
}

/** Key domain of the Schedule catalog namespace. */
export type ScheduleCatalogKey = keyof typeof zh

/** Japanese copy, checked against the English keys. */
export const ja = {
  ...frequencyJa,
  'trigger.label': '自動化タスク',
  'list.loading': '自動化タスクを読み込み中…',
  'list.error': '自動化タスクを読み込めませんでした。',
  'list.retry': '再試行',
  'delete.action': '削除',
  'delete.pending': '削除中…',
  'delete.label': '自動化タスクを削除: {title}',
  'list.open': '自動化タスクの詳細を開く: {title}',
  'trigger.one': '{count}件の自動化タスク',
  'trigger.other': '{count}件の自動化タスク',
  'list.aria': '有効な自動化タスク',
  'list.nextRun': '次回実行',
  'frequency.once': '1回のみ',
  'frequency.every': '{value}{unit}ごと',
  'mark.aria': '自動化タスク {count}件',
  'hover.more': '他 {count}件',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'trigger.label': 'Tareas de automatización',
  'list.loading': 'Cargando tareas de automatización…',
  'list.error': 'No se pudieron cargar las tareas de automatización.',
  'list.retry': 'Reintentar',
  'delete.action': 'Eliminar',
  'delete.pending': 'Eliminando…',
  'delete.label': 'Eliminar tarea de automatización: {title}',
  'list.open': 'Abrir detalles de la tarea de automatización: {title}',
  'trigger.one': '{count} tarea de automatización',
  'trigger.other': '{count} tareas de automatización',
  'list.aria': 'Tareas de automatización habilitadas',
  'list.nextRun': 'Próxima ejecución',
  'frequency.once': 'una vez',
  'frequency.every': 'Cada {value} {unit}',
  ...frequencyEs,
  'mark.aria': '{count} tareas de automatización',
  'hover.more': '{count} más',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'trigger.label': 'Tâches d\'automatisation',
  'list.loading': 'Chargement des tâches d\'automatisation…',
  'list.error': 'Impossible de charger les tâches d\'automatisation.',
  'list.retry': 'Réessayer',
  'delete.action': 'Supprimer',
  'delete.pending': 'Suppression…',
  'delete.label': 'Supprimer la tâche d\'automatisation : {title}',
  'list.open': 'Ouvrir les détails de la tâche d\'automatisation : {title}',
  'trigger.one': '{count} tâche d\'automatisation',
  'trigger.other': '{count} tâches d\'automatisation',
  'list.aria': 'Tâches d\'automatisation activées',
  'list.nextRun': 'Prochaine exécution',
  'frequency.once': 'Une fois',
  'frequency.every': 'Chaque {value} {unit}',
  ...frequencyFr,
  'mark.aria': '{count} tâches d\'automatisation',
  'hover.more': '{count} plus',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'trigger.label': 'Automatisierungsaufgaben',
  'list.loading': 'Automatisierungsaufgaben werden geladen…',
  'list.error': 'Automatisierungsaufgaben konnten nicht geladen werden.',
  'list.retry': 'Erneut versuchen',
  'delete.action': 'Löschen',
  'delete.pending': 'Löschen…',
  'delete.label': 'Automatisierungsaufgabe löschen: {title}',
  'list.open': 'Details der Automatisierungsaufgabe öffnen: {title}',
  'trigger.one': '{count} Automatisierungsaufgabe',
  'trigger.other': '{count} Automatisierungsaufgaben',
  'list.aria': 'Aktivierte Automatisierungsaufgaben',
  'list.nextRun': 'Nächster Lauf',
  'frequency.once': 'Einmal',
  'frequency.every': 'Jeder {value} {unit}',
  ...frequencyDe,
  'mark.aria': '{count} Automatisierungsaufgaben',
  'hover.more': '{count} mehr',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'trigger.label': 'Задачи автоматизации',
  'list.loading': 'Загрузка задач автоматизации…',
  'list.error': 'Не удалось загрузить задачи автоматизации.',
  'list.retry': 'Повторить',
  'delete.action': 'Удалить',
  'delete.pending': 'Удаление…',
  'delete.label': 'Удалить задачу автоматизации: {title}',
  'list.open': 'Открыть сведения о задаче автоматизации: {title}',
  'trigger.one': '{count} задача автоматизации',
  'trigger.other': '{count} задачи автоматизации',
  'list.aria': 'Включённые задачи автоматизации',
  'list.nextRun': 'Следующий запуск',
  'frequency.once': 'Однажды',
  'frequency.every': 'Каждый {value} {unit}',
  ...frequencyRu,
  'mark.aria': '{count} задачи автоматизации',
  'hover.more': '{count} подробнее',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'trigger.label': 'Tarefas de automação',
  'list.loading': 'Carregando tarefas de automação…',
  'list.error': 'Não foi possível carregar as tarefas de automação.',
  'list.retry': 'Tentar novamente',
  'delete.action': 'Excluir',
  'delete.pending': 'Excluindo…',
  'delete.label': 'Excluir tarefa de automação: {title}',
  'list.open': 'Abrir detalhes da tarefa de automação: {title}',
  'trigger.one': '{count} tarefa de automação',
  'trigger.other': '{count} tarefas de automação',
  'list.aria': 'Tarefas de automação habilitadas',
  'list.nextRun': 'Próxima execução',
  'frequency.once': 'Uma vez',
  'frequency.every': 'A cada {value} {unit}',
  ...frequencyPt,
  'mark.aria': '{count} tarefas de automação',
  'hover.more': '{count} mais',
} satisfies Record<keyof typeof en, string>
