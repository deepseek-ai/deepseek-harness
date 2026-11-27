/** Localized `/side` command, tab text and operation feedback. */
export const NS = 'sidechat'

/** Chinese side conversation copy. */
export const zh = {
  'command': '侧栏对话',
  'command.description': '从当前位置分支，在右侧栏继续',
  'title': '侧栏对话',
  'loading': '正在打开对话…',
  'openFailed': '无法打开对话',
  'createFailed': '无法创建侧栏对话，请稍后再试',
  'noTurn': '当前会话没有已结束的轮次',
  'subagentSource': '子智能体会话不能创建侧栏对话',
}

/** English side conversation copy. */
export const en: Record<keyof typeof zh, string> = {
  'command': 'Side conversation',
  'command.description': 'Branch from the current point and continue in the right sidebar',
  'title': 'Side conversation',
  'loading': 'Opening conversation…',
  'openFailed': 'Could not open conversation',
  'createFailed': 'Could not create the side conversation. Try again later.',
  'noTurn': 'This session has no completed turn',
  'subagentSource': 'A subagent conversation cannot start a side conversation.',
}

/** Japanese side conversation copy. */
export const ja: Record<keyof typeof zh, string> = {
  'command': 'サイド会話',
  'command.description': '現在の位置から分岐し、右サイドバーで続ける',
  'title': 'サイド会話',
  'loading': '会話を開いています…',
  'openFailed': '会話を開けませんでした',
  'createFailed': 'サイド会話を作成できませんでした。後でもう一度お試しください。',
  'noTurn': 'このセッションには完了したターンがありません',
  'subagentSource': 'サブエージェントの会話からはサイド会話を作成できません。',
}

/** Spanish side conversation copy. */
export const es: Record<keyof typeof zh, string> = {
  'command': 'Conversación lateral',
  'command.description': 'Crear una rama desde el punto actual y continuar en la barra lateral derecha',
  'title': 'Conversación lateral',
  'loading': 'Abriendo la conversación…',
  'openFailed': 'No se pudo abrir la conversación',
  'createFailed': 'No se pudo crear la conversación lateral. Inténtalo de nuevo más tarde.',
  'noTurn': 'Esta sesión no tiene turno completo',
  'subagentSource': 'Una conversación de subagente no puede iniciar una conversación lateral.',
}

/** French side conversation copy. */
export const fr: Record<keyof typeof zh, string> = {
  'command': 'Conversation latérale',
  'command.description': 'Créer une branche depuis le point actuel et continuer dans la barre latérale droite',
  'title': 'Conversation latérale',
  'loading': 'Ouverture de la conversation…',
  'openFailed': 'Impossible d’ouvrir la conversation',
  'createFailed': 'Impossible de créer la conversation latérale. Réessayez plus tard.',
  'noTurn': "Cette session n'a pas de tour terminé",
  'subagentSource': 'Une conversation de sous-agent ne peut pas démarrer une conversation latérale.',
}

/** German side conversation copy. */
export const de: Record<keyof typeof zh, string> = {
  'command': 'Seitengespräch',
  'command.description': 'Vom aktuellen Punkt verzweigen und in der rechten Seitenleiste fortsetzen',
  'title': 'Seitengespräch',
  'loading': 'Gespräch wird geöffnet…',
  'openFailed': 'Gespräch konnte nicht geöffnet werden',
  'createFailed': 'Das Seitengespräch konnte nicht erstellt werden. Versuche es später erneut.',
  'noTurn': 'Diese Sitzung hat keine abgeschlossene Runde',
  'subagentSource': 'Ein Subagent-Gespräch kann kein Seitengespräch starten.',
}

/** Russian side conversation copy. */
export const ru: Record<keyof typeof zh, string> = {
  'command': 'Боковой разговор',
  'command.description': 'Создать ветку от текущей точки и продолжить в правой боковой панели',
  'title': 'Боковой разговор',
  'loading': 'Открытие разговора…',
  'openFailed': 'Не удалось открыть разговор',
  'createFailed': 'Не удалось создать боковой разговор. Повторите попытку позже.',
  'noTurn': 'В этой сессии нет завершенных ходов',
  'subagentSource': 'Разговор субагента не может начать боковой разговор.',
}

/** Portuguese side conversation copy. */
export const pt: Record<keyof typeof zh, string> = {
  'command': 'Conversa lateral',
  'command.description': 'Criar uma ramificação a partir do ponto atual e continuar na barra lateral direita',
  'title': 'Conversa lateral',
  'loading': 'Abrindo a conversa…',
  'openFailed': 'Não foi possível abrir a conversa',
  'createFailed': 'Não foi possível criar a conversa lateral. Tente novamente mais tarde.',
  'noTurn': 'Esta sessão não tem turno concluído',
  'subagentSource': 'Uma conversa de subagente não pode iniciar uma conversa lateral.',
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface LocaleNamespaceMap {
    [NS]: keyof typeof zh
  }
}
