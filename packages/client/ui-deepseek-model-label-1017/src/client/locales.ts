/** Localized label of the fixed release marker. */

/** Simplified Chinese badge copy. */
export const zh = { 'badge.label': '1017' }

/** Keys owned by the release-label namespace. */
export type LabelKey = keyof typeof zh

/** English badge copy. */
export const en: Record<LabelKey, string> = { 'badge.label': '1017' }

/** Japanese copy, checked against the English keys. */
export const ja = {
  'badge.label': '1017',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = { 'badge.label': '1017' } satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = { 'badge.label': '1017' } satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = { 'badge.label': '1017' } satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = { 'badge.label': '1017' } satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = { 'badge.label': '1017' } satisfies Record<keyof typeof en, string>
