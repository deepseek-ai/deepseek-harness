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

/**
 * Build all display translations without translating the reviewer's raw reason.
 * @param reason - optional reviewer explanation.
 * @returns text for the Client's localized-text resolver.
 */
export function deniedDisplayReason(reason?: string): Record<'en' | 'zh' | 'ja', string> {
  return reason === undefined
    ? { en: en.denied, zh: zh.denied, ja: ja.denied }
    : { en: en.deniedWithReason(reason), zh: zh.deniedWithReason(reason), ja: ja.deniedWithReason(reason) }
}
