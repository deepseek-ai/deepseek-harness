/** `compaction` namespace dictionaries: the checkpoint tab title, its read failures, and the placeholders for non-text blocks. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'preview.title': '压缩后的上下文',
  'preview.notFound': '在这个会话中未找到这次压缩的检查点',
  'preview.invalidAddress': '压缩检查点地址无效',
  'preview.readFailed': '无法读取压缩后的上下文',
  'block.image': '图片',
  'block.file': '文件',
  'block.other': '无法显示的内容',
} satisfies Record<string, string>

/** Compaction preview dictionary key union. */
export type CompactionKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'preview.title': 'Compacted context',
  'preview.notFound': 'This compaction checkpoint was not found in the session',
  'preview.invalidAddress': 'Invalid compaction checkpoint address',
  'preview.readFailed': 'Could not load the compacted context',
  'block.image': 'Image',
  'block.file': 'File',
  'block.other': 'Unsupported content',
} satisfies Record<CompactionKey, string>

/** Japanese dictionary. */
export const ja = {
  'preview.title': '圧縮後のコンテキスト',
  'preview.notFound': 'このセッションに圧縮チェックポイントが見つかりませんでした',
  'preview.invalidAddress': '圧縮チェックポイントのアドレスが無効です',
  'preview.readFailed': '圧縮後のコンテキストを読み込めませんでした',
  'block.image': '画像',
  'block.file': 'ファイル',
  'block.other': '表示できないコンテンツ',
} satisfies Record<CompactionKey, string>

/** Spanish dictionary. */
export const es = {
  'preview.title': 'Contexto compactado',
  'preview.notFound': 'No se encontró este punto de control de compactación en la sesión',
  'preview.invalidAddress': 'Dirección del punto de control de compactación no válida',
  'preview.readFailed': 'No se pudo cargar el contexto compactado',
  'block.image': 'Imagen',
  'block.file': 'Archivo',
  'block.other': 'Contenido no compatible',
} satisfies Record<CompactionKey, string>

/** French dictionary. */
export const fr = {
  'preview.title': 'Contexte compacté',
  'preview.notFound': 'Ce point de contrôle de compactage est introuvable dans la session',
  'preview.invalidAddress': 'Adresse du point de contrôle de compactage invalide',
  'preview.readFailed': 'Impossible de charger le contexte compacté',
  'block.image': 'Image',
  'block.file': 'Fichier',
  'block.other': 'Contenu non pris en charge',
} satisfies Record<CompactionKey, string>

/** German dictionary. */
export const de = {
  'preview.title': 'Komprimierter Kontext',
  'preview.notFound': 'Dieser Komprimierungsprüfpunkt wurde in der Sitzung nicht gefunden',
  'preview.invalidAddress': 'Ungültige Adresse des Komprimierungsprüfpunkts',
  'preview.readFailed': 'Der komprimierte Kontext konnte nicht geladen werden',
  'block.image': 'Bild',
  'block.file': 'Datei',
  'block.other': 'Nicht unterstützter Inhalt',
} satisfies Record<CompactionKey, string>

/** Russian dictionary. */
export const ru = {
  'preview.title': 'Сжатый контекст',
  'preview.notFound': 'Эта контрольная точка сжатия не найдена в сеансе',
  'preview.invalidAddress': 'Неверный адрес контрольной точки сжатия',
  'preview.readFailed': 'Не удалось загрузить сжатый контекст',
  'block.image': 'Изображение',
  'block.file': 'Файл',
  'block.other': 'Неподдерживаемое содержимое',
} satisfies Record<CompactionKey, string>

/** Portuguese dictionary. */
export const pt = {
  'preview.title': 'Contexto compactado',
  'preview.notFound': 'Este ponto de verificação de compactação não foi encontrado na sessão',
  'preview.invalidAddress': 'Endereço do ponto de verificação de compactação inválido',
  'preview.readFailed': 'Não foi possível carregar o contexto compactado',
  'block.image': 'Imagem',
  'block.file': 'Arquivo',
  'block.other': 'Conteúdo não suportado',
} satisfies Record<CompactionKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The compaction checkpoint tab title, read failures, and non-text block placeholders. */
    compaction: CompactionKey
  }
}
