/** Copy for the More menu rows: navigation actions, and Creator draft prompts per region. */
export const en = {
  install: 'Browse other plugins',
  create: 'Create your plugin',
  'createPrompt.sidebar': 'Create a DSH plugin with a left sidebar entry.',
  'createPrompt.conversation': 'Create a DSH conversation view plugin.',
  'createPrompt.rightbar': 'Create a DSH plugin with a right sidebar entry.',
} as const

/** Chinese counterpart of the entry-customization dictionary. */
export const zh: Record<keyof typeof en, string> = {
  install: '浏览更多插件',
  create: '创建你的插件',
  'createPrompt.sidebar': '创建一个带左侧栏入口的 DSH 插件。',
  'createPrompt.conversation': '创建一个 DSH 会话视图插件。',
  'createPrompt.rightbar': '创建一个带右侧栏入口的 DSH 插件。',
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'install': '他のプラグインを探す',
  'create': 'プラグインを作成',
  'createPrompt.sidebar': '左サイドバーにエントリを持つ DSH プラグインを作成します。',
  'createPrompt.conversation': 'DSH 会話ビュープラグインを作成します。',
  'createPrompt.rightbar': '右サイドバーにエントリを持つ DSH プラグインを作成します。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'pin.sidebar': 'Fijar a la barra lateral izquierda',
  'unpin.sidebar': 'Desanclar de la barra lateral izquierda',
  'pin.conversation': 'Anclar a pestañas de conversación',
  'unpin.conversation': 'Desanclar de las pestañas de conversación',
  'pin.rightbar': 'Fijar a la barra lateral derecha',
  'unpin.rightbar': 'Desanclar de la barra lateral derecha',
  pinLabel: '{action}: {name}',
  install: 'Explorar otros complementos',
  create: 'Crea tu complemento',
  'createPrompt.sidebar': 'Cree un complemento DSH con una entrada en la barra lateral izquierda.',
  'createPrompt.conversation': 'Cree un complemento de vista de conversación DSH.',
  'createPrompt.rightbar': 'Cree un complemento DSH con una entrada en la barra lateral derecha.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'pin.sidebar': 'Épingler sur la barre latérale gauche',
  'unpin.sidebar': "Retirer l'épingle de la barre latérale gauche",
  'pin.conversation': 'Épingler aux onglets de conversation',
  'unpin.conversation': "Retirer l'épingle des onglets de conversation",
  'pin.rightbar': 'Épingler sur la barre latérale droite',
  'unpin.rightbar': "Retirer l'épingle de la barre latérale droite",
  pinLabel: '{action} : {name}',
  install: "Parcourir d'autres plugins",
  create: 'Créez votre plugin',
  'createPrompt.sidebar': 'Créez un plugin DSH avec une entrée dans la barre latérale gauche.',
  'createPrompt.conversation': "Créez un plugin d'affichage de conversation DSH.",
  'createPrompt.rightbar': 'Créez un plugin DSH avec une entrée dans la barre latérale droite.',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'pin.sidebar': 'An die linke Seitenleiste anpinnen',
  'unpin.sidebar': 'Von der linken Seitenleiste lösen',
  'pin.conversation': 'An Konversationsregisterkarten anpinnen',
  'unpin.conversation': 'Von Konversations-Tabs lösen',
  'pin.rightbar': 'An rechte Seitenleiste anheften',
  'unpin.rightbar': 'Von der rechten Seitenleiste lösen',
  pinLabel: '{action}: {name}',
  install: 'Durchsuchen Sie andere Plugins',
  create: 'Erstellen Sie Ihr Plugin',
  'createPrompt.sidebar': 'Erstellen Sie ein DSH-Plugin mit einem Eintrag in der linken Seitenleiste.',
  'createPrompt.conversation': 'Erstellen Sie ein DSH-Plugin für die Konversationsansicht.',
  'createPrompt.rightbar': 'Erstellen Sie ein DSH-Plugin mit einem Eintrag in der rechten Seitenleiste.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'pin.sidebar': 'Закрепить на левой боковой панели',
  'unpin.sidebar': 'Открепить от левой боковой панели',
  'pin.conversation': 'Закрепить на вкладках беседы',
  'unpin.conversation': 'Открепить от вкладок беседы',
  'pin.rightbar': 'Закрепить на правой боковой панели',
  'unpin.rightbar': 'Открепить от правой боковой панели',
  pinLabel: '{action}: {name}',
  install: 'Просмотрите другие плагины',
  create: 'Создайте свой плагин',
  'createPrompt.sidebar': 'Создайте плагин DSH с записью на левой боковой панели.',
  'createPrompt.conversation': 'Создайте плагин просмотра диалога DSH.',
  'createPrompt.rightbar': 'Создайте плагин DSH с записью на правой боковой панели.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'pin.sidebar': 'Fixar na barra lateral esquerda',
  'unpin.sidebar': 'Soltar da barra lateral esquerda',
  'pin.conversation': 'Fixar nas guias de conversa',
  'unpin.conversation': 'Liberar das guias de conversa',
  'pin.rightbar': 'Fixar na barra lateral direita',
  'unpin.rightbar': 'Soltar da barra lateral direita',
  pinLabel: '{action}: {name}',
  install: 'Procure outros plug-ins',
  create: 'Crie seu plug-in',
  'createPrompt.sidebar': 'Crie um plug-in DSH com uma entrada na barra lateral esquerda.',
  'createPrompt.conversation': 'Crie um plug-in de visualização de conversa DSH.',
  'createPrompt.rightbar': 'Crie um plug-in DSH com uma entrada na barra lateral direita.',
} satisfies Record<keyof typeof en, string>
