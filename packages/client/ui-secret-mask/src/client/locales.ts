/** `secretMask` dictionaries for the per-credential reveal control. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'secretMask'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'secret.reveal': '显示密钥',
  'secret.hide': '隐藏密钥',
} satisfies Record<string, string>

/** The secretMask namespace key union. */
export type SecretMaskKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Accessible names of the control that reveals one masked credential. */
    secretMask: SecretMaskKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'secret.reveal': 'Show secret',
  'secret.hide': 'Hide secret',
} satisfies Record<SecretMaskKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'secret.reveal': 'シークレットを表示',
  'secret.hide': 'シークレットを隠す',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'secret.reveal': 'Mostrar secreto',
  'secret.hide': 'Ocultar secreto',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'secret.reveal': 'Afficher le secret',
  'secret.hide': 'Cacher le secret',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'secret.reveal': 'Geheimnis zeigen',
  'secret.hide': 'Geheimnis verbergen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'secret.reveal': 'Показать секрет',
  'secret.hide': 'Скрыть секрет',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'secret.reveal': 'Mostrar segredo',
  'secret.hide': 'Ocultar segredo',
} satisfies Record<keyof typeof en, string>
