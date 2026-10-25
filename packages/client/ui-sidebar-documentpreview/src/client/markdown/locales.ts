/** Markdown implementation labels and primitive chrome. */
export const zh = {
  'viewer.label': 'Markdown',
  'code.copy': '复制',
  'code.copied': '已复制',
  'footnotes': '脚注',
} satisfies Record<string, string>

/** Markdown namespace keys. */
export type MarkdownPreviewKey = keyof typeof zh

/** English labels, paired with the Chinese key set. */
export const en = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
} satisfies Record<MarkdownPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Markdown document renderer and its code/footnote controls. */
    documentMarkdown: MarkdownPreviewKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'viewer.label': 'Markdown',
  'code.copy': 'コピー',
  'code.copied': 'コピーしました',
  'footnotes': '脚注',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas a pie de página',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copier',
  'code.copied': 'Copié',
  'footnotes': 'Notes de bas de page',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'viewer.label': 'Markdown',
  'code.copy': 'Kopieren',
  'code.copied': 'Kopiert',
  'footnotes': 'Fußnoten',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'viewer.label': 'Markdown',
  'code.copy': 'Копировать',
  'code.copied': 'Скопировано',
  'footnotes': 'Сноски',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'viewer.label': 'Markdown',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas de rodapé',
} satisfies Record<keyof typeof en, string>
