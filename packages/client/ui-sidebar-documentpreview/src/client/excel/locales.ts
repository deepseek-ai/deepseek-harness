/** Locale-owned Excel preview controls and parser feedback. */
export const zh = {
  title: '表格', language: 'zh', loading: '文档渲染中...',
  invalid: '无法打开此表格。请检查文件格式、内容或密码保护。',
  tooLarge: '此表格超过预览大小限制。', timeout: '打开表格超时。请缩小文件后重试。',
  encoding: '无法识别此文本文件的编码。请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。',
  formulaWarning: '此工作簿包含公式，显示结果可能缺失或不准确。',
  unsupportedNotice: '当前预览不支持此工作簿中的{features}。请使用系统应用打开，以获得完整体验。',
  charts: '图表', images: '图片', shapes: '形状', conditionalFormatting: '条件格式', featureSeparator: '、',
  retry: '重试',
} satisfies Record<string, string>

/** Excel preview dictionary keys. */
export type ExcelPreviewKey = keyof typeof zh

/** English Excel preview copy. */
export const en = {
  title: 'Spreadsheet', language: 'en', loading: 'Rendering document...',
  invalid: 'This spreadsheet could not be opened. Check its format, contents, or password protection.',
  tooLarge: 'This workbook exceeds the preview size limit.', timeout: 'Opening this workbook timed out. Try a smaller file.',
  encoding: 'This text encoding could not be read. Save the file as UTF-8 or UTF-16 with a BOM and retry.',
  formulaWarning: 'This workbook contains formulas. Displayed results may be missing or inaccurate.',
  unsupportedNotice: 'This preview does not support {features} in this workbook. Open it in a system application for the full experience.',
  charts: 'charts', images: 'images', shapes: 'shapes', conditionalFormatting: 'conditional formatting', featureSeparator: ', ',
  retry: 'Retry',
} satisfies Record<ExcelPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Excel preview status and third-party locale selection. */
    sidebarExcel: ExcelPreviewKey
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'スプレッドシート',
  'language': 'ja-JP',
  'loading': 'ドキュメントをレンダリング中...',
  'invalid': 'このスプレッドシートを開けませんでした。形式、内容、またはパスワード保護を確認してください。',
  'tooLarge': 'このブックはプレビューのサイズ上限を超えています。',
  'timeout': 'このブックを開く際にタイムアウトしました。より小さいファイルをお試しください。',
  'encoding': 'このテキストエンコーディングを読み取れませんでした。ファイルをBOM付きのUTF-8またはUTF-16で保存して再試行してください。',
  'formulaWarning': 'このブックには数式が含まれています。表示される結果が欠落または不正確な場合があります。',
  'unsupportedNotice': 'このプレビューはこのブックの{features}をサポートしていません。完全な表示にはシステムアプリケーションで開いてください。',
  'charts': 'グラフ',
  'images': '画像',
  'shapes': '図形',
  'conditionalFormatting': '条件付き書式',
  'featureSeparator': '、',
  'retry': '再試行',
} satisfies Record<keyof typeof en, string>
