import { zoomEn, zoomJa, zoomEs, zoomFr, zoomDe, zoomRu, zoomPt, zoomZh } from '../zoom/locales.ts'

/** Copy owned by the PDF renderer. */
export const zh = {
  ...zoomZh,
  title: 'PDF',
  pageImage: 'PDF 第 {page} 页',
  loading: '文档渲染中...',
  rendering: '正在绘制页面…',
  failed: '无法显示 PDF：{message}',
  password: '此 PDF 需要密码，暂不支持预览',
  workerFailed: 'PDF 渲染进程无法继续，请重试',
  unsupported: 'PDF 预览需要完整文件内容',
  retry: '重试',
} satisfies Record<string, string>

/** PDF translation keys shared by both dictionaries. */
export type PdfLocaleKey = keyof typeof zh

/** English PDF-renderer dictionary. */
export const en = {
  ...zoomEn,
  title: 'PDF',
  pageImage: 'PDF page {page}',
  loading: 'Rendering document...',
  rendering: 'Rendering page…',
  failed: 'Cannot display PDF: {message}',
  password: 'This PDF requires a password; password-protected previews are not supported.',
  workerFailed: 'The PDF rendering process could not continue. Please retry.',
  unsupported: 'PDF preview requires the complete file contents.',
  retry: 'Retry',
} satisfies Record<PdfLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PDF page, loading, and failure messages. */
    sidebarPdf: PdfLocaleKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  ...zoomJa,
  'title': 'PDF',
  'pageImage': 'PDFページ {page}',
  'loading': 'ドキュメントをレンダリング中...',
  'rendering': 'ページをレンダリング中…',
  'failed': 'PDFを表示できません: {message}',
  'password': 'このPDFにはパスワードが必要です。パスワード保護されたプレビューはサポートされていません。',
  'workerFailed': 'PDFのレンダリング処理を続行できませんでした。再試行してください。',
  'unsupported': 'PDFのプレビューには完全なファイル内容が必要です。',
  'retry': '再試行',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  ...zoomEs,
  title: 'PDF',
  pageImage: 'Página PDF {page}',
  loading: 'Representando documento...',
  rendering: 'Página de renderizado...',
  failed: 'No se puede mostrar PDF: {message}',
  password: 'Este PDF requiere una contraseña; No se admiten vistas previas protegidas con contraseña.',
  workerFailed: 'El proceso de renderizado de PDF no pudo continuar. Vuelva a intentarlo.',
  unsupported: 'La vista previa de PDF requiere el contenido completo del archivo.',
  retry: 'Reintentar',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  ...zoomFr,
  title: 'PDF',
  pageImage: 'Page PDF {page}',
  loading: 'Rendu du document...',
  rendering: 'Page de rendu…',
  failed: "Impossible d'afficher le PDF : {message}",
  password: 'Ce PDF nécessite un mot de passe ; les aperçus protégés par mot de passe ne sont pas pris en charge.',
  workerFailed: "Le processus de rendu PDF n'a pas pu continuer. Veuillez réessayer.",
  unsupported: "L'aperçu PDF nécessite le contenu complet du fichier.",
  retry: 'Réessayer',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  ...zoomDe,
  title: 'PDF',
  pageImage: 'PDF-Seite {page}',
  loading: 'Dokument wird gerendert...',
  rendering: 'Rendering-Seite…',
  failed: 'PDF kann nicht angezeigt werden: {message}',
  password: 'Für dieses PDF ist ein Passwort erforderlich. Passwortgeschützte Vorschauen werden nicht unterstützt.',
  workerFailed: 'Der PDF-Rendering-Prozess konnte nicht fortgesetzt werden. Bitte versuchen Sie es erneut.',
  unsupported: 'Für die PDF-Vorschau ist der vollständige Dateiinhalt erforderlich.',
  retry: 'Erneut versuchen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  ...zoomRu,
  title: 'PDF',
  pageImage: 'PDF-страница {page}',
  loading: 'Оформление документа...',
  rendering: 'Отображение страницы…',
  failed: 'Невозможно отобразить PDF: {message}',
  password: 'Для этого PDF-файла требуется пароль; предварительный просмотр, защищенный паролем, не поддерживается.',
  workerFailed: 'Процесс рендеринга PDF не может быть продолжен. Пожалуйста, повторите попытку.',
  unsupported: 'Для предварительного просмотра PDF требуется полное содержимое файла.',
  retry: 'Повторить',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  ...zoomPt,
  title: 'PDF',
  pageImage: 'Página PDF {page}',
  loading: 'Renderizando documento...',
  rendering: 'Página de renderização…',
  failed: 'Não é possível exibir PDF: {message}',
  password: 'Este PDF requer uma senha; visualizações protegidas por senha não são suportadas.',
  workerFailed: 'O processo de renderização do PDF não pôde continuar. Por favor, tente novamente.',
  unsupported: 'A visualização do PDF requer o conteúdo completo do arquivo.',
  retry: 'Tentar novamente',
} satisfies Record<keyof typeof en, string>
