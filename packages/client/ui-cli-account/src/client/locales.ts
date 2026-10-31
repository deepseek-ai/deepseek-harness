/** Locale-owned copy the CLI account surfaces share across plugins; each plugin's own text arrives from the Host. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace of the shared account copy. */
export const NS = 'cliAccount'

/** Chinese dictionary and key source. */
export const zh = {
  close: '关闭',
  'action.cancel': '取消',
  'action.retry': '重试',
  'activation.later': '稍后',
  'failure.details': '排障信息：{details}',
  'notice.action-failed': '操作未完成，请重试',
  'badge.stopped': '未运行',
  'status.stopped': '账号服务未运行',
  'detail.stopped': '暂时无法读取账号状态，可以重试。',
}

/** Every key the shared account surfaces translate. */
export type CliAccountKey = keyof typeof zh

/** English dictionary. */
export const en: Record<CliAccountKey, string> = {
  close: 'Close',
  'action.cancel': 'Cancel',
  'action.retry': 'Retry',
  'activation.later': 'Later',
  'failure.details': 'Diagnostic: {details}',
  'notice.action-failed': 'The action did not finish. Try again.',
  'badge.stopped': 'Not running',
  'status.stopped': 'Account service not running',
  'detail.stopped': 'The account status cannot be read right now. Retry to reconnect.',
}

/** Japanese dictionary. */
export const ja: Record<CliAccountKey, string> = {
  close: '閉じる',
  'action.cancel': 'キャンセル',
  'action.retry': '再試行',
  'activation.later': '後で',
  'failure.details': '診断情報：{details}',
  'notice.action-failed': '操作が完了しませんでした。もう一度お試しください。',
  'badge.stopped': '未稼働',
  'status.stopped': 'アカウントサービスが稼働していません',
  'detail.stopped': 'アカウントの状態を現在読み取れません。再試行して再接続してください。',
}

/** Spanish dictionary. */
export const es: Record<CliAccountKey, string> = {
  close: 'Cerrar',
  'action.cancel': 'Cancelar',
  'action.retry': 'Reintentar',
  'activation.later': 'Más tarde',
  'failure.details': 'Diagnóstico: {details}',
  'notice.action-failed': 'La acción no se completó. Inténtelo de nuevo.',
  'badge.stopped': 'No está en ejecución',
  'status.stopped': 'El servicio de cuentas no está en ejecución',
  'detail.stopped': 'No se puede leer el estado de la cuenta en este momento. Reintente para volver a conectar.',
}

/** French dictionary. */
export const fr: Record<CliAccountKey, string> = {
  close: 'Fermer',
  'action.cancel': 'Annuler',
  'action.retry': 'Réessayer',
  'activation.later': 'Plus tard',
  'failure.details': 'Diagnostic : {details}',
  'notice.action-failed': 'L’action n’a pas abouti. Réessayez.',
  'badge.stopped': 'Ne fonctionne pas',
  'status.stopped': 'Le service de comptes ne fonctionne pas',
  'detail.stopped': 'L’état du compte ne peut pas être lu pour le moment. Réessayez pour vous reconnecter.',
}

/** German dictionary. */
export const de: Record<CliAccountKey, string> = {
  close: 'Schließen',
  'action.cancel': 'Abbrechen',
  'action.retry': 'Erneut versuchen',
  'activation.later': 'Später',
  'failure.details': 'Diagnose: {details}',
  'notice.action-failed': 'Die Aktion wurde nicht abgeschlossen. Versuchen Sie es erneut.',
  'badge.stopped': 'Läuft nicht',
  'status.stopped': 'Kontodienst läuft nicht',
  'detail.stopped': 'Der Kontostatus kann gerade nicht gelesen werden. Versuchen Sie es erneut, um die Verbindung wiederherzustellen.',
}

/** Russian dictionary. */
export const ru: Record<CliAccountKey, string> = {
  close: 'Закрыть',
  'action.cancel': 'Отмена',
  'action.retry': 'Повторить',
  'activation.later': 'Позже',
  'failure.details': 'Диагностика: {details}',
  'notice.action-failed': 'Действие не завершено. Повторите попытку.',
  'badge.stopped': 'Не работает',
  'status.stopped': 'Служба аккаунтов не работает',
  'detail.stopped': 'Сейчас не удаётся прочитать состояние аккаунта. Повторите попытку, чтобы переподключиться.',
}

/** Portuguese dictionary. */
export const pt: Record<CliAccountKey, string> = {
  close: 'Fechar',
  'action.cancel': 'Cancelar',
  'action.retry': 'Tentar novamente',
  'activation.later': 'Mais tarde',
  'failure.details': 'Diagnóstico: {details}',
  'notice.action-failed': 'A ação não foi concluída. Tente novamente.',
  'badge.stopped': 'Não está em execução',
  'status.stopped': 'O serviço de contas não está em execução',
  'detail.stopped': 'Não é possível ler o estado da conta agora. Tente novamente para reconectar.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    cliAccount: CliAccountKey
  }
}
