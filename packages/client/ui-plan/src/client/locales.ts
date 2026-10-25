/** `plan` namespace dictionaries (the composer plan chip's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.label': '计划',
  'preview.title': '计划',
  'preview.document': '计划 · Markdown',
  'preview.action': '打开',
  'preview.open': '在侧边栏打开计划',
  'preview.full': '查看全文',
  'preview.openNamed': '打开计划：{title}',
  'preview.loading': '正在读取计划…',
  'preview.failed': '无法读取计划',
  'preview.invalidAddress': '计划地址无效',
  'preview.historyUnavailable': '无法读取会话历史',
  'preview.notFound': '未找到这份计划',
  'preview.unavailable': '计划预览不可用',
  'preview.expired': '临时计划预览已失效，请从仍在等待审批的卡片重新打开。',
  'chip.on.aria': '计划模式已开启，按下关闭',
  'chip.on.title': '计划模式已开启 — 点击关闭（/plan off）',
  'chip.exitFailed': '退出计划模式失败',
} satisfies Record<string, string>

/** The plan namespace key union. */
export type PlanKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'chip.label': 'Plan',
  'preview.title': 'Plan',
  'preview.document': 'Plan · Markdown',
  'preview.action': 'Open',
  'preview.open': 'Open plan in sidebar',
  'preview.full': 'View full plan',
  'preview.openNamed': 'Open plan: {title}',
  'preview.loading': 'Loading plan…',
  'preview.failed': 'Could not load plan',
  'preview.invalidAddress': 'Invalid plan address',
  'preview.historyUnavailable': 'Session history is unavailable',
  'preview.notFound': 'This plan was not found',
  'preview.unavailable': 'Plan preview is unavailable',
  'preview.expired': 'This temporary plan preview has expired. Reopen it from the pending review card.',
  'chip.on.aria': 'Plan mode on, press to turn off',
  'chip.on.title': 'Plan mode on — click to turn off (/plan off)',
  'chip.exitFailed': 'Failed to exit plan mode',
} satisfies Record<PlanKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'chip.label': '計画',
  'preview.title': '計画',
  'preview.document': '計画 · Markdown',
  'preview.action': '開く',
  'preview.open': 'サイドバーで計画を開く',
  'preview.full': '計画全体を表示',
  'preview.openNamed': '計画を開く: {title}',
  'preview.loading': '計画を読み込み中…',
  'preview.failed': '計画を読み込めませんでした',
  'preview.invalidAddress': '計画のアドレスが無効です',
  'preview.historyUnavailable': 'セッション履歴を利用できません',
  'preview.notFound': 'この計画は見つかりませんでした',
  'preview.unavailable': '計画のプレビューを利用できません',
  'preview.expired': 'この一時的な計画プレビューは期限切れです。保留中のレビューカードから再度開いてください。',
  'chip.on.aria': '計画モードはオンです。押すとオフになります',
  'chip.on.title': '計画モードはオンです — クリックでオフ (/plan off)',
  'chip.exitFailed': '計画モードを終了できませんでした',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'chip.label': 'Planificar',
  'preview.title': 'Planificar',
  'preview.document': 'Plano · Markdown',
  'preview.action': 'Abrir',
  'preview.open': 'Plan abierto en la barra lateral',
  'preview.full': 'Ver plano completo',
  'preview.openNamed': 'Plan abierto: {title}',
  'preview.loading': 'Cargando plan…',
  'preview.failed': 'No se pudo cargar el plan',
  'preview.invalidAddress': 'Dirección del plan no válida',
  'preview.historyUnavailable': 'El historial de sesiones no está disponible',
  'preview.notFound': 'Este plan no fue encontrado.',
  'preview.unavailable': 'La vista previa del plan no está disponible',
  'preview.expired': 'Esta vista previa del plan temporal ha caducado. Vuelva a abrirlo desde la tarjeta de revisión pendiente.',
  'chip.on.aria': 'Modo plan activado, presione para apagar',
  'chip.on.title': 'Modo de planificación activado: haga clic para desactivar (/plan off)',
  'chip.exitFailed': 'No se pudo salir del modo de plan',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'chip.label': 'Planifier',
  'preview.title': 'Planifier',
  'preview.document': 'Plan · Markdown',
  'preview.action': 'Ouvrir',
  'preview.open': 'Plan ouvert dans la barre latérale',
  'preview.full': 'Voir le forfait complet',
  'preview.openNamed': 'Plan ouvert : {title}',
  'preview.loading': 'Plan de chargement…',
  'preview.failed': 'Impossible de charger le plan',
  'preview.invalidAddress': 'Adresse du forfait invalide',
  'preview.historyUnavailable': "L'historique des sessions n'est pas disponible",
  'preview.notFound': "Ce plan n'a pas été trouvé",
  'preview.unavailable': "L'aperçu du plan n'est pas disponible",
  'preview.expired': 'Cet aperçu du plan temporaire a expiré. Rouvrez-le à partir de la carte de révision en attente.',
  'chip.on.aria': 'Mode Plan activé, appuyez pour désactiver',
  'chip.on.title': 'Mode Plan activé — cliquez pour désactiver (/plan off)',
  'chip.exitFailed': 'Échec de la sortie du mode Plan',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'chip.label': 'Planen',
  'preview.title': 'Planen',
  'preview.document': 'Plan · Markdown',
  'preview.action': 'Öffnen',
  'preview.open': 'Plan in der Seitenleiste öffnen',
  'preview.full': 'Vollständigen Plan anzeigen',
  'preview.openNamed': 'Offener Grundriss: {title}',
  'preview.loading': 'Ladeplan…',
  'preview.failed': 'Plan konnte nicht geladen werden',
  'preview.invalidAddress': 'Ungültige Planadresse',
  'preview.historyUnavailable': 'Der Sitzungsverlauf ist nicht verfügbar',
  'preview.notFound': 'Dieser Plan wurde nicht gefunden',
  'preview.unavailable': 'Die Planvorschau ist nicht verfügbar',
  'preview.expired': 'Diese temporäre Planvorschau ist abgelaufen. Öffnen Sie es erneut über die ausstehende Überprüfungskarte.',
  'chip.on.aria': 'Planmodus ein, zum Ausschalten drücken',
  'chip.on.title': 'Planmodus ein – zum Ausschalten klicken (/plan off)',
  'chip.exitFailed': 'Der Planmodus konnte nicht beendet werden',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'chip.label': 'План',
  'preview.title': 'План',
  'preview.document': 'План · Markdown',
  'preview.action': 'Открыть',
  'preview.open': 'Открытая планировка в боковой панели',
  'preview.full': 'Посмотреть полный план',
  'preview.openNamed': 'Открытая планировка: {title}',
  'preview.loading': 'План загрузки…',
  'preview.failed': 'Не удалось загрузить план',
  'preview.invalidAddress': 'Неверный адрес плана',
  'preview.historyUnavailable': 'История сеансов недоступна',
  'preview.notFound': 'Этот план не найден',
  'preview.unavailable': 'Предварительный просмотр плана недоступен.',
  'preview.expired': 'Срок действия этой временной предварительной версии плана истек. Откройте его снова из карточки ожидающего рассмотрения.',
  'chip.on.aria': 'Режим планирования включен. Нажмите, чтобы выключить.',
  'chip.on.title': 'Режим планирования включен — нажмите, чтобы выключить (/plan off)',
  'chip.exitFailed': 'Не удалось выйти из режима планирования.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'chip.label': 'Plano',
  'preview.title': 'Plano',
  'preview.document': 'Plano · Markdown',
  'preview.action': 'Abrir',
  'preview.open': 'Abrir plano na barra lateral',
  'preview.full': 'Ver plano completo',
  'preview.openNamed': 'Plano aberto: {title}',
  'preview.loading': 'Carregando plano…',
  'preview.failed': 'Não foi possível carregar o plano',
  'preview.invalidAddress': 'Endereço do plano inválido',
  'preview.historyUnavailable': 'O histórico da sessão não está disponível',
  'preview.notFound': 'Este plano não foi encontrado',
  'preview.unavailable': 'A visualização do plano não está disponível',
  'preview.expired': 'Esta visualização temporária do plano expirou. Reabra-o no cartão de revisão pendente.',
  'chip.on.aria': 'Modo de planejamento ativado, pressione para desligar',
  'chip.on.title': 'Modo de planejamento ativado – clique para desligar (/plan off)',
  'chip.exitFailed': 'Falha ao sair do modo de plano',
} satisfies Record<keyof typeof en, string>
