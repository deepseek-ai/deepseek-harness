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
