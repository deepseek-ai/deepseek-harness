/** Office preview copy and Host render configuration guidance. */
export const zh = {
  title: 'Office 文档',
  loading: '文档渲染中...',
  retry: '重试',
  viewMissingFonts: '缺失 {count} 种字体，点击查看',
  missingFontsTitle: '缺失的字体',
  missingFontsDescription: '本次预览无法使用以下字体，预览中的文字和排版可能与原文档不同。',
  missingFontsCount: '{count} 种字体',
  closeDetails: '关闭字体详情',
  unavailable: 'Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。',
  invalid: '无法预览此 Office 文件。文件可能已损坏、受密码保护，或与扩展名不符。',
  tooLarge: 'Office 文件或转换后的 PDF 超过预览大小上限，请缩小文件或调整预览配置。',
  failed: 'Office 转换失败，未生成可用的 PDF。请检查该文件后重试。',
  timeout: 'Office 转换超时，请重试。',
  busy: 'Office 预览任务较多，请稍后重试。',
  changed: '文件在读取时已更改，请重新打开预览。',
} satisfies Record<string, string>

/** Office preview locale keys. */
export type OfficePreviewKey = keyof typeof zh

/** English translations checked against the Chinese key set. */
export const en = {
  title: 'Office document',
  loading: 'Rendering document...',
  retry: 'Retry',
  viewMissingFonts: 'Missing fonts: {count}. Click to view.',
  missingFontsTitle: 'Missing fonts',
  missingFontsDescription: 'These fonts are unavailable for this preview. Text and layout may differ from the original document.',
  missingFontsCount: 'Fonts: {count}',
  closeDetails: 'Close font details',
  unavailable: 'Office previews are unavailable. Enable the document preview service on the computer running DeepSeek Harness.',
  invalid: 'This Office file cannot be previewed. It may be damaged, password protected, or have the wrong extension.',
  tooLarge: 'The Office file or converted PDF exceeds the preview size limit. Reduce the file size or adjust the preview configuration.',
  failed: 'Office conversion did not produce a usable PDF. Check the file and try again.',
  timeout: 'Office conversion timed out. Try again.',
  busy: 'Office preview is busy. Try again shortly.',
  changed: 'The file changed while being read. Reopen the preview.',
} satisfies Record<OfficePreviewKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'Office ドキュメント',
  'loading': 'ドキュメントをレンダリング中…',
  'retry': '再試行',
  'viewMissingFonts': '不足しているフォント: {count}。クリックして表示。',
  'missingFontsTitle': '不足しているフォント',
  'missingFontsDescription': 'これらのフォントはこのプレビューでは利用できません。テキストとレイアウトが元のドキュメントと異なる場合があります。',
  'missingFontsCount': 'フォント: {count}',
  'closeDetails': 'フォントの詳細を閉じる',
  'unavailable': 'Office プレビューを利用できません。DeepSeek Harness を実行しているコンピューターでドキュメントプレビューサービスを有効にしてください。',
  'invalid': 'この Office ファイルはプレビューできません。破損しているか、パスワード保護されているか、拡張子が誤っている可能性があります。',
  'tooLarge': 'Office ファイルまたは変換後の PDF がプレビューのサイズ上限を超えています。ファイルサイズを減らすか、プレビュー設定を調整してください。',
  'failed': 'Office の変換で使用可能な PDF が生成されませんでした。ファイルを確認して再試行してください。',
  'timeout': 'Office の変換がタイムアウトしました。再試行してください。',
  'busy': 'Office プレビューは混雑しています。しばらくしてから再試行してください。',
  'changed': '読み込み中にファイルが変更されました。プレビューを開き直してください。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'documento de oficina',
  loading: 'Representando documento...',
  retry: 'Reintentar',
  viewMissingFonts: 'Fuentes faltantes: {count}. Haga clic para ver.',
  missingFontsTitle: 'Fuentes faltantes',
  missingFontsDescription: 'Estas fuentes no están disponibles para esta vista previa. El texto y el diseño pueden diferir del documento original.',
  missingFontsCount: 'Fuentes: {count}',
  closeDetails: 'Cerrar detalles de fuente',
  unavailable: 'Las vistas previas de Office no están disponibles. Habilite el servicio de vista previa de documentos en la computadora que ejecuta DeepSeek Harness.',
  invalid: 'No se puede obtener una vista previa de este archivo de Office. Puede que esté dañado, protegido con contraseña o que tenga la extensión incorrecta.',
  tooLarge: 'El archivo de Office o el PDF convertido supera el límite de tamaño de vista previa. Reduzca el tamaño del archivo o ajuste la configuración de vista previa.',
  failed: 'La conversión de Office no produjo un PDF utilizable. Verifique el archivo e inténtelo nuevamente.',
  timeout: 'Se agotó el tiempo de espera para la conversión de Office. Intentar otra vez.',
  busy: 'La vista previa de Office está ocupada. Vuelve a intentarlo en breve.',
  changed: 'El archivo cambió mientras se leía. Vuelva a abrir la vista previa.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'Document de bureau',
  loading: 'Rendu du document...',
  retry: 'Réessayer',
  viewMissingFonts: 'Polices manquantes : {count}. Cliquez pour voir.',
  missingFontsTitle: 'Polices manquantes',
  missingFontsDescription: 'Ces polices ne sont pas disponibles pour cet aperçu. Le texte et la mise en page peuvent différer du document original.',
  missingFontsCount: 'Polices : {count}',
  closeDetails: 'Fermer les détails de la police',
  unavailable: "Les aperçus Office ne sont pas disponibles. Activez le service de prévisualisation des documents sur l'ordinateur exécutant DeepSeek Harness.",
  invalid: 'Ce fichier Office ne peut pas être prévisualisé. Il peut être endommagé, protégé par mot de passe ou avoir une extension incorrecte.',
  tooLarge: "Le fichier Office ou le PDF converti dépasse la limite de taille d'aperçu. Réduisez la taille du fichier ou ajustez la configuration de l’aperçu.",
  failed: "La conversion Office n'a pas produit de PDF utilisable. Vérifiez le fichier et réessayez.",
  timeout: 'La conversion du bureau a expiré. Essayer à nouveau.',
  busy: 'L’aperçu Office est occupé. Réessayez sous peu.',
  changed: "Le fichier a changé lors de sa lecture. Rouvrez l'aperçu.",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'Office-Dokument',
  loading: 'Dokument wird gerendert...',
  retry: 'Erneut versuchen',
  viewMissingFonts: 'Fehlende Schriftarten: {count}. Klicken Sie zum Anzeigen.',
  missingFontsTitle: 'Fehlende Schriftarten',
  missingFontsDescription: 'Diese Schriftarten sind für diese Vorschau nicht verfügbar. Text und Layout können vom Originaldokument abweichen.',
  missingFontsCount: 'Schriftarten: {count}',
  closeDetails: 'Schriftartdetails schließen',
  unavailable: 'Office-Vorschauen sind nicht verfügbar. Aktivieren Sie den Dokumentvorschaudienst auf dem Computer, auf dem DeepSeek Harness ausgeführt wird.',
  invalid: 'Diese Office-Datei kann nicht in der Vorschau angezeigt werden. Möglicherweise ist es beschädigt, passwortgeschützt oder hat die falsche Erweiterung.',
  tooLarge: 'Die Office-Datei oder das konvertierte PDF überschreitet die Größenbeschränkung für die Vorschau. Reduzieren Sie die Dateigröße oder passen Sie die Vorschaukonfiguration an.',
  failed: 'Die Office-Konvertierung ergab kein brauchbares PDF. Überprüfen Sie die Datei und versuchen Sie es erneut.',
  timeout: 'Zeitüberschreitung bei der Office-Konvertierung. Versuchen Sie es erneut.',
  busy: 'Die Office-Vorschau ist beschäftigt. Versuchen Sie es in Kürze noch einmal.',
  changed: 'Die Datei wurde beim Lesen geändert. Öffnen Sie die Vorschau erneut.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'Офисный документ',
  loading: 'Оформление документа...',
  retry: 'Повторить',
  viewMissingFonts: 'Отсутствуют шрифты: {count}. Нажмите, чтобы просмотреть.',
  missingFontsTitle: 'Отсутствуют шрифты',
  missingFontsDescription: 'Эти шрифты недоступны для этой предварительной версии. Текст и оформление могут отличаться от исходного документа.',
  missingFontsCount: 'Шрифты: {count}',
  closeDetails: 'Закрыть сведения о шрифте',
  unavailable: 'Предварительные версии Office недоступны. Включите службу предварительного просмотра документов на компьютере под управлением DeepSeek Harness.',
  invalid: 'Этот файл Office нельзя просмотреть. Возможно, он поврежден, защищен паролем или имеет неправильное расширение.',
  tooLarge: 'Размер файла Office или преобразованного PDF-файла превышает ограничение на размер предварительного просмотра. Уменьшите размер файла или настройте конфигурацию предварительного просмотра.',
  failed: 'Преобразование Office не привело к созданию пригодного для использования PDF-файла. Проверьте файл и повторите попытку.',
  timeout: 'Время преобразования Office истекло. Попробуйте еще раз.',
  busy: 'Предварительная версия Office занята. Повторите попытку через некоторое время.',
  changed: 'Файл изменился во время чтения. Снова откройте предварительный просмотр.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'Documento de escritório',
  loading: 'Renderizando documento...',
  retry: 'Tentar novamente',
  viewMissingFonts: 'Fontes ausentes: {count}. Clique para visualizar.',
  missingFontsTitle: 'Fontes ausentes',
  missingFontsDescription: 'Essas fontes não estão disponíveis para esta visualização. O texto e o layout podem diferir do documento original.',
  missingFontsCount: 'Fontes: {count}',
  closeDetails: 'Fechar detalhes da fonte',
  unavailable: 'As visualizações do Office não estão disponíveis. Ative o serviço de visualização de documentos no computador que executa DeepSeek Harness.',
  invalid: 'Este arquivo do Office não pode ser visualizado. Ele pode estar danificado, protegido por senha ou ter a extensão errada.',
  tooLarge: 'O arquivo Office ou PDF convertido excede o limite de tamanho de visualização. Reduza o tamanho do arquivo ou ajuste a configuração de visualização.',
  failed: 'A conversão do Office não produziu um PDF utilizável. Verifique o arquivo e tente novamente.',
  timeout: 'A conversão do Office expirou. Tente novamente.',
  busy: 'A visualização do Office está ocupada. Tente novamente em breve.',
  changed: 'O arquivo foi alterado durante a leitura. Reabra a visualização.',
} satisfies Record<keyof typeof en, string>
