/**
 * `slash.menu` namespace dictionaries: group titles keyed by source name
 * (the lookup chain returns the key itself, so an unknown source shows its
 * raw name), the pending row, and the listbox and header aria labels.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'command': '指令',
  'skill': '技能',
  'subagent': '子智能体',
  'loading': '正在加载…',
  'drill.aria': '进入目录',
  'drill.hint': '进入目录',
  'drill.key': 'Tab',
  'crumbs.aria': '目录导航',
  'suggestions.aria': '触发候选建议',
} satisfies Record<string, string>

/** The slash.menu namespace key union. */
export type MenuKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'command': 'Commands',
  'skill': 'Skills',
  'subagent': 'Subagents',
  'loading': 'Loading…',
  'drill.aria': 'Browse folder',
  'drill.hint': 'Browse folder',
  'drill.key': 'Tab',
  'crumbs.aria': 'Folder navigation',
  'suggestions.aria': 'Trigger suggestions',
} satisfies Record<MenuKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'command': 'コマンド',
  'skill': 'スキル',
  'subagent': 'サブエージェント',
  'loading': '読み込み中…',
  'drill.aria': 'フォルダを参照',
  'drill.hint': 'フォルダを参照',
  'drill.key': 'Tab',
  'crumbs.aria': 'フォルダナビゲーション',
  'suggestions.aria': '候補を表示',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'command': 'Comandos',
  'skill': 'Habilidades',
  'subagent': 'Subagentes',
  'loading': 'Cargando…',
  'drill.aria': 'Explorar carpeta',
  'drill.hint': 'Explorar carpeta',
  'drill.key': 'Pestaña',
  'crumbs.aria': 'Navegación de carpetas',
  'suggestions.aria': 'Sugerencias de activación',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'command': 'Commandes',
  'skill': 'Compétences',
  'subagent': 'Sous-agents',
  'loading': 'Chargement…',
  'drill.aria': 'Parcourir le dossier',
  'drill.hint': 'Parcourir le dossier',
  'drill.key': 'Onglet',
  'crumbs.aria': 'Navigation dans les dossiers',
  'suggestions.aria': 'Suggestions de déclenchement',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'command': 'Befehle',
  'skill': 'Fähigkeiten',
  'subagent': 'Subagenten',
  'loading': 'Laden…',
  'drill.aria': 'Ordner durchsuchen',
  'drill.hint': 'Ordner durchsuchen',
  'drill.key': 'Tab',
  'crumbs.aria': 'Ordnernavigation',
  'suggestions.aria': 'Trigger-Vorschläge',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'command': 'Команды',
  'skill': 'Навыки',
  'subagent': 'Субагенты',
  'loading': 'Загрузка…',
  'drill.aria': 'Просмотреть папку',
  'drill.hint': 'Просмотреть папку',
  'drill.key': 'Вкладка',
  'crumbs.aria': 'Навигация по папкам',
  'suggestions.aria': 'Триггерные предложения',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'command': 'Comandos',
  'skill': 'Habilidades',
  'subagent': 'Subagentes',
  'loading': 'Carregando…',
  'drill.aria': 'Navegar na pasta',
  'drill.hint': 'Navegar na pasta',
  'drill.key': 'Guia',
  'crumbs.aria': 'Navegação de pastas',
  'suggestions.aria': 'Sugestões de gatilho',
} satisfies Record<keyof typeof en, string>
