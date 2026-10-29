import { zoomEn, zoomJa, zoomEs, zoomFr, zoomDe, zoomRu, zoomPt, zoomZh } from '../zoom/locales.ts'

/** Locale-owned image renderer labels and status text. */
export const zh = {
  ...zoomZh,
  title: '图片',
  preview: '图片预览：{name}',
  loading: '文档渲染中...',
  failed: '无法显示这张图片',
  unsupported: '图片预览需要完整文件内容',
} satisfies Record<string, string>

/** Image renderer dictionary keys. */
export type ImagePreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  ...zoomEn,
  title: 'Image',
  preview: 'Image preview: {name}',
  loading: 'Rendering document...',
  failed: 'This image could not be displayed.',
  unsupported: 'Image preview requires the complete file contents.',
} satisfies Record<ImagePreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image preview selection, accessible name, and status text. */
    sidebarImage: ImagePreviewKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  ...zoomJa,
  'title': '画像',
  'preview': '画像プレビュー: {name}',
  'loading': 'ドキュメントをレンダリング中...',
  'failed': 'この画像を表示できませんでした。',
  'unsupported': '画像プレビューには完全なファイル内容が必要です。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  ...zoomEs,
  title: 'Imagen',
  preview: 'Vista previa de la imagen: {name}',
  loading: 'Representando documento...',
  failed: 'Esta imagen no se pudo mostrar.',
  unsupported: 'La vista previa de la imagen requiere el contenido completo del archivo.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  ...zoomFr,
  title: 'Images',
  preview: "Aperçu de l'image : {name}",
  loading: 'Rendu du document...',
  failed: "Cette image n'a pas pu être affichée.",
  unsupported: "L'aperçu de l'image nécessite le contenu complet du fichier.",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  ...zoomDe,
  title: 'Bild',
  preview: 'Bildvorschau: {name}',
  loading: 'Dokument wird gerendert...',
  failed: 'Dieses Bild konnte nicht angezeigt werden.',
  unsupported: 'Für die Bildvorschau ist der vollständige Dateiinhalt erforderlich.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  ...zoomRu,
  title: 'Изображение',
  preview: 'Предварительный просмотр изображения: {name}',
  loading: 'Оформление документа...',
  failed: 'Это изображение не может быть отображено.',
  unsupported: 'Для предварительного просмотра изображения требуется полное содержимое файла.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  ...zoomPt,
  title: 'Imagem',
  preview: 'Visualização da imagem: {name}',
  loading: 'Renderizando documento...',
  failed: 'Esta imagem não pôde ser exibida.',
  unsupported: 'A visualização da imagem requer o conteúdo completo do arquivo.',
} satisfies Record<keyof typeof en, string>
