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

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'Hoja de cálculo', language: 'en', loading: 'Representando documento...',
  invalid: 'Esta hoja de cálculo no se pudo abrir. Comprueba su formato, contenidos o protección con contraseña.',
  tooLarge: 'Este libro excede el límite de tamaño de vista previa.', timeout: 'Se agotó el tiempo de apertura de este libro. Pruebe con un archivo más pequeño.',
  encoding: 'Esta codificación de texto no se pudo leer. Guarde el archivo como UTF-8 o UTF-16 con una lista de materiales y vuelva a intentarlo.',
  formulaWarning: 'Este libro contiene fórmulas. Los resultados mostrados pueden faltar o ser inexactos.',
  unsupportedNotice: 'Esta vista previa no es compatible con {features} en este libro. Ábralo en una aplicación del sistema para disfrutar de la experiencia completa.',
  charts: 'gráficos', images: 'imágenes', shapes: 'formas', conditionalFormatting: 'formato condicional', featureSeparator: ', ',
  retry: 'Reintentar',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'Feuille de calcul', language: 'en', loading: 'Rendu du document...',
  invalid: "Cette feuille de calcul n'a pas pu être ouverte. Vérifiez son format, son contenu ou sa protection par mot de passe.",
  tooLarge: "Ce classeur dépasse la limite de taille d'aperçu.", timeout: "L'ouverture de ce classeur a expiré. Essayez un fichier plus petit.",
  encoding: "Cet encodage de texte n'a pas pu être lu. Enregistrez le fichier au format UTF-8 ou UTF-16 avec une nomenclature et réessayez.",
  formulaWarning: 'Ce classeur contient des formules. Les résultats affichés peuvent être manquants ou inexacts.',
  unsupportedNotice: 'Cet aperçu ne prend pas en charge {features} dans ce classeur. Ouvrez-le dans une application système pour une expérience complète.',
  charts: 'graphiques', images: 'photos', shapes: 'formes', conditionalFormatting: 'mise en forme conditionnelle', featureSeparator: ', ',
  retry: 'Réessayer',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'Tabellenkalkulation', language: 'en', loading: 'Dokument wird gerendert...',
  invalid: 'Diese Tabelle konnte nicht geöffnet werden. Überprüfen Sie Format, Inhalt oder Passwortschutz.',
  tooLarge: 'Diese Arbeitsmappe überschreitet die Größenbeschränkung für die Vorschau.', timeout: 'Beim Öffnen dieser Arbeitsmappe ist eine Zeitüberschreitung aufgetreten. Versuchen Sie es mit einer kleineren Datei.',
  encoding: 'Diese Textkodierung konnte nicht gelesen werden. Speichern Sie die Datei als UTF-8 oder UTF-16 mit einer Stückliste und versuchen Sie es erneut.',
  formulaWarning: 'Diese Arbeitsmappe enthält Formeln. Die angezeigten Ergebnisse fehlen möglicherweise oder sind ungenau.',
  unsupportedNotice: 'Diese Vorschau unterstützt {features} in dieser Arbeitsmappe nicht. Öffnen Sie es in einer Systemanwendung, um das volle Erlebnis zu genießen.',
  charts: 'Diagramme', images: 'Bilder', shapes: 'Formen', conditionalFormatting: 'bedingte Formatierung', featureSeparator: ', ',
  retry: 'Erneut versuchen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'электронная таблица', language: 'en', loading: 'Оформление документа...',
  invalid: 'Эту таблицу невозможно открыть. Проверьте его формат, содержимое или защиту паролем.',
  tooLarge: 'Размер этой книги превышает ограничение на размер предварительного просмотра.', timeout: 'Время открытия этой книги истекло. Попробуйте файл меньшего размера.',
  encoding: 'Эту текстовую кодировку невозможно прочитать. Сохраните файл как UTF-8 или UTF-16 со спецификацией и повторите попытку.',
  formulaWarning: 'В этой рабочей тетради есть формулы. Отображаемые результаты могут отсутствовать или быть неточными.',
  unsupportedNotice: 'Эта предварительная версия не поддерживает {features} в этой книге. Откройте его в системном приложении, чтобы получить полную информацию.',
  charts: 'графики', images: 'изображения', shapes: 'формы', conditionalFormatting: 'условное форматирование', featureSeparator: ', ',
  retry: 'Повторить',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'Planilha', language: 'en', loading: 'Renderizando documento...',
  invalid: 'Não foi possível abrir esta planilha. Verifique seu formato, conteúdo ou proteção por senha.',
  tooLarge: 'Esta pasta de trabalho excede o limite de tamanho de visualização.', timeout: 'A abertura desta pasta de trabalho expirou. Experimente um arquivo menor.',
  encoding: 'Esta codificação de texto não pôde ser lida. Salve o arquivo como UTF-8 ou UTF-16 com uma BOM e tente novamente.',
  formulaWarning: 'Esta pasta de trabalho contém fórmulas. Os resultados exibidos podem estar ausentes ou imprecisos.',
  unsupportedNotice: 'Esta visualização não oferece suporte a {features} nesta pasta de trabalho. Abra-o em um aplicativo do sistema para ter uma experiência completa.',
  charts: 'gráficos', images: 'imagens', shapes: 'formas', conditionalFormatting: 'formatação condicional', featureSeparator: ', ',
  retry: 'Tentar novamente',
} satisfies Record<keyof typeof en, string>
