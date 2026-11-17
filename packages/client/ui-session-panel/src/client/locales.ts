/** `sessionPanel` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'sessionPanel'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.name': '会话面板',
  'toggle.show': '显示会话面板',
  'toggle.hide': '隐藏会话面板',
  'toggle.unavailable': '切换到「对话」视图后可显示会话面板',
  'pin.name': '固定会话面板',
  'pin.pin': '固定面板',
  'pin.unpin': '取消固定',
  'section.environment': '环境',
  'section.reorder': '调整「{name}」的顺序',
  'section.reorderHelp': '拖动排序，或用上下方向键调整顺序',
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
  'toggle.unavailable': 'Switch to the Chat view to show the session panel',
  'pin.name': 'Pin session panel',
  'pin.pin': 'Pin panel',
  'pin.unpin': 'Unpin panel',
  'section.environment': 'Environment',
  'section.reorder': 'Reorder {name}',
  'section.reorderHelp': 'Drag to reorder, or use the up and down arrow keys',
  'project.label': 'Working folder',
  'project.actions': 'Working folder actions',
}

/** Japanese dictionary. */
export const ja = {
  'panel.name': 'セッションパネル',
  'toggle.show': 'セッションパネルを表示',
  'toggle.hide': 'セッションパネルを非表示',
  'toggle.unavailable': '「チャット」ビューに切り替えるとセッションパネルを表示できます',
  'pin.name': 'セッションパネルを固定',
  'pin.pin': 'パネルを固定',
  'pin.unpin': '固定を解除',
  'section.environment': '環境',
  'section.reorder': '「{name}」の順序を変更',
  'section.reorderHelp': 'ドラッグ、または上下の矢印キーで順序を変更できます',
  'project.label': '作業フォルダー',
  'project.actions': '作業フォルダーの操作',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary. */
export const es = {
  'panel.name': 'Panel de la sesión',
  'toggle.show': 'Mostrar el panel de la sesión',
  'toggle.hide': 'Ocultar el panel de la sesión',
  'toggle.unavailable': 'Cambia a la vista Chat para mostrar el panel de la sesión',
  'pin.name': 'Fijar el panel de la sesión',
  'pin.pin': 'Fijar panel',
  'pin.unpin': 'Dejar de fijar',
  'section.environment': 'Entorno',
  'section.reorder': 'Reordenar {name}',
  'section.reorderHelp': 'Arrastra para reordenar o usa las teclas de flecha hacia arriba y hacia abajo',
  'project.label': 'Carpeta de trabajo',
  'project.actions': 'Acciones de la carpeta de trabajo',
} satisfies Record<keyof typeof en, string>

/** French dictionary. */
export const fr = {
  'panel.name': 'Panneau de session',
  'toggle.show': 'Afficher le panneau de session',
  'toggle.hide': 'Masquer le panneau de session',
  'toggle.unavailable': 'Passez à la vue Discussion pour afficher le panneau de session',
  'pin.name': 'Épingler le panneau de session',
  'pin.pin': 'Épingler le panneau',
  'pin.unpin': 'Détacher le panneau',
  'section.environment': 'Environnement',
  'section.reorder': 'Réorganiser {name}',
  'section.reorderHelp': 'Faites glisser pour réorganiser ou utilisez les touches fléchées haut et bas',
  'project.label': 'Dossier de travail',
  'project.actions': 'Actions sur le dossier de travail',
} satisfies Record<keyof typeof en, string>

/** German dictionary. */
export const de = {
  'panel.name': 'Sitzungsbereich',
  'toggle.show': 'Sitzungsbereich anzeigen',
  'toggle.hide': 'Sitzungsbereich ausblenden',
  'toggle.unavailable': 'Wechseln Sie zur Ansicht „Chat“, um den Sitzungsbereich anzuzeigen',
  'pin.name': 'Sitzungsbereich anheften',
  'pin.pin': 'Bereich anheften',
  'pin.unpin': 'Bereich lösen',
  'section.environment': 'Umgebung',
  'section.reorder': '{name} neu anordnen',
  'section.reorderHelp': 'Zum Neuanordnen ziehen oder die Pfeiltasten nach oben und unten verwenden',
  'project.label': 'Arbeitsordner',
  'project.actions': 'Aktionen für den Arbeitsordner',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary. */
export const ru = {
  'panel.name': 'Панель сеанса',
  'toggle.show': 'Показать панель сеанса',
  'toggle.hide': 'Скрыть панель сеанса',
  'toggle.unavailable': 'Переключитесь на вид «Чат», чтобы показать панель сеанса',
  'pin.name': 'Закрепить панель сеанса',
  'pin.pin': 'Закрепить панель',
  'pin.unpin': 'Открепить панель',
  'section.environment': 'Среда',
  'section.reorder': 'Изменить порядок: {name}',
  'section.reorderHelp': 'Перетащите, чтобы изменить порядок, или используйте клавиши со стрелками вверх и вниз',
  'project.label': 'Рабочая папка',
  'project.actions': 'Действия с рабочей папкой',
} satisfies Record<keyof typeof en, string>

/** Brazilian Portuguese dictionary. */
export const pt = {
  'panel.name': 'Painel da sessão',
  'toggle.show': 'Mostrar painel da sessão',
  'toggle.hide': 'Ocultar painel da sessão',
  'toggle.unavailable': 'Mude para a visualização Chat para mostrar o painel da sessão',
  'pin.name': 'Fixar painel da sessão',
  'pin.pin': 'Fixar painel',
  'pin.unpin': 'Desafixar painel',
  'section.environment': 'Ambiente',
  'section.reorder': 'Reordenar {name}',
  'section.reorderHelp': 'Arraste para reordenar ou use as teclas de seta para cima e para baixo',
  'project.label': 'Pasta de trabalho',
  'project.actions': 'Ações da pasta de trabalho',
} satisfies Record<keyof typeof en, string>
