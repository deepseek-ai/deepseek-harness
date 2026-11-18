/** Original-file actions and completion feedback. */

/** zh file-action labels. */
export const zh = {
  'menu.finder': '在 Finder 显示',
  'menu.reveal': '在文件夹显示',
  'menu.saveAs': '另存为…',
  'menu.copied': '已复制',
  'menu.copyImage': '复制图片',
  'menu.download': '下载',
  'menu.saveFailed': '无法保存文件，请检查源文件和目标位置后重试',
  'menu.copyFailed': '无法复制，请检查内容是否可用后重试',
  'menu.saved': '已保存',
  'menu.downloadStarted': '已开始下载',
  'menu.downloaded': '下载完成',
  'path.revealError': '无法显示文件位置，请重试',
} satisfies Record<string, string>

/** File-action dictionary keys. */
export type FileActionKey = keyof typeof zh

/** en file-action labels. */
export const en = {
  'menu.finder': 'Show in Finder',
  'menu.reveal': 'Show in folder',
  'menu.saveAs': 'Save as…',
  'menu.copied': 'Copied',
  'menu.copyImage': 'Copy image',
  'menu.download': 'Download',
  'menu.saveFailed': 'Could not save. Check the source and destination, then retry.',
  'menu.copyFailed': 'Could not copy. Check that the content is available, then retry.',
  'menu.saved': 'Saved',
  'menu.downloadStarted': 'Download started',
  'menu.downloaded': 'Download complete',
  'path.revealError': 'Could not show the file location. Try again.',
} satisfies Record<FileActionKey, string>

/** ja file-action labels. */
export const ja = {
  'menu.finder': 'Finder に表示',
  'menu.reveal': 'フォルダーに表示',
  'menu.saveAs': '名前を付けて保存…',
  'menu.copied': 'コピーしました',
  'menu.copyImage': '画像をコピー',
  'menu.download': 'ダウンロード',
  'menu.saveFailed': '保存できません。元のファイルと保存先を確認して再試行してください。',
  'menu.copyFailed': 'コピーできません。内容を確認して再試行してください。',
  'menu.saved': '保存しました',
  'menu.downloadStarted': 'ダウンロードを開始しました',
  'menu.downloaded': 'ダウンロードしました',
  'path.revealError': 'ファイルの場所を表示できませんでした。もう一度お試しください。',
} satisfies Record<FileActionKey, string>

/** es file-action labels. */
export const es = {
  'menu.finder': 'Mostrar en Finder',
  'menu.reveal': 'Mostrar en la carpeta',
  'menu.saveAs': 'Guardar como…',
  'menu.copied': 'Copiado',
  'menu.copyImage': 'Copiar imagen',
  'menu.download': 'Descargar',
  'menu.saveFailed': 'No se pudo guardar. Compruebe el origen y el destino e inténtelo de nuevo.',
  'menu.copyFailed': 'No se pudo copiar. Compruebe que el contenido esté disponible e inténtelo de nuevo.',
  'menu.saved': 'Guardado',
  'menu.downloadStarted': 'Descarga iniciada',
  'menu.downloaded': 'Descarga completada',
  'path.revealError': 'No se pudo mostrar la ubicación del archivo. Intentar otra vez.',
} satisfies Record<FileActionKey, string>

/** fr file-action labels. */
export const fr = {
  'menu.finder': 'Afficher dans le Finder',
  'menu.reveal': 'Afficher dans le dossier',
  'menu.saveAs': 'Enregistrer sous…',
  'menu.copied': 'Copié',
  'menu.copyImage': 'Copier l’image',
  'menu.download': 'Télécharger',
  'menu.saveFailed': 'Impossible d’enregistrer. Vérifiez la source et la destination, puis réessayez.',
  'menu.copyFailed': 'Impossible de copier. Vérifiez que le contenu est disponible, puis réessayez.',
  'menu.saved': 'Enregistré',
  'menu.downloadStarted': 'Téléchargement démarré',
  'menu.downloaded': 'Téléchargement terminé',
  'path.revealError': "Impossible d'afficher l'emplacement du fichier. Essayer à nouveau.",
} satisfies Record<FileActionKey, string>

/** de file-action labels. */
export const de = {
  'menu.finder': 'Im Finder anzeigen',
  'menu.reveal': 'Im Ordner anzeigen',
  'menu.saveAs': 'Speichern unter…',
  'menu.copied': 'Kopiert',
  'menu.copyImage': 'Bild kopieren',
  'menu.download': 'Herunterladen',
  'menu.saveFailed': 'Speichern fehlgeschlagen. Prüfen Sie Quelle und Ziel und versuchen Sie es erneut.',
  'menu.copyFailed': 'Kopieren fehlgeschlagen. Prüfen Sie, ob der Inhalt verfügbar ist, und versuchen Sie es erneut.',
  'menu.saved': 'Gespeichert',
  'menu.downloadStarted': 'Download gestartet',
  'menu.downloaded': 'Download abgeschlossen',
  'path.revealError': 'Der Dateispeicherort konnte nicht angezeigt werden. Versuchen Sie es erneut.',
} satisfies Record<FileActionKey, string>

/** ru file-action labels. */
export const ru = {
  'menu.finder': 'Показать в Finder',
  'menu.reveal': 'Показать в папке',
  'menu.saveAs': 'Сохранить как…',
  'menu.copied': 'Скопировано',
  'menu.copyImage': 'Копировать изображение',
  'menu.download': 'Скачать',
  'menu.saveFailed': 'Не удалось сохранить. Проверьте источник и место сохранения и повторите попытку.',
  'menu.copyFailed': 'Не удалось скопировать. Проверьте доступность содержимого и повторите попытку.',
  'menu.saved': 'Сохранено',
  'menu.downloadStarted': 'Скачивание началось',
  'menu.downloaded': 'Скачивание завершено',
  'path.revealError': 'Не удалось показать местоположение файла. Попробуйте еще раз.',
} satisfies Record<FileActionKey, string>

/** pt file-action labels. */
export const pt = {
  'menu.finder': 'Mostrar no Finder',
  'menu.reveal': 'Mostrar na pasta',
  'menu.saveAs': 'Salvar como…',
  'menu.copied': 'Copiado',
  'menu.copyImage': 'Copiar imagem',
  'menu.download': 'Baixar',
  'menu.saveFailed': 'Não foi possível salvar. Verifique a origem e o destino e tente novamente.',
  'menu.copyFailed': 'Não foi possível copiar. Verifique se o conteúdo está disponível e tente novamente.',
  'menu.saved': 'Salvo',
  'menu.downloadStarted': 'Download iniciado',
  'menu.downloaded': 'Download concluído',
  'path.revealError': 'Não foi possível mostrar o local do arquivo. Tente novamente.',
} satisfies Record<FileActionKey, string>
