/** File drag failure copy owned by the transfer plugin. */
export const zh = { failed: '拖放失败，请重试' }

/** English file drag failure copy. */
export const en = { failed: 'Drag failed. Try again.' } satisfies Record<keyof typeof zh, string>

/** Japanese file drag failure copy. */
export const ja = { failed: 'ドラッグ＆ドロップに失敗しました。もう一度お試しください。' } satisfies Record<keyof typeof zh, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File transfer failure feedback. */
    fileDrag: keyof typeof zh
  }
}
