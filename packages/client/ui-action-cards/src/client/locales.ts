/** English card frame, fallback and settings copy. */
export const en = {
  expandBrief: 'Show more', collapseBrief: 'Show less',
  dismiss: 'Not now', dismissed: 'Dismissed',
  unavailable: 'This action is unavailable. Check the plugin in Plugins.',
  transport: 'Could not confirm the result. Reconnect and check the card before retrying.',
  'settings.title': 'Personalized recommendations',
  'settings.description': 'Shows recommendation cards below the answer for what you want from DSH',
  'settings.details': 'When you want a page or small tool you can keep, it proposes a new personalized page, built in the background after you click Create; when you ask how to do something in this app or say a capability is missing, it recommends the built-in plugin that provides it, turned on when you click Enable.',
  'settings.detailsLabel': 'About personalized recommendations',
  'settings.error': 'Could not save. Please try again.',
}

/** Keys shared by every dictionary. */
export type ActionCardKey = keyof typeof en

/** Chinese card frame, fallback and settings copy. */
export const zh: Record<ActionCardKey, string> = {
  expandBrief: '展开', collapseBrief: '收起',
  dismiss: '暂不需要', dismissed: '已忽略',
  unavailable: '暂时无法执行，请到插件页面查看',
  transport: '暂时无法确认结果，请重新连接并查看卡片状态后再重试',
  'settings.title': '个性化推荐',
  'settings.description': '针对你对 DSH 的个性化需求，在回答下方展示推荐卡片',
  'settings.details': '想要能长期使用的页面或小工具时，提议新增个性化页面，点击创建后在后台生成；问到本应用怎么做某件事或缺少某项能力时，推荐对应的内置插件，点击启用后开启。',
  'settings.detailsLabel': '个性化推荐说明',
  'settings.error': '保存失败，请重试',
}

/** Japanese card frame, fallback and settings copy. */
export const ja: Record<ActionCardKey, string> = {
  expandBrief: 'すべて表示', collapseBrief: '折りたたむ',
  dismiss: '今はしない', dismissed: '却下済み',
  unavailable: 'この操作は利用できません。プラグイン画面でプラグインを確認してください。',
  transport: '結果を確認できませんでした。再接続してカードを確認してから再試行してください。',
  'settings.title': 'パーソナライズされたおすすめ',
  'settings.description': 'DSH に対するあなた個人のニーズに合わせて、回答の下におすすめカードを表示します',
  'settings.details': '長く使えるページや小さなツールが欲しいときは新しいパーソナルページを提案し、「作成」をクリックするとバックグラウンドで生成します。このアプリで何かをする方法を尋ねたときや機能が足りないと言ったときは、それを提供する内蔵プラグインを推薦し、「有効にする」をクリックすると有効になります。',
  'settings.detailsLabel': 'パーソナライズされたおすすめについて',
  'settings.error': '保存できませんでした。再試行してください。',
}

/** Spanish card frame, fallback and settings copy. */
export const es: Record<ActionCardKey, string> = {
  expandBrief: 'Mostrar más', collapseBrief: 'Mostrar menos',
  dismiss: 'Ahora no', dismissed: 'Descartado',
  unavailable: 'Esta acción no está disponible. Revisa el complemento en Complementos.',
  transport: 'No se pudo confirmar el resultado. Vuelve a conectarte y revisa la tarjeta antes de reintentar.',
  'settings.title': 'Recomendaciones personalizadas',
  'settings.description': 'Muestra tarjetas de recomendación debajo de la respuesta para tus necesidades personalizadas en DSH',
  'settings.details': 'Cuando quieres una página o una pequeña herramienta para conservar, propone una nueva página personalizada, que se genera en segundo plano al hacer clic en Crear; cuando preguntas cómo hacer algo en esta aplicación o dices que falta una función, recomienda el complemento integrado que la ofrece, que se activa al hacer clic en Habilitar.',
  'settings.detailsLabel': 'Acerca de las recomendaciones personalizadas',
  'settings.error': 'No se pudo guardar. Por favor inténtalo de nuevo.',
}

/** French card frame, fallback and settings copy. */
export const fr: Record<ActionCardKey, string> = {
  expandBrief: 'Afficher plus', collapseBrief: 'Afficher moins',
  dismiss: 'Pas maintenant', dismissed: 'Ignoré',
  unavailable: "Cette action n'est pas disponible. Vérifiez le plugin dans Plugins.",
  transport: 'Impossible de confirmer le résultat. Reconnectez-vous et vérifiez la carte avant de réessayer.',
  'settings.title': 'Recommandations personnalisées',
  'settings.description': 'Affiche des cartes de recommandation sous la réponse pour vos besoins personnalisés dans DSH',
  'settings.details': 'Lorsque vous voulez une page ou un petit outil à conserver, propose une nouvelle page personnalisée, générée en arrière-plan après un clic sur Créer ; lorsque vous demandez comment faire quelque chose dans cette application ou signalez qu’une fonctionnalité manque, recommande le plugin intégré qui la fournit, activé lorsque vous cliquez sur Activer.',
  'settings.detailsLabel': 'À propos des recommandations personnalisées',
  'settings.error': "Impossible d'enregistrer. Veuillez réessayer.",
}

/** German card frame, fallback and settings copy. */
export const de: Record<ActionCardKey, string> = {
  expandBrief: 'Mehr anzeigen', collapseBrief: 'Weniger anzeigen',
  dismiss: 'Nicht jetzt', dismissed: 'Verworfen',
  unavailable: 'Diese Aktion ist nicht verfügbar. Prüfen Sie das Plugin unter Plugins.',
  transport: 'Das Ergebnis konnte nicht bestätigt werden. Verbinden Sie sich erneut und prüfen Sie die Karte, bevor Sie es erneut versuchen.',
  'settings.title': 'Personalisierte Empfehlungen',
  'settings.description': 'Zeigt für Ihre individuellen Anforderungen an DSH Empfehlungskarten unter der Antwort an',
  'settings.details': 'Wenn Sie eine Seite oder ein kleines Tool zur dauerhaften Nutzung möchten, wird eine neue personalisierte Seite vorgeschlagen, die nach einem Klick auf Erstellen im Hintergrund erstellt wird; wenn Sie fragen, wie etwas in dieser App geht, oder sagen, dass eine Funktion fehlt, wird das integrierte Plugin empfohlen, das sie bereitstellt, und nach einem Klick auf Aktivieren eingeschaltet.',
  'settings.detailsLabel': 'Über personalisierte Empfehlungen',
  'settings.error': 'Konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.',
}

/** Russian card frame, fallback and settings copy. */
export const ru: Record<ActionCardKey, string> = {
  expandBrief: 'Показать больше', collapseBrief: 'Показать меньше',
  dismiss: 'Не сейчас', dismissed: 'Отклонено',
  unavailable: 'Это действие недоступно. Проверьте плагин в разделе «Плагины».',
  transport: 'Не удалось подтвердить результат. Переподключитесь и проверьте карточку перед повторной попыткой.',
  'settings.title': 'Персональные рекомендации',
  'settings.description': 'Показывает карточки рекомендаций под ответом с учетом ваших индивидуальных потребностей в DSH',
  'settings.details': 'Когда вам нужна страница или небольшой инструмент для постоянного использования, предлагает новую персональную страницу, которая создается в фоне после нажатия «Создать»; когда вы спрашиваете, как что-то сделать в этом приложении, или говорите, что не хватает какой-то возможности, рекомендует встроенный плагин, который ее предоставляет, и включает его после нажатия «Включить».',
  'settings.detailsLabel': 'О персональных рекомендациях',
  'settings.error': 'Не удалось сохранить. Пожалуйста, попробуйте еще раз.',
}

/** Portuguese card frame, fallback and settings copy. */
export const pt: Record<ActionCardKey, string> = {
  expandBrief: 'Mostrar mais', collapseBrief: 'Mostrar menos',
  dismiss: 'Agora não', dismissed: 'Dispensado',
  unavailable: 'Esta ação não está disponível. Verifique o plug-in em Plug-ins.',
  transport: 'Não foi possível confirmar o resultado. Reconecte-se e verifique o cartão antes de tentar novamente.',
  'settings.title': 'Recomendações personalizadas',
  'settings.description': 'Mostra cartões de recomendação abaixo da resposta para suas necessidades personalizadas no DSH',
  'settings.details': 'Quando você quer uma página ou uma pequena ferramenta para manter, propõe uma nova página personalizada, gerada em segundo plano depois que você clica em Criar; quando você pergunta como fazer algo neste aplicativo ou diz que falta um recurso, recomenda o plug-in integrado que o oferece, ativado quando você clica em Ativar.',
  'settings.detailsLabel': 'Sobre as recomendações personalizadas',
  'settings.error': 'Não foi possível salvar. Por favor, tente novamente.',
}
