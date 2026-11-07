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
    en: 'Hovering will move your pointer and leave it at the target, even while you are using the mouse. This permission applies only to this session until DSH restarts. If you decline, this session will not ask again before restart.',
    zh: '智能体悬停时会移动你的鼠标指针，并将它留在目标位置，即使你正在使用鼠标。授权仅限当前会话，重启 DSH 后失效。如果拒绝，重启前本会话不会再次询问。',
    ja: 'ホバーすると、マウスを使用中でもポインタが移動し、移動先に残ります。許可はこのセッションに限り、DSH を再起動すると失効します。拒否すると、再起動までこのセッションでは再度確認しません。',
    es: 'Al pasar sobre un elemento, el puntero se moverá y quedará allí aunque estés usando el ratón. El permiso solo se aplica a esta sesión y caduca al reiniciar DSH. Si lo deniegas, esta sesión no volverá a preguntar hasta que reinicies DSH.',
    fr: 'Lors d’un survol, le pointeur se déplace et reste sur la cible, même si vous utilisez la souris. Cette autorisation vaut pour cette session et expire au redémarrage de DSH. Si vous refusez, cette session ne redemandera pas avant le redémarrage.',
    de: 'Beim Überfahren eines Ziels bewegt sich der Zeiger und bleibt dort, auch wenn Sie die Maus verwenden. Die Erlaubnis gilt nur für diese Sitzung und erlischt beim Neustart von DSH. Wenn Sie ablehnen, fragt diese Sitzung bis zum Neustart nicht erneut.',
    ru: 'При наведении указатель переместится и останется на цели, даже если вы пользуетесь мышью. Разрешение действует только в этом сеансе до перезапуска DSH. Если вы откажете, запрос в этом сеансе не повторится до перезапуска.',
    pt: 'Ao passar sobre um elemento, o ponteiro se moverá e ficará no destino, mesmo enquanto você usa o mouse. A permissão vale apenas para esta sessão e expira ao reiniciar o DSH. Se você recusar, esta sessão não perguntará novamente até a reinicialização.',
  },
  approve: applicationAccessDisplay.approve,
}
