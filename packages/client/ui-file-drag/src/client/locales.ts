/** File drag failure copy owned by the transfer plugin. */
export const zh = { failed: '拖放失败，请重试' }

/** English file drag failure copy. */
export const en = { failed: 'Drag failed. Try again.' } satisfies Record<keyof typeof zh, string>

/** Japanese file drag failure copy. */
export const ja = { failed: 'ドラッグ＆ドロップに失敗しました。もう一度お試しください。' } satisfies Record<keyof typeof zh, string>

/** Spanish dictionary, checked against the English keys. */
export const es = { failed: 'Error al arrastrar. Intentar otra vez.' } satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = { failed: 'Le glissement a échoué. Essayer à nouveau.' } satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = { failed: 'Ziehen ist fehlgeschlagen. Versuchen Sie es erneut.' } satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = { failed: 'Перетащить не удалось. Попробуйте еще раз.' } satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = { failed: 'Falha ao arrastar. Tente novamente.' } satisfies Record<keyof typeof en, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File transfer failure feedback. */
    fileDrag: keyof typeof zh
  }
}
