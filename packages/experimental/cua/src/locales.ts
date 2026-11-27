/** Locale-owned application-access approval messages. */

/** English application-access messages. */
export const en = {
  question: 'Allow agent to control this application via computer use?',
  detail: 'Once allowed, the agent can view and operate this app. You can manage app permissions anytime in plugin settings.',
  sessionDetail: 'Once allowed, the agent can view and operate this app for this session.',
  approve: 'Allow for this session',
}

/** Chinese application-access messages. */
export const zh = {
  question: '允许智能体自动操作此应用吗？',
  detail: '允许后，智能体将能够查看并操作此应用。你可随时在插件设置中管理应用权限。',
  sessionDetail: '允许后，智能体将能在本会话内查看并操作此应用。',
  approve: '本会话允许',
} satisfies Record<keyof typeof en, string>

/** Japanese application-access messages. */
export const ja = {
  question: 'エージェントが Computer Use でこのアプリを操作することを許可しますか？',
  detail: '許可すると、エージェントはこのアプリの内容を確認して操作できます。アプリの権限はプラグイン設定からいつでも管理できます。',
  sessionDetail: '許可すると、エージェントはこのセッション中にこのアプリの内容を確認して操作できます。',
  approve: 'このセッションで許可',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  question: '¿Permitir que el agente controle esta aplicación mediante Computer Use?',
  detail: 'Si lo permites, el agente podrá ver y controlar esta aplicación. Puedes gestionar los permisos de las aplicaciones en cualquier momento en la configuración del complemento.',
  sessionDetail: 'Si lo permites, el agente podrá ver y controlar esta aplicación durante esta sesión.',
  approve: 'Permitir durante esta sesión',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  question: 'Autoriser l’agent à contrôler cette application via Computer Use ?',
  detail: 'Une fois autorisé, l’agent peut consulter et utiliser cette application. Vous pouvez gérer les autorisations des applications à tout moment dans les paramètres du plugin.',
  sessionDetail: 'Une fois autorisé, l’agent peut consulter et utiliser cette application pendant cette session.',
  approve: 'Autoriser pour cette session',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  question: 'Darf der Agent diese Anwendung über Computer Use steuern?',
  detail: 'Nach der Freigabe kann der Agent diese App einsehen und bedienen. Sie können App-Berechtigungen jederzeit in den Plugin-Einstellungen verwalten.',
  sessionDetail: 'Nach der Freigabe kann der Agent diese App für diese Sitzung einsehen und bedienen.',
  approve: 'Für diese Sitzung zulassen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  question: 'Разрешить агенту управлять этим приложением через Computer Use?',
  detail: 'После разрешения агент сможет просматривать это приложение и управлять им. Управлять разрешениями приложений можно в любое время в настройках плагина.',
  sessionDetail: 'После разрешения агент сможет просматривать это приложение и управлять им в этом сеансе.',
  approve: 'Разрешить для этого сеанса',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  question: 'Permitir que o agente controle este aplicativo via Computer Use?',
  detail: 'Depois de permitido, o agente poderá visualizar e operar este aplicativo. Você pode gerenciar as permissões de aplicativos a qualquer momento nas configurações do plugin.',
  sessionDetail: 'Depois de permitido, o agente poderá visualizar e operar este aplicativo nesta sessão.',
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
/** Session-only application-access display translations when persistent grants are unavailable. */
export const sessionApplicationAccessDisplay = {
  ...applicationAccessDisplay,
  detail: {
    en: en.sessionDetail, zh: zh.sessionDetail, ja: ja.sessionDetail, es: es.sessionDetail,
    fr: fr.sessionDetail, de: de.sessionDetail, ru: ru.sessionDetail, pt: pt.sessionDetail,
  },
}

/** Window consent never grants access to sibling windows or application launch. */
export const windowAccessQuestion = {
  en: 'Allow computer use to read, capture and control this window?',
  zh: '允许智能体读取、截图并操作此窗口吗？',
  ja: 'このウィンドウの読み取り、撮影、操作を許可しますか？',
  es: '¿Permitir leer, capturar y controlar esta ventana?',
  fr: 'Autoriser la lecture, la capture et le contrôle de cette fenêtre ?',
  de: 'Lesen, Aufnehmen und Steuern dieses Fensters erlauben?',
  ru: 'Разрешить чтение, снимки и управление этим окном?',
  pt: 'Permitir ler, capturar e controlar esta janela?',
}
/** Launch consent does not grant access to resulting windows. */
export const launchAccessQuestion = {
  en: 'Allow computer use to launch this entry? Window access is requested separately.',
  zh: '允许启动此项吗？窗口访问将单独请求授权。',
  ja: 'この項目の起動を許可しますか？ウィンドウへのアクセスは別途確認します。',
  es: '¿Permitir iniciar esta entrada? El acceso a ventanas se solicita por separado.',
  fr: 'Autoriser le lancement de cette entrée ? L’accès aux fenêtres sera demandé séparément.',
  de: 'Diesen Eintrag starten? Fensterzugriff wird separat angefragt.',
  ru: 'Разрешить запуск? Доступ к окнам запрашивается отдельно.',
  pt: 'Permitir iniciar esta entrada? O acesso às janelas é solicitado separadamente.',
}
