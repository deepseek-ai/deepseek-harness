/** The account copy of a custom MCP server, which names the server where a connector names its service. */
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import type { McpAccountCopy } from '@deepseek-ai/dsh-mcp-account'

type Templates = McpAccountCopy<string>

/** Each language's copy; `{name}` stands for the server name. */
const TEMPLATES = {
  zh: {
    title: '账号',
    connect: '连接',
    activation: { title: '连接 {name}', body: '连接账号后，就可以在对话中使用 {name} 的工具。' },
    detail: {
      disconnected: '连接账号后，可以在对话中使用 {name} 的工具。',
      waitingBrowser: '已打开 {name} 的授权页面。确认授权后，回到这里查看结果。',
      authorizing: '正在与 {name} 完成授权。',
      connecting: '正在连接 {name}。',
      connected: '可以在对话中请 Agent 使用 {name} 的工具。',
      rejected: '{name} 不再接受当前授权，请重新连接。',
      scope: '当前授权缺少 {name} 要求的权限。重新连接时，请确认所需权限。',
    },
    signOut: { title: '退出 {name} 登录？', body: '将删除 DSH 保存的 {name} 授权，之后对话中无法使用它的工具。' },
    notice: { connected: '{name} 已连接', signedOut: '已退出 {name} 登录' },
  },
  en: {
    title: 'Account',
    connect: 'Connect',
    activation: { title: 'Connect {name}', body: 'Connect an account to use the tools of {name} in conversations.' },
    detail: {
      disconnected: 'Connect an account to use the tools of {name} in conversations.',
      waitingBrowser: 'The authorization page of {name} is open. Confirm there, then come back here to see the result.',
      authorizing: 'Finishing authorization with {name}.',
      connecting: 'Connecting to {name}.',
      connected: 'Ask the agent to use the tools of {name} in a conversation.',
      rejected: '{name} no longer accepts the current authorization. Connect again.',
      scope: 'The current authorization lacks permissions {name} requires. Confirm them when you connect again.',
    },
    signOut: { title: 'Sign out of {name}?', body: 'This deletes the authorization of {name} that DSH saved, so conversations can no longer use its tools.' },
    notice: { connected: '{name} connected', signedOut: 'Signed out of {name}' },
  },
  ja: {
    title: 'アカウント',
    connect: '接続',
    activation: { title: '{name} を接続', body: 'アカウントを接続すると、会話の中で {name} のツールを使用できます。' },
    detail: {
      disconnected: 'アカウントを接続すると、会話の中で {name} のツールを使用できます。',
      waitingBrowser: '{name} の認可ページを開きました。そのページで確定したら、ここに戻って結果を確認してください。',
      authorizing: '{name} での認可を完了しています。',
      connecting: '{name} に接続しています。',
      connected: '会話の中でエージェントに {name} のツールの使用を依頼できます。',
      rejected: '{name} は現在の認可を受け付けなくなりました。再度接続してください。',
      scope: '現在の認可には、{name} が必要とする権限が不足しています。再度接続するときに、権限を確認してください。',
    },
    signOut: { title: '{name} からサインアウトしますか？', body: 'DSH が保存した {name} の認可を削除します。以後、会話の中でそのツールは使用できなくなります。' },
    notice: { connected: '{name} を接続しました', signedOut: '{name} からサインアウトしました' },
  },
  es: {
    title: 'Cuenta',
    connect: 'Conectar',
    activation: { title: 'Conectar {name}', body: 'Conecte una cuenta para usar las herramientas de {name} en las conversaciones.' },
    detail: {
      disconnected: 'Conecte una cuenta para usar las herramientas de {name} en las conversaciones.',
      waitingBrowser: 'La página de autorización de {name} está abierta. Confirme allí y luego vuelva aquí para ver el resultado.',
      authorizing: 'Completando la autorización con {name}.',
      connecting: 'Conectando con {name}.',
      connected: 'Pida al agente que use las herramientas de {name} en una conversación.',
      rejected: '{name} ya no acepta la autorización actual. Vuelva a conectar.',
      scope: 'A la autorización actual le faltan permisos que {name} requiere. Confírmelos cuando vuelva a conectar.',
    },
    signOut: {
      title: '¿Cerrar sesión en {name}?',
      body: 'Se eliminará la autorización de {name} que guardó DSH, por lo que las conversaciones ya no podrán usar las herramientas de ese servidor.',
    },
    notice: { connected: '{name} conectado', signedOut: 'Sesión de {name} cerrada' },
  },
  fr: {
    title: 'Compte',
    connect: 'Connecter',
    activation: { title: 'Connecter {name}', body: 'Connectez un compte pour utiliser les outils de {name} dans les conversations.' },
    detail: {
      disconnected: 'Connectez un compte pour utiliser les outils de {name} dans les conversations.',
      waitingBrowser: 'La page d’autorisation de {name} est ouverte. Confirmez sur cette page, puis revenez ici pour voir le résultat.',
      authorizing: 'Finalisation de l’autorisation avec {name}.',
      connecting: 'Connexion à {name} en cours.',
      connected: 'Demandez à l’agent d’utiliser les outils de {name} dans une conversation.',
      rejected: '{name} n’accepte plus l’autorisation actuelle. Reconnectez-vous.',
      scope: 'L’autorisation actuelle ne dispose pas des permissions requises par {name}. Confirmez-les lors de la reconnexion.',
    },
    signOut: {
      title: 'Se déconnecter de {name} ?',
      body: 'Cela supprime l’autorisation de {name} enregistrée par DSH : les conversations ne pourront plus utiliser ses outils.',
    },
    notice: { connected: '{name} connecté', signedOut: 'Déconnecté de {name}' },
  },
  de: {
    title: 'Konto',
    connect: 'Verbinden',
    activation: { title: '{name} verbinden', body: 'Verbinden Sie ein Konto, um die Werkzeuge von {name} in Unterhaltungen zu verwenden.' },
    detail: {
      disconnected: 'Verbinden Sie ein Konto, um die Werkzeuge von {name} in Unterhaltungen zu verwenden.',
      waitingBrowser: 'Die Autorisierungsseite von {name} ist geöffnet. Bestätigen Sie dort und kehren Sie dann hierher zurück, um das Ergebnis zu sehen.',
      authorizing: 'Die Autorisierung mit {name} wird abgeschlossen.',
      connecting: 'Verbindung mit {name} wird hergestellt.',
      connected: 'Bitten Sie den Agenten, die Werkzeuge von {name} in einer Unterhaltung zu verwenden.',
      rejected: '{name} akzeptiert die aktuelle Autorisierung nicht mehr. Verbinden Sie erneut.',
      scope: 'Der aktuellen Autorisierung fehlen Berechtigungen, die {name} erfordert. Bestätigen Sie diese, wenn Sie erneut verbinden.',
    },
    signOut: {
      title: 'Von {name} abmelden?',
      body: 'Dadurch wird die von DSH gespeicherte Autorisierung für {name} gelöscht, sodass Unterhaltungen die Werkzeuge dieses Servers nicht mehr verwenden können.',
    },
    notice: { connected: '{name} verbunden', signedOut: 'Von {name} abgemeldet' },
  },
  ru: {
    title: 'Аккаунт',
    connect: 'Подключить',
    activation: { title: 'Подключить {name}', body: 'Подключите аккаунт, чтобы использовать инструменты {name} в беседах.' },
    detail: {
      disconnected: 'Подключите аккаунт, чтобы использовать инструменты {name} в беседах.',
      waitingBrowser: 'Страница авторизации {name} открыта. Подтвердите там, затем вернитесь сюда, чтобы увидеть результат.',
      authorizing: 'Завершение авторизации в {name}.',
      connecting: 'Подключение к {name}.',
      connected: 'Попросите агента использовать инструменты {name} в беседе.',
      rejected: '{name} больше не принимает текущую авторизацию. Подключитесь снова.',
      scope: 'Текущей авторизации не хватает разрешений, которые требует {name}. Подтвердите их при повторном подключении.',
    },
    signOut: {
      title: 'Выйти из {name}?',
      body: 'Сохранённая DSH авторизация {name} будет удалена, и беседы больше не смогут использовать инструменты этого сервера.',
    },
    notice: { connected: '{name} подключён', signedOut: 'Выполнен выход из {name}' },
  },
  pt: {
    title: 'Conta',
    connect: 'Conectar',
    activation: { title: 'Conectar {name}', body: 'Conecte uma conta para usar as ferramentas de {name} nas conversas.' },
    detail: {
      disconnected: 'Conecte uma conta para usar as ferramentas de {name} nas conversas.',
      waitingBrowser: 'A página de autorização de {name} está aberta. Confirme lá e depois volte aqui para ver o resultado.',
      authorizing: 'Concluindo a autorização com {name}.',
      connecting: 'Conectando a {name}.',
      connected: 'Peça ao agente que use as ferramentas de {name} em uma conversa.',
      rejected: '{name} não aceita mais a autorização atual. Conecte novamente.',
      scope: 'A autorização atual não tem as permissões que {name} exige. Confirme-as ao conectar novamente.',
    },
    signOut: {
      title: 'Sair de {name}?',
      body: 'Isso exclui a autorização de {name} salva pelo DSH, e as conversas não poderão mais usar as ferramentas desse servidor.',
    },
    notice: { connected: '{name} conectado', signedOut: 'Você saiu de {name}' },
  },
} satisfies Record<'zh' | 'en' | 'ja' | 'es' | 'fr' | 'de' | 'ru' | 'pt', Templates>

/**
 * Build the copy of one configured server's account in every language this file carries.
 * @param name - the server name the copy shows.
 * @returns the account copy, which the Plugins page resolves to the active language.
 */
export function serverCopy(name: string): McpAccountCopy {
  const { en, ...others } = TEMPLATES
  const text = (pick: (copy: Templates) => string): LocalizedText => {
    const fill = (copy: Templates): string => pick(copy).replaceAll('{name}', name)
    return { en: fill(en), ...Object.fromEntries(Object.entries(others).map(([locale, copy]) => [locale, fill(copy)] as const)) }
  }
  return {
    title: text(copy => copy.title),
    connect: text(copy => copy.connect),
    activation: { title: text(copy => copy.activation.title), body: text(copy => copy.activation.body) },
    detail: {
      disconnected: text(copy => copy.detail.disconnected),
      waitingBrowser: text(copy => copy.detail.waitingBrowser),
      authorizing: text(copy => copy.detail.authorizing),
      connecting: text(copy => copy.detail.connecting),
      connected: text(copy => copy.detail.connected),
      rejected: text(copy => copy.detail.rejected),
      scope: text(copy => copy.detail.scope),
    },
    signOut: { title: text(copy => copy.signOut.title), body: text(copy => copy.signOut.body) },
    notice: { connected: text(copy => copy.notice.connected), signedOut: text(copy => copy.notice.signedOut) },
  }
}
