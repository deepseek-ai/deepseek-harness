/** Shared zoom copy embedded into renderer-owned dictionaries. */
export const zoomZh = {
  zoomControls: '缩放控件',
  zoomMenu: '选择缩放比例',
  zoomOut: '缩小',
  zoomIn: '放大',
  zoomFitWidth: '适应宽度',
  zoomValue: '{percent}%',
} as const

/** Shared English zoom copy. */
export const zoomEn = {
  zoomControls: 'Zoom controls',
  zoomMenu: 'Choose zoom',
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  zoomFitWidth: 'Fit width',
  zoomValue: '{percent}%',
} satisfies Record<keyof typeof zoomZh, string>

/** Shared zoom dictionary keys. */
export type ZoomLocaleKey = keyof typeof zoomZh

/** Japanese copy, checked against the English keys. */
export const zoomJa = {
  'zoomControls': 'ズーム操作',
  'zoomMenu': 'ズームを選択',
  'zoomOut': '縮小',
  'zoomIn': '拡大',
  'zoomFitWidth': '幅に合わせる',
  'zoomValue': '{percent}%',
} satisfies Record<keyof typeof zoomEn, string>

/** Spanish dictionary, checked against the English keys. */
export const zoomEs = {
  zoomControls: 'Controles de zoom',
  zoomMenu: 'Elige zoom',
  zoomOut: 'alejar',
  zoomIn: 'Acercar',
  zoomFitWidth: 'Ancho de ajuste',
  zoomValue: '{percent}%',
} satisfies typeof zoomEn

/** French dictionary, checked against the English keys. */
export const zoomFr = {
  zoomControls: 'Commandes de zoom',
  zoomMenu: 'Choisissez le zoom',
  zoomOut: 'Zoom arrière',
  zoomIn: 'Zoomer',
  zoomFitWidth: 'Ajuster la largeur',
  zoomValue: '{percent}%',
} satisfies typeof zoomEn

/** German dictionary, checked against the English keys. */
export const zoomDe = {
  zoomControls: 'Zoom-Steuerelemente',
  zoomMenu: 'Wählen Sie Zoom',
  zoomOut: 'Herauszoomen',
  zoomIn: 'Vergrößern',
  zoomFitWidth: 'Breite anpassen',
  zoomValue: '{percent}%',
} satisfies typeof zoomEn

/** Russian dictionary, checked against the English keys. */
export const zoomRu = {
  zoomControls: 'Элементы управления масштабированием',
  zoomMenu: 'Выберите масштаб',
  zoomOut: 'Уменьшить масштаб',
  zoomIn: 'Увеличить масштаб',
  zoomFitWidth: 'Подходит по ширине',
  zoomValue: '{percent}%',
} satisfies typeof zoomEn

/** Portuguese dictionary, checked against the English keys. */
export const zoomPt = {
  zoomControls: 'Controles de zoom',
  zoomMenu: 'Escolha o zoom',
  zoomOut: 'Diminuir zoom',
  zoomIn: 'Ampliar',
  zoomFitWidth: 'Ajustar largura',
  zoomValue: '{percent}%',
} satisfies typeof zoomEn
