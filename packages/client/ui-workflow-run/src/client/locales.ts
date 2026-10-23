/** `workflowRun` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'workflowRun'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'run.title': '{name}',
  'run.members.one': '{count} 个成员',
  'run.members.other': '{count} 个成员',
  'run.empty': '没有启动成员',
  'phase.unassigned': '未分阶段',
  'phase.empty': '空阶段名',
  'statusCount.running': '运行中 {count}',
  'statusCount.completed': '已完成 {count}',
  'statusCount.failed': '失败 {count}',
  'statusCount.cancelled': '已取消 {count}',
  'statusCount.interrupted': '已中断 {count}',
  'member.empty': '空成员名',
  'member.open': '打开 {name}',
  'status.running': '运行中',
  'status.completed': '已完成',
  'status.failed': '失败',
  'status.cancelled': '已取消',
  'status.interrupted': '已中断',
}

/** English dictionary (same key set). */
export const en: Record<WorkflowRunKey, string> = {
  'run.title': '{name}',
  'run.members.one': '{count} member',
  'run.members.other': '{count} members',
  'run.empty': 'No members started',
  'phase.unassigned': 'Unphased',
  'phase.empty': 'Empty phase name',
  'statusCount.running': 'Running {count}',
  'statusCount.completed': 'Completed {count}',
  'statusCount.failed': 'Failed {count}',
  'statusCount.cancelled': 'Cancelled {count}',
  'statusCount.interrupted': 'Interrupted {count}',
  'member.empty': 'Empty member name',
  'member.open': 'Open {name}',
  'status.running': 'Running',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.cancelled': 'Cancelled',
  'status.interrupted': 'Interrupted',
}

/** Union of this namespace's dictionary keys. */
export type WorkflowRunKey = keyof typeof zh

/** Japanese copy, checked against the English keys. */
export const ja = {
  'run.title': '{name}',
  'run.members.one': '{count}人のメンバー',
  'run.members.other': '{count}人のメンバー',
  'run.empty': '開始されたメンバーはいません',
  'phase.unassigned': 'フェーズなし',
  'phase.empty': 'フェーズ名が空です',
  'statusCount.running': '実行中 {count}',
  'statusCount.completed': '完了 {count}',
  'statusCount.failed': '失敗 {count}',
  'statusCount.cancelled': 'キャンセル {count}',
  'statusCount.interrupted': '中断 {count}',
  'member.empty': 'メンバー名が空です',
  'member.open': '{name}を開く',
  'status.running': '実行中',
  'status.completed': '完了',
  'status.failed': '失敗',
  'status.cancelled': 'キャンセル',
  'status.interrupted': '中断',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'run.title': '{name}',
  'run.members.one': 'Miembro de {count}',
  'run.members.other': 'Miembros de {count}',
  'run.empty': 'Ningún miembro comenzó',
  'phase.unassigned': 'sin fases',
  'phase.empty': 'Nombre de fase vacío',
  'statusCount.running': 'Ejecutando {count}',
  'statusCount.completed': 'Completado {count}',
  'statusCount.failed': 'Error {count}',
  'statusCount.cancelled': 'Cancelado {count}',
  'statusCount.interrupted': 'Interrumpido {count}',
  'member.empty': 'Nombre de miembro vacío',
  'member.open': 'Abrir {name}',
  'status.running': 'corriendo',
  'status.completed': 'Completado',
  'status.failed': 'Fallido',
  'status.cancelled': 'Cancelado',
  'status.interrupted': 'interrumpido',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'run.title': '{name}',
  'run.members.one': 'Membre {count}',
  'run.members.other': 'Membres {count}',
  'run.empty': "Aucun membre n'a commencé",
  'phase.unassigned': 'Sans phase',
  'phase.empty': 'Nom de phase vide',
  'statusCount.running': 'Exécution de {count}',
  'statusCount.completed': 'Terminé {count}',
  'statusCount.failed': 'Échec du {count}',
  'statusCount.cancelled': 'Annulé {count}',
  'statusCount.interrupted': '{count} interrompu',
  'member.empty': 'Nom du membre vide',
  'member.open': 'Ouvrir {name}',
  'status.running': 'Courir',
  'status.completed': 'Terminé',
  'status.failed': 'Échec',
  'status.cancelled': 'Annulé',
  'status.interrupted': 'Interrompu',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'run.title': '{name}',
  'run.members.one': '{count}-Mitglied',
  'run.members.other': '{count}-Mitglieder',
  'run.empty': 'Keine Mitglieder gestartet',
  'phase.unassigned': 'Unphasiert',
  'phase.empty': 'Leerer Phasenname',
  'statusCount.running': 'Ausführen von {count}',
  'statusCount.completed': '{count} abgeschlossen',
  'statusCount.failed': 'Fehlgeschlagen {count}',
  'statusCount.cancelled': 'Storniert {count}',
  'statusCount.interrupted': 'Unterbrochen {count}',
  'member.empty': 'Leerer Mitgliedsname',
  'member.open': 'Öffnen Sie {name}',
  'status.running': 'Laufen',
  'status.completed': 'Abgeschlossen',
  'status.failed': 'Fehlgeschlagen',
  'status.cancelled': 'Abgesagt',
  'status.interrupted': 'Unterbrochen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'run.title': '{name}',
  'run.members.one': 'Участник {count}',
  'run.members.other': 'Участники {count}',
  'run.empty': 'Ни один из участников не стартовал',
  'phase.unassigned': 'Нефазированный',
  'phase.empty': 'Пустое имя фазы',
  'statusCount.running': 'Запуск {count}',
  'statusCount.completed': 'Завершено {count}',
  'statusCount.failed': 'Ошибка {count}',
  'statusCount.cancelled': 'Отменено {count}',
  'statusCount.interrupted': 'Прервано {count}',
  'member.empty': 'Пустое имя участника',
  'member.open': 'Открыть {name}',
  'status.running': 'Бег',
  'status.completed': 'Завершено',
  'status.failed': 'Не удалось',
  'status.cancelled': 'Отменено',
  'status.interrupted': 'Прерванный',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'run.title': '{name}',
  'run.members.one': '{count} membro',
  'run.members.other': '{count} membros',
  'run.empty': 'Nenhum membro começou',
  'phase.unassigned': 'Sem fases',
  'phase.empty': 'Nome da fase vazia',
  'statusCount.running': 'Executando {count}',
  'statusCount.completed': 'Concluído {count}',
  'statusCount.failed': 'Falha {count}',
  'statusCount.cancelled': 'Cancelado {count}',
  'statusCount.interrupted': 'Interrompido {count}',
  'member.empty': 'Nome de membro vazio',
  'member.open': 'Abra {name}',
  'status.running': 'Correndo',
  'status.completed': 'Concluído',
  'status.failed': 'Falha',
  'status.cancelled': 'Cancelado',
  'status.interrupted': 'Interrompido',
} satisfies Record<keyof typeof en, string>
