/** Locale-owned copy the connector account surfaces share; each registrant's own text arrives from the Host. */
import type {} from '@deepseek-ai/dsh-client-ui-slots/client'

/** Dictionary namespace of the shared account copy. */
export const NS = 'connectorAccount'

/** Chinese dictionary and key source. */
export const zh = {
  close: '关闭',
  'action.cancel': '取消',
  'activation.later': '稍后',
  'failure.details': '排障信息：{details}',
  'notice.action-failed': '操作未完成，请重试',
}

/** Every key the shared account surfaces translate. */
export type ConnectorAccountKey = keyof typeof zh

/** English dictionary. */
export const en: Record<ConnectorAccountKey, string> = {
  close: 'Close',
  'action.cancel': 'Cancel',
  'activation.later': 'Later',
  'failure.details': 'Diagnostic: {details}',
  'notice.action-failed': 'The action did not finish. Try again.',
}

/** Japanese dictionary. */
export const ja: Record<ConnectorAccountKey, string> = {
  close: '閉じる',
  'action.cancel': 'キャンセル',
  'activation.later': '後で',
  'failure.details': '診断情報：{details}',
  'notice.action-failed': '操作が完了しませんでした。もう一度お試しください。',
}

/** Spanish dictionary. */
export const es: Record<ConnectorAccountKey, string> = {
  close: 'Cerrar',
  'action.cancel': 'Cancelar',
  'activation.later': 'Más tarde',
  'failure.details': 'Diagnóstico: {details}',
  'notice.action-failed': 'La acción no se completó. Inténtelo de nuevo.',
}

/** French dictionary. */
export const fr: Record<ConnectorAccountKey, string> = {
  close: 'Fermer',
  'action.cancel': 'Annuler',
  'activation.later': 'Plus tard',
  'failure.details': 'Diagnostic : {details}',
  'notice.action-failed': 'L’action n’a pas abouti. Réessayez.',
}

/** German dictionary. */
export const de: Record<ConnectorAccountKey, string> = {
  close: 'Schließen',
  'action.cancel': 'Abbrechen',
  'activation.later': 'Später',
  'failure.details': 'Diagnose: {details}',
  'notice.action-failed': 'Die Aktion wurde nicht abgeschlossen. Versuchen Sie es erneut.',
}

/** Russian dictionary. */
export const ru: Record<ConnectorAccountKey, string> = {
  close: 'Закрыть',
  'action.cancel': 'Отмена',
  'activation.later': 'Позже',
  'failure.details': 'Диагностика: {details}',
  'notice.action-failed': 'Действие не завершено. Повторите попытку.',
}

/** Portuguese dictionary. */
export const pt: Record<ConnectorAccountKey, string> = {
  close: 'Fechar',
  'action.cancel': 'Cancelar',
  'activation.later': 'Mais tarde',
  'failure.details': 'Diagnóstico: {details}',
  'notice.action-failed': 'A ação não foi concluída. Tente novamente.',
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap {
    connectorAccount: ConnectorAccountKey
  }
}
