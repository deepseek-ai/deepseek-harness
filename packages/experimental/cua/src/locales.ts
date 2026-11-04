/** Locale-owned application-access approval messages. */

/** English application-access messages. */
export const en = {
  question: 'Allow agent to control this application via computer use?',
  detail: 'Manage app permissions for all sessions on the plugin page.',
  approve: 'Allow for this session',
}

/** Chinese application-access messages. */
export const zh = {
  question: '允许智能体通过 Computer Use 控制此应用吗？',
  detail: '在插件页面管理所有会话的应用权限。',
  approve: '本会话允许',
} satisfies Record<keyof typeof en, string>

/** Japanese application-access messages. */
export const ja = {
  question: 'エージェントが Computer Use でこのアプリを操作することを許可しますか？',
  detail: 'プラグインページで、すべてのセッションのアプリ権限を管理できます。',
  approve: 'このセッションで許可',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  question: '¿Permitir que el agente controle esta aplicación mediante Computer Use?',
  detail: 'Gestiona los permisos de las aplicaciones para todas las sesiones en la página del plugin.',
  approve: 'Permitir durante esta sesión',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  question: 'Autoriser l’agent à contrôler cette application via Computer Use ?',
  detail: 'Gérez les autorisations des applications pour toutes les sessions sur la page du plugin.',
  approve: 'Autoriser pour cette session',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  question: 'Darf der Agent diese Anwendung über Computer Use steuern?',
  detail: 'Verwalten Sie App-Berechtigungen für alle Sitzungen auf der Plugin-Seite.',
  approve: 'Für diese Sitzung zulassen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  question: 'Разрешить агенту управлять этим приложением через Computer Use?',
  detail: 'Управляйте разрешениями приложений для всех сеансов на странице плагина.',
  approve: 'Разрешить для этого сеанса',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  question: 'Permitir que o agente controle este aplicativo via Computer Use?',
  detail: 'Gerencie as permissões dos aplicativos para todas as sessões na página do plugin.',
  approve: 'Permitir nesta sessão',
} satisfies Record<keyof typeof en, string>

/** Display translations resolved by the Client; wire choices stay unchanged. */
export const applicationAccessDisplay = {
  question: {
    en: en.question,
    zh: zh.question,
    ja: ja.question,
    es: es.question,
    fr: fr.question,
    de: de.question,
    ru: ru.question,
    pt: pt.question,
  },
  detail: { en: en.detail, zh: zh.detail, ja: ja.detail, es: es.detail, fr: fr.detail, de: de.detail, ru: ru.detail, pt: pt.detail },
  approve: {
    en: en.approve,
    zh: zh.approve,
    ja: ja.approve,
    es: es.approve,
    fr: fr.approve,
    de: de.approve,
    ru: ru.approve,
    pt: pt.approve,
  },
}
