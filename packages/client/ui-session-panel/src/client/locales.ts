/** `sessionPanel` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'sessionPanel'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.name': '会话面板',
  'toggle.show': '显示会话面板',
  'toggle.hide': '隐藏会话面板',
  'section.environment': '环境',
  'project.label': '工作目录',
  'project.actions': '工作目录操作',
} as const

/** Every key of the `sessionPanel` namespace. */
export type SessionPanelKey = keyof typeof zh

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<SessionPanelKey, string> = {
  'panel.name': 'Session panel',
  'toggle.show': 'Show session panel',
  'toggle.hide': 'Hide session panel',
  'section.environment': 'Environment',
  'project.label': 'Working folder',
  'project.actions': 'Working folder actions',
}

/** Japanese dictionary. */
export const ja = {
  'panel.name': 'セッションパネル',
  'toggle.show': 'セッションパネルを表示',
  'toggle.hide': 'セッションパネルを非表示',
  'section.environment': '環境',
  'project.label': '作業フォルダー',
  'project.actions': '作業フォルダーの操作',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary. */
export const es = {
  'panel.name': 'Panel de la sesión',
  'toggle.show': 'Mostrar el panel de la sesión',
  'toggle.hide': 'Ocultar el panel de la sesión',
  'section.environment': 'Entorno',
  'project.label': 'Carpeta de trabajo',
  'project.actions': 'Acciones de la carpeta de trabajo',
} satisfies Record<keyof typeof en, string>

/** French dictionary. */
export const fr = {
  'panel.name': 'Panneau de session',
  'toggle.show': 'Afficher le panneau de session',
  'toggle.hide': 'Masquer le panneau de session',
  'section.environment': 'Environnement',
  'project.label': 'Dossier de travail',
  'project.actions': 'Actions sur le dossier de travail',
} satisfies Record<keyof typeof en, string>

/** German dictionary. */
export const de = {
  'panel.name': 'Sitzungsbereich',
  'toggle.show': 'Sitzungsbereich anzeigen',
  'toggle.hide': 'Sitzungsbereich ausblenden',
  'section.environment': 'Umgebung',
  'project.label': 'Arbeitsordner',
  'project.actions': 'Aktionen für den Arbeitsordner',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary. */
export const ru = {
  'panel.name': 'Панель сеанса',
  'toggle.show': 'Показать панель сеанса',
  'toggle.hide': 'Скрыть панель сеанса',
  'section.environment': 'Среда',
  'project.label': 'Рабочая папка',
  'project.actions': 'Действия с рабочей папкой',
} satisfies Record<keyof typeof en, string>

/** Brazilian Portuguese dictionary. */
export const pt = {
  'panel.name': 'Painel da sessão',
  'toggle.show': 'Mostrar painel da sessão',
  'toggle.hide': 'Ocultar painel da sessão',
  'section.environment': 'Ambiente',
  'project.label': 'Pasta de trabalho',
  'project.actions': 'Ações da pasta de trabalho',
} satisfies Record<keyof typeof en, string>
