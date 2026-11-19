/** `compaction` namespace dictionaries: the summary title and read failures. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'preview.title': '上下文摘要',
  'preview.loading': '正在加载摘要…',
  'preview.notFound': '摘要不可用：预览服务不可用，或摘要记录缺失、为空或无效。',
  'preview.readFailed': '无法读取摘要',
} satisfies Record<string, string>

/** Compaction preview dictionary key union. */
export type CompactionKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'preview.title': 'Context summary',
  'preview.loading': 'Loading summary…',
  'preview.notFound': 'Summary unavailable: the preview service is unavailable, or the summary record is missing, empty or invalid.',
  'preview.readFailed': 'Unable to read the summary',
} satisfies Record<CompactionKey, string>

/** Japanese dictionary. */
export const ja = {
  'preview.title': 'コンテキストの要約',
  'preview.loading': '要約を読み込み中…',
  'preview.notFound': '要約を利用できません。プレビューサービスが利用できないか、要約が存在しない、空、または無効です。',
  'preview.readFailed': '要約を読み込めません',
} satisfies Record<CompactionKey, string>

/** Spanish dictionary. */
export const es = {
  'preview.title': 'Resumen del contexto',
  'preview.loading': 'Cargando resumen…',
  'preview.notFound': 'Resumen no disponible: el servicio no está disponible o el registro falta, está vacío o no es válido.',
  'preview.readFailed': 'No se pudo leer el resumen',
} satisfies Record<CompactionKey, string>

/** French dictionary. */
export const fr = {
  'preview.title': 'Résumé du contexte',
  'preview.loading': 'Chargement du résumé…',
  'preview.notFound': 'Résumé indisponible : le service est indisponible ou le résumé est absent, vide ou invalide.',
  'preview.readFailed': 'Impossible de lire le résumé',
} satisfies Record<CompactionKey, string>

/** German dictionary. */
export const de = {
  'preview.title': 'Kontextzusammenfassung',
  'preview.loading': 'Zusammenfassung wird geladen…',
  'preview.notFound': 'Zusammenfassung nicht verfügbar: Der Dienst ist nicht verfügbar oder der Eintrag fehlt, ist leer oder ungültig.',
  'preview.readFailed': 'Zusammenfassung konnte nicht gelesen werden',
} satisfies Record<CompactionKey, string>

/** Russian dictionary. */
export const ru = {
  'preview.title': 'Сводка контекста',
  'preview.loading': 'Загрузка сводки…',
  'preview.notFound': 'Сводка недоступна: сервис недоступен либо запись отсутствует, пуста или недействительна.',
  'preview.readFailed': 'Не удалось прочитать сводку',
} satisfies Record<CompactionKey, string>

/** Portuguese dictionary. */
export const pt = {
  'preview.title': 'Resumo do contexto',
  'preview.loading': 'Carregando resumo…',
  'preview.notFound': 'Resumo indisponível: o serviço está indisponível ou o registro está ausente, vazio ou inválido.',
  'preview.readFailed': 'Não foi possível ler o resumo',
} satisfies Record<CompactionKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The compaction summary title and read failures. */
    compaction: CompactionKey
  }
}
