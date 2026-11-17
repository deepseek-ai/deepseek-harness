/** English card frame, fallback and tool-row copy. */
export const en = {
  expandBrief: 'Show more', collapseBrief: 'Show less',
  dismiss: 'Not now', dismissed: 'Dismissed', replaced: 'Replaced',
  unavailable: 'This action is unavailable. Check the plugin in Plugins.',
  transport: 'Could not confirm the result. Reconnect and check the card before retrying.',
  'row.title': 'Action card', 'row.preparing': 'Preparing a card', 'row.running': 'Proposing',
  'row.ok': 'Proposed', 'row.error': 'Not shown', 'row.stopped': 'Interrupted', 'row.inspect': 'Inspect call',
}

/** Keys shared by every dictionary. */
export type ActionCardKey = keyof typeof en

/** Chinese card frame, fallback and tool-row copy. */
export const zh: Record<ActionCardKey, string> = {
  expandBrief: '展开', collapseBrief: '收起',
  dismiss: '暂不需要', dismissed: '已忽略', replaced: '已替换',
  unavailable: '暂时无法执行，请到插件页面查看',
  transport: '暂时无法确认结果，请重新连接并查看卡片状态后再重试',
  'row.title': '操作卡片', 'row.preparing': '正在准备卡片', 'row.running': '正在提议',
  'row.ok': '已提议', 'row.error': '未显示', 'row.stopped': '已中断', 'row.inspect': '查看调用',
}

/** Japanese card frame, fallback and tool-row copy. */
export const ja: Record<ActionCardKey, string> = {
  expandBrief: 'すべて表示', collapseBrief: '折りたたむ',
  dismiss: '今はしない', dismissed: '却下済み', replaced: '置き換え済み',
  unavailable: 'この操作は利用できません。プラグイン画面でプラグインを確認してください。',
  transport: '結果を確認できませんでした。再接続してカードを確認してから再試行してください。',
  'row.title': 'アクションカード', 'row.preparing': 'カードを準備中', 'row.running': '提案中',
  'row.ok': '提案済み', 'row.error': '表示されませんでした', 'row.stopped': '中断されました', 'row.inspect': '呼び出しを確認',
}

/** Spanish card frame, fallback and tool-row copy. */
export const es: Record<ActionCardKey, string> = {
  expandBrief: 'Mostrar más', collapseBrief: 'Mostrar menos',
  dismiss: 'Ahora no', dismissed: 'Descartado', replaced: 'Reemplazado',
  unavailable: 'Esta acción no está disponible. Revisa el complemento en Complementos.',
  transport: 'No se pudo confirmar el resultado. Vuelve a conectarte y revisa la tarjeta antes de reintentar.',
  'row.title': 'Tarjeta de acción', 'row.preparing': 'Preparando una tarjeta', 'row.running': 'Proponiendo',
  'row.ok': 'Propuesto', 'row.error': 'No se mostró', 'row.stopped': 'Interrumpido', 'row.inspect': 'Inspeccionar llamada',
}

/** French card frame, fallback and tool-row copy. */
export const fr: Record<ActionCardKey, string> = {
  expandBrief: 'Afficher plus', collapseBrief: 'Afficher moins',
  dismiss: 'Pas maintenant', dismissed: 'Ignoré', replaced: 'Remplacé',
  unavailable: "Cette action n'est pas disponible. Vérifiez le plugin dans Plugins.",
  transport: 'Impossible de confirmer le résultat. Reconnectez-vous et vérifiez la carte avant de réessayer.',
  'row.title': "Carte d'action", 'row.preparing': "Préparation d'une carte", 'row.running': 'Proposition en cours',
  'row.ok': 'Proposé', 'row.error': 'Non affiché', 'row.stopped': 'Interrompu', 'row.inspect': "Inspecter l'appel",
}

/** German card frame, fallback and tool-row copy. */
export const de: Record<ActionCardKey, string> = {
  expandBrief: 'Mehr anzeigen', collapseBrief: 'Weniger anzeigen',
  dismiss: 'Nicht jetzt', dismissed: 'Verworfen', replaced: 'Ersetzt',
  unavailable: 'Diese Aktion ist nicht verfügbar. Prüfen Sie das Plugin unter Plugins.',
  transport: 'Das Ergebnis konnte nicht bestätigt werden. Verbinden Sie sich erneut und prüfen Sie die Karte, bevor Sie es erneut versuchen.',
  'row.title': 'Aktionskarte', 'row.preparing': 'Karte wird vorbereitet', 'row.running': 'Wird vorgeschlagen',
  'row.ok': 'Vorgeschlagen', 'row.error': 'Nicht angezeigt', 'row.stopped': 'Unterbrochen', 'row.inspect': 'Aufruf prüfen',
}

/** Russian card frame, fallback and tool-row copy. */
export const ru: Record<ActionCardKey, string> = {
  expandBrief: 'Показать больше', collapseBrief: 'Показать меньше',
  dismiss: 'Не сейчас', dismissed: 'Отклонено', replaced: 'Заменено',
  unavailable: 'Это действие недоступно. Проверьте плагин в разделе «Плагины».',
  transport: 'Не удалось подтвердить результат. Переподключитесь и проверьте карточку перед повторной попыткой.',
  'row.title': 'Карточка действия', 'row.preparing': 'Подготовка карточки', 'row.running': 'Предлагается',
  'row.ok': 'Предложено', 'row.error': 'Не показано', 'row.stopped': 'Прервано', 'row.inspect': 'Проверить вызов',
}

/** Portuguese card frame, fallback and tool-row copy. */
export const pt: Record<ActionCardKey, string> = {
  expandBrief: 'Mostrar mais', collapseBrief: 'Mostrar menos',
  dismiss: 'Agora não', dismissed: 'Dispensado', replaced: 'Substituído',
  unavailable: 'Esta ação não está disponível. Verifique o plug-in em Plug-ins.',
  transport: 'Não foi possível confirmar o resultado. Reconecte-se e verifique o cartão antes de tentar novamente.',
  'row.title': 'Cartão de ação', 'row.preparing': 'Preparando um cartão', 'row.running': 'Propondo',
  'row.ok': 'Proposto', 'row.error': 'Não exibido', 'row.stopped': 'Interrompido', 'row.inspect': 'Inspecionar chamada',
}
