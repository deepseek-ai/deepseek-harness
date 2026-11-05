/** Web dictionaries for the chrome around a mod's band; the mods' own content is theirs. */

/** Locale namespace owned by the mods band. */
export const NS = 'claude-code-mods'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  band: 'Claude Code 模组',
  pressing: '正在处理…',
  'press.failed': '按钮操作失败：{message}',
  'press.stale': '该按钮属于更早的绘制，面板已刷新',
} satisfies Record<string, string>

/** Mods band locale key union. */
export type ModsBandKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  band: 'Claude Code mods',
  pressing: 'Working…',
  'press.failed': 'The button failed: {message}',
  'press.stale': 'That button belonged to an earlier drawing; the band has refreshed',
} satisfies Record<ModsBandKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'band': 'Claude Code の改造',
  'pressing': '実行中…',
  'press.failed': 'ボタンが失敗しました: {message}',
  'press.stale': 'そのボタンは以前の描画のものです。バンドは更新されました',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  band: 'Modificaciones Claude Code',
  pressing: 'Trabajando…',
  'press.failed': 'El botón falló: {message}',
  'press.stale': 'Ese botón pertenecía a un dibujo anterior; la banda se ha renovado',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  band: 'Mods Claude Code',
  pressing: 'Travailler…',
  'press.failed': 'Le bouton a échoué : {message}',
  'press.stale': "Ce bouton appartenait à un dessin antérieur ; le groupe s'est rafraîchi",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  band: 'Claude Code-Mods',
  pressing: 'Arbeiten…',
  'press.failed': 'Die Schaltfläche ist fehlgeschlagen: {message}',
  'press.stale': 'Dieser Knopf gehörte zu einer früheren Zeichnung; Die Band hat sich erfrischt',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  band: 'Claude Code моды',
  pressing: 'Работаю…',
  'press.failed': 'Кнопка не удалась: {message}',
  'press.stale': 'Эта кнопка принадлежала более раннему рисунку; группа обновилась',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  band: 'Claude Code modificações',
  pressing: 'Trabalhando…',
  'press.failed': 'O botão falhou: {message}',
  'press.stale': 'Esse botão pertencia a um desenho anterior; a banda se atualizou',
} satisfies Record<keyof typeof en, string>
