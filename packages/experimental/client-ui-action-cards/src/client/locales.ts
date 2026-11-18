/** English card frame and fallback copy. */
export const en = {
  expandBrief: 'Show more', collapseBrief: 'Show less',
  dismiss: 'Not now', dismissed: 'Dismissed', replaced: 'Replaced',
  unavailable: 'This action is unavailable. Check the plugin in Plugins.',
  transport: 'Could not confirm the result. Reconnect and check the card before retrying.',
}

/** Keys shared by every dictionary. */
export type ActionCardKey = keyof typeof en

/** Chinese card frame and fallback copy. */
export const zh: Record<ActionCardKey, string> = {
  expandBrief: '展开', collapseBrief: '收起',
  dismiss: '暂不需要', dismissed: '已忽略', replaced: '已替换',
  unavailable: '暂时无法执行，请到插件页面查看',
  transport: '暂时无法确认结果，请重新连接并查看卡片状态后再重试',
}

/** Japanese card frame and fallback copy. */
export const ja: Record<ActionCardKey, string> = {
  expandBrief: 'すべて表示', collapseBrief: '折りたたむ',
  dismiss: '今はしない', dismissed: '却下済み', replaced: '置き換え済み',
  unavailable: 'この操作は利用できません。プラグイン画面でプラグインを確認してください。',
  transport: '結果を確認できませんでした。再接続してカードを確認してから再試行してください。',
}

/** Spanish card frame and fallback copy. */
export const es: Record<ActionCardKey, string> = {
  expandBrief: 'Mostrar más', collapseBrief: 'Mostrar menos',
  dismiss: 'Ahora no', dismissed: 'Descartado', replaced: 'Reemplazado',
  unavailable: 'Esta acción no está disponible. Revisa el complemento en Complementos.',
  transport: 'No se pudo confirmar el resultado. Vuelve a conectarte y revisa la tarjeta antes de reintentar.',
}

/** French card frame and fallback copy. */
export const fr: Record<ActionCardKey, string> = {
  expandBrief: 'Afficher plus', collapseBrief: 'Afficher moins',
  dismiss: 'Pas maintenant', dismissed: 'Ignoré', replaced: 'Remplacé',
  unavailable: "Cette action n'est pas disponible. Vérifiez le plugin dans Plugins.",
  transport: 'Impossible de confirmer le résultat. Reconnectez-vous et vérifiez la carte avant de réessayer.',
}

/** German card frame and fallback copy. */
export const de: Record<ActionCardKey, string> = {
  expandBrief: 'Mehr anzeigen', collapseBrief: 'Weniger anzeigen',
  dismiss: 'Nicht jetzt', dismissed: 'Verworfen', replaced: 'Ersetzt',
  unavailable: 'Diese Aktion ist nicht verfügbar. Prüfen Sie das Plugin unter Plugins.',
  transport: 'Das Ergebnis konnte nicht bestätigt werden. Verbinden Sie sich erneut und prüfen Sie die Karte, bevor Sie es erneut versuchen.',
}

/** Russian card frame and fallback copy. */
export const ru: Record<ActionCardKey, string> = {
  expandBrief: 'Показать больше', collapseBrief: 'Показать меньше',
  dismiss: 'Не сейчас', dismissed: 'Отклонено', replaced: 'Заменено',
  unavailable: 'Это действие недоступно. Проверьте плагин в разделе «Плагины».',
  transport: 'Не удалось подтвердить результат. Переподключитесь и проверьте карточку перед повторной попыткой.',
}

/** Portuguese card frame and fallback copy. */
export const pt: Record<ActionCardKey, string> = {
  expandBrief: 'Mostrar mais', collapseBrief: 'Mostrar menos',
  dismiss: 'Agora não', dismissed: 'Dispensado', replaced: 'Substituído',
  unavailable: 'Esta ação não está disponível. Verifique o plug-in em Plug-ins.',
  transport: 'Não foi possível confirmar o resultado. Reconecte-se e verifique o cartão antes de tentar novamente.',
}
