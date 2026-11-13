/** Profile entry id used by the Timeline settings form. */
export const TIMELINE_CONFIG_ID = 'timeline-experimental'
/** Reports and the sidebar never operate below minute resolution. */
export const MINUTE_MS = 60000
/** Maximum number of characters in one editable prompt. */
export const PROMPT_LIMIT = 32768
/** The settings defaults are also used while the client loads its configuration. */
export const defaultReportCadence = { intervalMs: 15 * MINUTE_MS, rollupFactors: [4, 4] } as const
/** Display window in milliseconds. Session logs retain their original records. */
export const HISTORY_MS = 7 * 24 * 60 * MINUTE_MS
/** Maximum active discussions in one Session. */
export const MAX_ANNOTATIONS = 512
/** Languages that Timeline can request from the model. */
export const outputLanguages = ['en', 'zh-CN', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const
/** Language options including the current app language. */
export const languages = ['ui', ...outputLanguages] as const
/** A fixed output language or the app preference. */
export type Language = (typeof languages)[number]
/** One language supported for Timeline model output. */
export type OutputLanguage = (typeof outputLanguages)[number]
/** Native names also identify the required language in model instructions. */
export const languageText: Record<OutputLanguage, { label: string; noActivity: string; priority: string }> = {
  en: {
    label: 'English',
    noActivity: 'No activity.',
    priority: 'Timeline priority changed',
  },
  'zh-CN': {
    label: '简体中文',
    noActivity: '无活动。',
    priority: '时间线优先级已更改',
  },
  ja: {
    label: '日本語',
    noActivity: '活動はありません。',
    priority: 'タスクの優先度が変更されました',
  },
  es: {
    label: 'Español',
    noActivity: 'Sin actividad.',
    priority: 'Cambió la prioridad de las tareas',
  },
  fr: {
    label: 'Français',
    noActivity: 'Aucune activité.',
    priority: 'La priorité des tâches a changé',
  },
  de: {
    label: 'Deutsch',
    noActivity: 'Keine Aktivität.',
    priority: 'Aufgabenpriorität geändert',
  },
  ru: {
    label: 'Русский',
    noActivity: 'Нет активности.',
    priority: 'Приоритет задач изменён',
  },
  pt: {
    label: 'Português (Brasil)',
    noActivity: 'Sem atividade.',
    priority: 'A prioridade das tarefas mudou',
  },
}
/** Supported counts of displayed decimal places. */
export const progressPrecisions = [0, 1, 2, 3] as const
/** Number of displayed decimal places. */
export type ProgressPrecision = (typeof progressPrecisions)[number]

/**
 * Resolve Harness language tags; unsupported language packs use English output.
 * @param locale - the active app locale or its client service.
 * @returns a supported model language, falling back to English.
 */
export function appLanguage(locale: string): OutputLanguage {
  const primary = locale.toLowerCase().split('-')[0]
  if (primary === 'zh') return 'zh-CN'
  return outputLanguages.find(language => language === primary) ?? 'en'
}

/**
 * Resolve the configured language against the app preference.
 * @param language - configured Timeline language.
 * @param uiLanguage - current app language when following the app.
 * @returns the resolved model output language.
 */
export function outputLanguage(language: Language, uiLanguage: OutputLanguage): OutputLanguage {
  return language === 'ui' ? uiLanguage : language
}

/**
 * Language applies only to saved task-tree content, not the agent's other work.
 * @param language - configured Timeline language.
 * @param uiLanguage - current app language when following the app.
 * @returns the language rule for task content only.
 */
export function taskLanguageInstruction(language: Language, uiLanguage: OutputLanguage = 'en'): string {
  return `For Timeline task-tree content only, write titles, descriptions, progress notes, results, and discussion replies in ${languageText[outputLanguage(language, uiLanguage)].label}. Follow the user's language instructions for all other work and conversation.`
}

/**
 * Fixed policy used only in independent report queries.
 * @param language - configured Timeline language.
 * @param uiLanguage - current app language when following the app.
 * @returns the language rule for report content.
 */
export function languageInstruction(language: Language, uiLanguage: OutputLanguage = 'en'): string {
  return `All titles, descriptions, user-facing texts must be written in ${languageText[outputLanguage(language, uiLanguage)].label}.`
}

/**
 * Round a timestamp down to a whole minute.
 * @param time - wall clock timestamp in milliseconds.
 * @returns the start time of the enclosing minute.
 */
export function minuteAt(time: number): number {
  return Math.floor(time / MINUTE_MS) * MINUTE_MS
}
