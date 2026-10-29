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

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'header.more': 'Más acciones',
  'menu.copyMarkdown': 'Copiar sesión como Markdown',
  'menu.download': 'Descargar registro de sesión',
  'menu.feedback': 'Comentarios',
  'toast.copied': 'Sesión copiada como Markdown.',
  'toast.preparationFailed': 'No se pudo leer la sesión para copiarla. Intentar otra vez.',
  'toast.clipboardFailed': 'No se pudo escribir en el portapapeles. Verifique los permisos del portapapeles e inténtelo nuevamente.',
  'dialog.preparingTitle': 'Sesión de exportación',
  'dialog.preparingDescription': 'Preparar un ZIP que contenga esta Sesión, sus subsesiones y archivos adjuntos.',
  'dialog.successTitle': 'Descarga de sesión iniciada',
  'dialog.successDescription': 'El navegador está descargando el ZIP de la sesión.',
  'dialog.errorTitle': 'Error al exportar la sesión',
  'dialog.close': 'Cerrar',
  'dialog.commandFailed': 'No se pudo iniciar la exportación de la sesión.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'header.more': 'Autres actions',
  'menu.copyMarkdown': 'Copier la session sous Markdown',
  'menu.download': 'Télécharger le journal de session',
  'menu.feedback': 'Commentaires',
  'toast.copied': 'Session copiée sous le nom Markdown.',
  'toast.preparationFailed': 'Impossible de lire la session pour la copier. Essayer à nouveau.',
  'toast.clipboardFailed': "Impossible d'écrire dans le presse-papiers. Vérifiez l'autorisation du presse-papiers et réessayez.",
  'dialog.preparingTitle': "Session d'exportation",
  'dialog.preparingDescription': "Préparation d'un ZIP contenant cette session, ses sous-sessions et les pièces jointes.",
  'dialog.successTitle': 'Le téléchargement de la session a commencé',
  'dialog.successDescription': 'Le navigateur télécharge le ZIP de la session.',
  'dialog.errorTitle': "Échec de l'exportation de la session",
  'dialog.close': 'Fermer',
  'dialog.commandFailed': "Impossible de démarrer l'exportation de session.",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'header.more': 'Weitere Aktionen',
  'menu.copyMarkdown': 'Kopieren Sie die Sitzung als Markdown',
  'menu.download': 'Sitzungsprotokoll herunterladen',
  'menu.feedback': 'Rückmeldung',
  'toast.copied': 'Sitzung als Markdown kopiert.',
  'toast.preparationFailed': 'Die Sitzung zum Kopieren konnte nicht gelesen werden. Versuchen Sie es erneut.',
  'toast.clipboardFailed': 'Es konnte nicht in die Zwischenablage geschrieben werden. Überprüfen Sie die Berechtigung für die Zwischenablage und versuchen Sie es erneut.',
  'dialog.preparingTitle': 'Sitzung exportieren',
  'dialog.preparingDescription': 'Vorbereiten einer ZIP-Datei mit dieser Sitzung, ihren Untersitzungen und Anhängen.',
  'dialog.successTitle': 'Sitzungsdownload gestartet',
  'dialog.successDescription': 'Der Browser lädt die Sitzungs-ZIP herunter.',
  'dialog.errorTitle': 'Der Sitzungsexport ist fehlgeschlagen',
  'dialog.close': 'Schließen',
  'dialog.commandFailed': 'Der Sitzungsexport konnte nicht gestartet werden.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'header.more': 'Другие действия',
  'menu.copyMarkdown': 'Скопировать сеанс как Markdown',
  'menu.download': 'Скачать журнал сеанса',
  'menu.feedback': 'Обратная связь',
  'toast.copied': 'Сессия скопирована как Markdown.',
  'toast.preparationFailed': 'Не удалось прочитать сеанс для копирования. Попробуйте еще раз.',
  'toast.clipboardFailed': 'Не удалось записать в буфер обмена. Проверьте разрешение буфера обмена и повторите попытку.',
  'dialog.preparingTitle': 'Экспорт сеанса',
  'dialog.preparingDescription': 'Подготовка ZIP-файла, содержащего этот сеанс, его подсеансы и вложения.',
  'dialog.successTitle': 'Загрузка сеанса началась',
  'dialog.successDescription': 'Браузер загружает ZIP-файл сеанса.',
  'dialog.errorTitle': 'Экспорт сеанса не удался',
  'dialog.close': 'Закрыть',
  'dialog.commandFailed': 'Не удалось начать экспорт сеанса.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'header.more': 'Mais ações',
  'menu.copyMarkdown': 'Copiar sessão como Markdown',
  'menu.download': 'Baixar registro da sessão',
  'menu.feedback': 'Comentários',
  'toast.copied': 'Sessão copiada como Markdown.',
  'toast.preparationFailed': 'Não foi possível ler a sessão para cópia. Tente novamente.',
  'toast.clipboardFailed': 'Não foi possível gravar na área de transferência. Verifique a permissão da área de transferência e tente novamente.',
  'dialog.preparingTitle': 'Exportando Sessão',
  'dialog.preparingDescription': 'Preparando um ZIP contendo esta Sessão, suas subsessões e anexos.',
  'dialog.successTitle': 'Download da sessão iniciado',
  'dialog.successDescription': 'O navegador está baixando o ZIP da sessão.',
  'dialog.errorTitle': 'Falha na exportação da sessão',
  'dialog.close': 'Fechar',
  'dialog.commandFailed': 'Não foi possível iniciar a exportação da sessão.',
} satisfies Record<keyof typeof en, string>
