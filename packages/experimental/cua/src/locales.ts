/** Locale-owned application-access approval messages. */

/** English application-access messages. */
export const en = {
  question: 'Allow computer use to launch, read, capture and control this application?',
  detail: 'Allowing or denying applies to every version and copy sharing the same application identity. Session access and denial apply only to this conversation.',
  approve: 'Allow for this session',
}

/** Chinese application-access messages. */
export const zh = {
  question: '允许 Computer Use 启动、读取、截图和控制此应用吗？',
  detail: '允许或拒绝会应用于同一应用标识的所有版本和副本。会话许可和拒绝仅在当前对话中生效。',
  approve: '本会话允许',
} satisfies Record<keyof typeof en, string>

/** Japanese application-access messages. */
export const ja = {
  question: 'Computer Use によるこのアプリの起動、読み取り、画面キャプチャ、操作を許可しますか？',
  detail: '許可または拒否は、同じアプリ識別子を持つすべてのバージョンとコピーに適用されます。セッションの許可と拒否はこの会話にのみ適用されます。',
  approve: 'このセッションで許可',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  question: '¿Permitir que Computer Use inicie, lea, capture y controle esta aplicación?',
  detail: 'Permitir o denegar se aplica a todas las versiones y copias que comparten la misma identidad de aplicación. El acceso de sesión y la denegación solo se aplican a esta conversación.',
  approve: 'Permitir durante esta sesión',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  question: 'Autoriser Computer Use à lancer, lire, capturer et contrôler cette application ?',
  detail: 'L’autorisation ou le refus s’applique à toutes les versions et copies partageant la même identité d’application. L’autorisation de session et le refus s’appliquent uniquement à cette conversation.',
  approve: 'Autoriser pour cette session',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  question: 'Darf Computer Use diese Anwendung starten, lesen, aufnehmen und steuern?',
  detail: 'Erlauben oder Ablehnen gilt für alle Versionen und Kopien mit derselben Anwendungsidentität. Sitzungszugriff und Ablehnung gelten nur für diese Unterhaltung.',
  approve: 'Für diese Sitzung zulassen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  question: 'Разрешить Computer Use запуск, чтение, захват и управление этим приложением?',
  detail: 'Разрешение или отказ распространяется на все версии и копии с тем же идентификатором приложения. Доступ для сеанса и отказ действуют только в этом разговоре.',
  approve: 'Разрешить для этого сеанса',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  question: 'Permitir que o Computer Use inicie, leia, capture e controle este aplicativo?',
  detail: 'Permitir ou negar se aplica a todas as versões e cópias com a mesma identidade de aplicativo. O acesso da sessão e a recusa se aplicam apenas a esta conversa.',
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
