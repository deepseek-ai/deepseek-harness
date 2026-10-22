import { zoomEn, zoomJa, zoomZh } from '../zoom/locales.ts'

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
