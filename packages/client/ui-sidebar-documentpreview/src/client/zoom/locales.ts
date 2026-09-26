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
