/** Locale-owned approval text; reviewer reasons remain verbatim in every language. */

/** English approval messages. */
export const en = {
  denied: 'Auto review denied this call.',
  deniedWithReason: (reason: string): string => `Auto review denied this call: ${reason}`,
}

/** Chinese approval messages. */
export const zh = {
  denied: 'Auto review 拒绝了此调用。',
  deniedWithReason: (reason: string): string => `Auto review 拒绝了此调用：${reason}`,
} satisfies typeof en

/** Japanese approval messages. */
export const ja = {
  denied: '自動認可レビューがこの呼び出しを拒否しました。',
  deniedWithReason: (reason: string): string => `自動認可レビューがこの呼び出しを拒否しました：${reason}`,
} satisfies typeof en

/** Spanish dictionary, checked against the English keys. */
export const es = {
  denied: 'Auto review ha denegado esta llamada.',
  deniedWithReason: (reason: string): string => `Auto review ha denegado esta llamada: ${reason}`,
} satisfies typeof en

/** French dictionary, checked against the English keys. */
export const fr = {
  denied: 'Auto review a refusé cet appel.',
  deniedWithReason: (reason: string): string => `Auto review a refusé cet appel : ${reason}`,
} satisfies typeof en

/** German dictionary, checked against the English keys. */
export const de = {
  denied: 'Auto review hat diesen Aufruf abgelehnt.',
  deniedWithReason: (reason: string): string => `Auto review hat diesen Aufruf abgelehnt: ${reason}`,
} satisfies typeof en

/** Russian dictionary, checked against the English keys. */
export const ru = {
  denied: 'Auto review отклонила этот вызов.',
  deniedWithReason: (reason: string): string => `Auto review отклонила этот вызов: ${reason}`,
} satisfies typeof en

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  denied: 'Auto review negou esta chamada.',
  deniedWithReason: (reason: string): string => `Auto review negou esta chamada: ${reason}`,
} satisfies typeof en

/**
 * Build all display translations without translating the reviewer's raw reason.
 * @param reason - optional reviewer explanation.
 * @returns text for the Client's localized-text resolver.
 */
export function deniedDisplayReason(reason?: string): Record<'en' | 'zh' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt', string> {
  return reason === undefined
    ? { en: en.denied, zh: zh.denied, ja: ja.denied, es: es.denied, fr: fr.denied, de: de.denied, ru: ru.denied, pt: pt.denied }
    : {
      en: en.deniedWithReason(reason),
      zh: zh.deniedWithReason(reason),
      ja: ja.deniedWithReason(reason),
      es: es.deniedWithReason(reason),
      fr: fr.deniedWithReason(reason),
      de: de.deniedWithReason(reason),
      ru: ru.deniedWithReason(reason),
      pt: pt.deniedWithReason(reason),
    }
}
