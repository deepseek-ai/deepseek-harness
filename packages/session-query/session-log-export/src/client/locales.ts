/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'header.more': '更多操作',
  'menu.copyMarkdown': '复制会话为 Markdown',
  'menu.download': '下载 Session 日志',
  'menu.feedback': '反馈',
  'toast.copied': 'Session 已复制为 Markdown',
  'toast.preparationFailed': '无法读取 Session 进行复制，请重试',
  'toast.clipboardFailed': '无法写入剪贴板，请检查剪贴板权限后重试',
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
  'dialog.successTitle': 'Session 导出已开始下载',
  'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'header.more': 'More actions',
  'menu.copyMarkdown': 'Copy Session as Markdown',
  'menu.download': 'Download session log',
  'menu.feedback': 'Feedback',
  'toast.copied': 'Session copied as Markdown.',
  'toast.preparationFailed': 'Could not read the Session for copying. Try again.',
  'toast.clipboardFailed': 'Could not write to the clipboard. Check clipboard permission and try again.',
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Session download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh

/** Japanese copy, checked against the English keys. */
export const ja = {
  'header.more': 'その他の操作',
  'menu.copyMarkdown': 'セッションを Markdown としてコピー',
  'menu.download': 'セッションログをダウンロード',
  'menu.feedback': 'フィードバック',
  'toast.copied': 'セッションを Markdown としてコピーしました',
  'toast.preparationFailed': 'コピーするセッションを読み取れませんでした。再試行してください。',
  'toast.clipboardFailed': 'クリップボードに書き込めませんでした。クリップボードの権限を確認して再試行してください。',
  'dialog.preparingTitle': 'セッションをエクスポート中',
  'dialog.preparingDescription': 'このセッション、そのサブセッション、添付ファイルを含むZIPを準備しています。',
  'dialog.successTitle': 'セッションのダウンロードを開始しました',
  'dialog.successDescription': 'ブラウザがセッションZIPをダウンロードしています。',
  'dialog.errorTitle': 'セッションのエクスポートに失敗しました',
  'dialog.close': '閉じる',
  'dialog.commandFailed': 'セッションのエクスポートを開始できませんでした。',
} satisfies Record<keyof typeof en, string>
