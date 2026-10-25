/** Locale-owned application-access approval messages. */

/** English application-access messages. */
export const en = {
  question: 'Allow computer use to launch, read, capture and control this application?',
  detail: 'Session access lasts until DSH restarts or computer use is disabled.',
  approve: 'Allow for this session',
}

/** Chinese application-access messages. */
export const zh = {
  question: '允许 Computer Use 启动、读取、截图和控制此应用吗？',
  detail: '会话授权在 DSH 重启或关闭 Computer Use 后失效。',
  approve: '本会话允许',
} satisfies Record<keyof typeof en, string>

/** Japanese application-access messages. */
export const ja = {
  question: 'Computer Use によるこのアプリの起動、読み取り、画面キャプチャ、操作を許可しますか？',
  detail: 'セッションの許可は DSH の再起動または Computer Use の無効化まで有効です。',
  approve: 'このセッションで許可',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  question: '¿Permitir que Computer Use inicie, lea, capture y controle esta aplicación?',
  detail: 'El acceso de esta sesión dura hasta que se reinicie DSH o se desactive Computer Use.',
  approve: 'Permitir durante esta sesión',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  question: 'Autoriser Computer Use à lancer, lire, capturer et contrôler cette application ?',
  detail: 'L’autorisation de cette session reste valable jusqu’au redémarrage de DSH ou à la désactivation de Computer Use.',
  approve: 'Autoriser pour cette session',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  question: 'Darf Computer Use diese Anwendung starten, lesen, aufnehmen und steuern?',
  detail: 'Der Zugriff für diese Sitzung gilt, bis DSH neu gestartet oder Computer Use deaktiviert wird.',
  approve: 'Für diese Sitzung zulassen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  question: 'Разрешить Computer Use запуск, чтение, захват и управление этим приложением?',
  detail: 'Доступ для этого сеанса действует до перезапуска DSH или отключения Computer Use.',
  approve: 'Разрешить для этого сеанса',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  question: 'Permitir que o Computer Use inicie, leia, capture e controle este aplicativo?',
  detail: 'O acesso desta sessão dura até que o DSH seja reiniciado ou o Computer Use seja desativado.',
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
