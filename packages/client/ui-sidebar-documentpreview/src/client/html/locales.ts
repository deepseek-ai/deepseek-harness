/** Locale-owned HTML implementation name and iframe status text. */
export const zh = {
  title: 'HTML',
  frame: 'HTML 文档预览',
  loading: '文档渲染中...',
  failed: '无法预览这份 HTML 文档',
} satisfies Record<string, string>

/** HTML renderer dictionary keys. */
export type HtmlPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'HTML',
  frame: 'HTML document preview',
  loading: 'Rendering document...',
  failed: 'This HTML document could not be previewed.',
} satisfies Record<HtmlPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HTML preview selection and status text. */
    documentHtml: HtmlPreviewKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'HTML',
  'frame': 'HTMLドキュメントのプレビュー',
  'loading': 'ドキュメントをレンダリング中...',
  'failed': 'このHTMLドキュメントをプレビューできませんでした。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'HTML',
  frame: 'Vista previa del documento HTML',
  loading: 'Representando documento...',
  failed: 'No se pudo obtener una vista previa de este documento HTML.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'HTML',
  frame: 'Aperçu du document HTML',
  loading: 'Rendu du document...',
  failed: "Ce document HTML n'a pas pu être prévisualisé.",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'HTML',
  frame: 'Vorschau des HTML-Dokuments',
  loading: 'Dokument wird gerendert...',
  failed: 'Dieses HTML-Dokument konnte nicht in der Vorschau angezeigt werden.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'HTML',
  frame: 'Предварительный просмотр HTML-документа',
  loading: 'Оформление документа...',
  failed: 'Этот HTML-документ не удалось просмотреть.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'HTML',
  frame: 'Pré-visualização do documento HTML',
  loading: 'Renderizando documento...',
  failed: 'Este documento HTML não pôde ser visualizado.',
} satisfies Record<keyof typeof en, string>
