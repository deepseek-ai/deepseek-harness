/** `plan` namespace dictionaries: the composer plan chip, plan cards and their unavailable state, and plan source failures. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.label': '计划',
  'preview.title': '计划',
  'preview.document': '计划 · Markdown',
  'preview.action': '打开',
  'preview.open': '在侧边栏打开计划',
  'preview.full': '查看全文',
  'preview.openNamed': '打开计划：{title}',
  'preview.unavailable': '侧边栏预览不可用：未加载“文档预览面板”插件',
  'preview.invalidAddress': '计划地址无效',
  'preview.notFound': '未找到这份计划',
  'preview.readFailed': '无法读取计划',
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
  'preview.unavailable': 'Sidebar preview unavailable: the “ui-sidebar-documentpreview” plugin is not loaded',
  'preview.invalidAddress': 'Invalid plan address',
  'preview.notFound': 'This plan was not found',
  'preview.readFailed': 'Could not load plan',
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
  'preview.unavailable': 'サイドバーのプレビューは利用できません：「文書プレビューパネル」プラグインが読み込まれていません',
  'preview.invalidAddress': '計画のアドレスが無効です',
  'preview.notFound': 'この計画は見つかりませんでした',
  'preview.readFailed': '計画を読み込めませんでした',
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
  'preview.unavailable': 'La vista previa en la barra lateral no está disponible: el complemento «Panel de vista previa del documento» no está cargado',
  'preview.invalidAddress': 'Dirección del plan no válida',
  'preview.notFound': 'No se encontró este plan',
  'preview.readFailed': 'No se pudo cargar el plan',
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
  'preview.unavailable': 'Aperçu dans la barre latérale indisponible : le plugin « Panneau d’aperçu du document » n’est pas chargé',
  'preview.invalidAddress': 'Adresse du plan invalide',
  'preview.notFound': 'Ce plan est introuvable',
  'preview.readFailed': 'Impossible de charger le plan',
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
  'preview.unavailable': 'Seitenleistenvorschau nicht verfügbar: Das Plugin „Dokumentvorschaufenster“ ist nicht geladen',
  'preview.invalidAddress': 'Ungültige Planadresse',
  'preview.notFound': 'Dieser Plan wurde nicht gefunden',
  'preview.readFailed': 'Plan konnte nicht geladen werden',
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
  'preview.unavailable': 'Предпросмотр в боковой панели недоступен: плагин «Панель предварительного просмотра документа» не загружен',
  'preview.invalidAddress': 'Неверный адрес плана',
  'preview.notFound': 'Этот план не найден',
  'preview.readFailed': 'Не удалось загрузить план',
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
  'preview.unavailable': 'Pré-visualização na barra lateral indisponível: o plugin “Painel de visualização do documento” não está carregado',
  'preview.invalidAddress': 'Endereço do plano inválido',
  'preview.notFound': 'Este plano não foi encontrado',
  'preview.readFailed': 'Não foi possível carregar o plano',
  'chip.on.aria': 'Modo de planejamento ativado, pressione para desligar',
  'chip.on.title': 'Modo de planejamento ativado – clique para desligar (/plan off)',
  'chip.exitFailed': 'Falha ao sair do modo de plano',
} satisfies Record<keyof typeof en, string>
