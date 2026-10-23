/** Localized labels for the NodeJS inspector bottom panel and command. */
export const zh = {
  title: 'NodeJS 诊断',
  toggle: '展开或收起 NodeJS 诊断',
  close: '收起',
  resize: '调整 NodeJS 诊断面板高度',
  frameTitle: 'NodeJS 诊断',
}

/** English labels checked against the bottom-panel dictionary. */
export const en: Record<keyof typeof zh, string> = {
  title: 'NodeJS inspector',
  toggle: 'Toggle NodeJS inspector',
  close: 'Collapse',
  resize: 'Resize NodeJS inspector panel',
  frameTitle: 'NodeJS inspector',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shared Inspector frontend copy. */
    inspectorPanel: keyof typeof zh
  }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'NodeJS インスペクター',
  'toggle': 'NodeJS インスペクターの表示切り替え',
  'close': '折りたたむ',
  'resize': 'NodeJS インスペクターパネルのサイズ変更',
  'frameTitle': 'NodeJS インスペクター',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'Inspector NodeJS',
  toggle: 'Alternar inspector NodeJS',
  close: 'Contraer',
  resize: 'Cambiar el tamaño del panel inspector NodeJS',
  frameTitle: 'Inspector NodeJS',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'Inspecteur NodeJS',
  toggle: "Basculer l'inspecteur NodeJS",
  close: 'Réduire',
  resize: "Redimensionner le panneau d'inspection NodeJS",
  frameTitle: 'Inspecteur NodeJS',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'NodeJS-Inspektor',
  toggle: 'Schalten Sie den NodeJS-Inspektor um',
  close: 'Einklappen',
  resize: 'Größe des NodeJS-Inspektorfelds ändern',
  frameTitle: 'NodeJS-Inspektor',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'NodeJS инспектор',
  toggle: 'Переключить инспектор NodeJS',
  close: 'Свернуть',
  resize: 'Изменение размера панели инспектора NodeJS',
  frameTitle: 'NodeJS инспектор',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'NodeJS inspetor',
  toggle: 'Alternar inspetor NodeJS',
  close: 'Recolher',
  resize: 'Redimensionar painel do inspetor NodeJS',
  frameTitle: 'NodeJS inspetor',
} satisfies Record<keyof typeof en, string>
