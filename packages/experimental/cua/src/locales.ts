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

/** Window consent never grants access to sibling windows or application launch. */
export const windowAccessQuestion = {
  en: 'Allow computer use to read, capture and control this window?',
  zh: '允许电脑操作读取、截图并控制这个窗口吗？',
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
  zh: '允许电脑操作启动这个入口吗？窗口访问将单独请求授权。',
  ja: 'この項目の起動を許可しますか？ウィンドウへのアクセスは別途確認します。',
  es: '¿Permitir iniciar esta entrada? El acceso a ventanas se solicita por separado.',
  fr: 'Autoriser le lancement de cette entrée ? L’accès aux fenêtres sera demandé séparément.',
  de: 'Diesen Eintrag starten? Fensterzugriff wird separat angefragt.',
  ru: 'Разрешить запуск? Доступ к окнам запрашивается отдельно.',
  pt: 'Permitir iniciar esta entrada? O acesso às janelas é solicitado separadamente.',
}

/** Scope and interruption shown before the user grants mouse control. */
export const mouseControlDisplay = {
  question: {
    en: 'Allow the agent to move your mouse pointer?',
    zh: '允许智能体移动你的鼠标指针吗？',
    ja: 'エージェントがマウスポインタを動かすことを許可しますか？',
    es: '¿Permitir que el agente mueva el puntero del ratón?',
    fr: 'Autoriser l’agent à déplacer le pointeur de la souris ?',
    de: 'Darf der Agent den Mauszeiger bewegen?',
    ru: 'Разрешить агенту перемещать указатель мыши?',
    pt: 'Permitir que o agente mova o ponteiro do mouse?',
  },
  detail: {
    en: 'Allowing moves your pointer to this target now. Later hovers can also move it. If you decline, this session will not ask again. The decision expires when you close the session or restart DSH.',
    zh: '允许后，你的鼠标指针会立即移到目标位置，本会话后续悬停也会移动指针。如果拒绝，本会话不会再询问。关闭会话或重启 DSH 后，这个决定失效。',
    ja: '許可するとポインタが今すぐ移動し、以後のホバーでも移動します。拒否すると、このセッションでは再度確認しません。セッションを閉じるか DSH を再起動すると、この選択は失効します。',
    es: 'Si aceptas, el puntero se moverá ahora al destino y también podrá moverse al pasar sobre otros elementos. Si rechazas, no se volverá a preguntar. La decisión caduca al cerrar la sesión o reiniciar DSH.',
    fr: 'Si vous acceptez, le pointeur se déplace immédiatement sur la cible, puis lors des survols suivants. Si vous refusez, la question ne sera plus posée. Ce choix expire à la fermeture de la session ou au redémarrage de DSH.',
    de: 'Bei Zustimmung bewegt sich der Zeiger sofort zum Ziel und auch bei späteren Mausbewegungen. Bei Ablehnung wird nicht erneut gefragt. Die Entscheidung gilt, bis Sie die Sitzung schließen oder DSH neu starten.',
    ru: 'При разрешении указатель сразу переместится на цель и сможет перемещаться при следующих наведениях. При отказе вопрос не повторится. Решение действует до закрытия сеанса или перезапуска DSH.',
    pt: 'Se permitir, o ponteiro irá para o alvo agora e poderá se mover nas próximas ações. Se recusar, a pergunta não será repetida. A decisão expira ao encerrar a sessão ou reiniciar o DSH.',
  },
  approve: applicationAccessDisplay.approve,
}
