/** Markdown implementation labels and primitive chrome. */
export const zh = {
  'viewer.label': 'Markdown',
  'summary.title': '上下文摘要',
  'summary.expired': '此预览已失效，重新加载页面后不再保留之前窗口打开的内容',
  'code.copy': '复制',
  'code.copied': '已复制',
  'footnotes': '脚注',
} satisfies Record<string, string>

/** Markdown namespace keys. */
export type MarkdownPreviewKey = keyof typeof zh

/** English labels, paired with the Chinese key set. */
export const en = {
  'viewer.label': 'Markdown',
  'summary.title': 'Context summary',
  'summary.expired': 'This preview is no longer available. Content from a previous window is not kept after reload.',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
} satisfies Record<MarkdownPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap {
    /** Markdown document renderer and its code/footnote controls. */
    documentMarkdown: MarkdownPreviewKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'viewer.label': 'Markdown',
  'summary.title': 'コンテキストの要約',
  'summary.expired': 'このプレビューは利用できなくなりました。以前のウィンドウで開いた内容は再読み込み後に保持されません。',
  'code.copy': 'コピー',
  'code.copied': 'コピーしました',
  'footnotes': '脚注',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'viewer.label': 'Markdown',
  'summary.title': 'Resumen del contexto',
  'summary.expired': 'Esta vista previa ya no está disponible. El contenido de una ventana anterior no se conserva al recargar.',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas a pie de página',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'viewer.label': 'Markdown',
  'summary.title': 'Résumé du contexte',
  'summary.expired': 'Cet aperçu n’est plus disponible. Le contenu d’une fenêtre précédente n’est pas conservé après un rechargement.',
  'code.copy': 'Copier',
  'code.copied': 'Copié',
  'footnotes': 'Notes de bas de page',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'viewer.label': 'Markdown',
  'summary.title': 'Kontextzusammenfassung',
  'summary.expired': 'Diese Vorschau ist nicht mehr verfügbar. Inhalte aus einem früheren Fenster bleiben nach dem Neuladen nicht erhalten.',
  'code.copy': 'Kopieren',
  'code.copied': 'Kopiert',
  'footnotes': 'Fußnoten',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'viewer.label': 'Markdown',
  'summary.title': 'Сводка контекста',
  'summary.expired': 'Этот просмотр больше недоступен. Содержимое из предыдущего окна не сохраняется после перезагрузки.',
  'code.copy': 'Копировать',
  'code.copied': 'Скопировано',
  'footnotes': 'Сноски',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'viewer.label': 'Markdown',
  'summary.title': 'Resumo do contexto',
  'summary.expired': 'Esta visualização não está mais disponível. O conteúdo de uma janela anterior não é mantido após recarregar.',
  'code.copy': 'Copiar',
  'code.copied': 'Copiado',
  'footnotes': 'Notas de rodapé',
} satisfies Record<keyof typeof en, string>
