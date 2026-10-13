/** Locale-owned copy for the Feishu plugin's connection on the Plugins page. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace for every Feishu connection surface. */
export const NS = 'feishu'

/** Chinese dictionary and key source. */
export const zh = {
  'section.title': '飞书账号',
  'status.checking': '正在检查连接',
  'status.disconnected': '未连接',
  'status.unavailable': '暂时无法确认登录状态',
  'status.connected': '已连接',
  'status.stopped': '飞书组件未运行',
  'step.configuring': '第 1 步：关联飞书应用',
  'step.authorizing': '第 2 步：登录飞书账号',
  'step.connecting': '正在连接',
  'step.signing-out': '正在退出登录',
  'detail.no-app': '先关联一个飞书应用（可以新建，也可以选择已有应用），再登录飞书账号。连接后，可以在对话中使用飞书文档、消息及其他你授权的功能。',
  'detail.signed-out': '已关联飞书应用。登录飞书账号后，就可以在对话中使用飞书。',
  'detail.unavailable': '已保留现有配置和登录，可以稍后重试。',
  'detail.stopped': '“飞书 CLI 与技能”组件没有运行，可以在下方组件列表查看原因，处理后重试。',
  'detail.connected': '可以在对话中直接请 Agent 使用飞书。',
  'detail.connectedAs': '已登录为 {name}。可以在对话中直接请 Agent 使用飞书。',
  'detail.configuring': '在打开的飞书页面中新建或选择应用，完成后回到这里登录。页面没有打开时，点击“打开飞书页面”。',
  'detail.authorizing': '在打开的飞书页面中确认授权，完成后回到这里查看结果。页面没有打开时，点击“打开飞书页面”。',
  hint: '飞书账号与这台电脑终端里的飞书 CLI 共用。',
  failed: '操作未完成，请重试',
  'action.connect': '连接飞书',
  'action.linkApp': '关联飞书应用',
  'action.signIn': '登录飞书账号',
  'action.open': '打开飞书页面',
  'action.cancel': '取消',
  'action.signOut': '退出登录',
  'action.retry': '重试',
  'badge.connected': '已连接',
  'badge.disconnected': '未连接',
  'badge.connecting': '连接中',
  'badge.unavailable': '待确认',
  'badge.stopped': '未运行',
  'signOut.title': '退出飞书登录？',
  'signOut.body': '将退出飞书 CLI 的默认账号，这台电脑终端里的 lark-cli 也会一起退出。已关联的飞书应用会保留。',
  'activation.title': '连接飞书账号',
  'activation.body': '飞书插件已开启。连接你的飞书账号后，就可以在对话中使用它。',
  'activation.later': '稍后',
  'notice.app-linked': '飞书应用已关联，下一步登录飞书账号',
  'notice.connected': '飞书已连接',
  'notice.signed-out': '已退出飞书登录',
  'notice.action-failed': '操作未完成，请重试',
  close: '关闭',
}

/** Every key the Feishu connection surfaces translate. */
export type FeishuKey = keyof typeof zh

/** English dictionary. */
export const en: Record<FeishuKey, string> = {
  'section.title': 'Feishu account',
  'status.checking': 'Checking connection',
  'status.disconnected': 'Not connected',
  'status.unavailable': 'Cannot confirm sign-in right now',
  'status.connected': 'Connected',
  'status.stopped': 'Feishu component not running',
  'step.configuring': 'Step 1: Link a Feishu app',
  'step.authorizing': 'Step 2: Sign in to Feishu',
  'step.connecting': 'Connecting',
  'step.signing-out': 'Signing out',
  'detail.no-app': 'Link a Feishu app first, either a new one or one you already have, then sign in to Feishu. After that, you can use Feishu docs, messages, and other features you authorize in conversations.',
  'detail.signed-out': 'A Feishu app is linked. Sign in to Feishu to use it in conversations.',
  'detail.unavailable': 'The existing setup and sign-in are kept. Try again later.',
  'detail.stopped': 'The Feishu CLI and skills component is not running. See the component list below for the reason, then retry.',
  'detail.connected': 'Ask the agent to use Feishu directly in a conversation.',
  'detail.connectedAs': 'Signed in as {name}. Ask the agent to use Feishu directly in a conversation.',
  'detail.configuring': 'Create or choose an app on the Feishu page, then come back here to sign in. If the page did not open, select Open Feishu page.',
  'detail.authorizing': 'Confirm the authorization on the Feishu page, then come back here to see the result. If the page did not open, select Open Feishu page.',
  hint: 'The Feishu account is shared with the Feishu CLI in this computer\'s terminal.',
  failed: 'The action did not finish. Try again.',
  'action.connect': 'Connect Feishu',
  'action.linkApp': 'Link Feishu app',
  'action.signIn': 'Sign in to Feishu',
  'action.open': 'Open Feishu page',
  'action.cancel': 'Cancel',
  'action.signOut': 'Sign out',
  'action.retry': 'Retry',
  'badge.connected': 'Connected',
  'badge.disconnected': 'Not connected',
  'badge.connecting': 'Connecting',
  'badge.unavailable': 'Unconfirmed',
  'badge.stopped': 'Not running',
  'signOut.title': 'Sign out of Feishu?',
  'signOut.body': 'This signs out the Feishu CLI\'s default account, including lark-cli in this computer\'s terminal. The linked Feishu app is kept.',
  'activation.title': 'Connect your Feishu account',
  'activation.body': 'The Feishu plugin is on. Connect your Feishu account to use it in conversations.',
  'activation.later': 'Later',
  'notice.app-linked': 'Feishu app linked. Next, sign in to Feishu.',
  'notice.connected': 'Feishu connected',
  'notice.signed-out': 'Signed out of Feishu',
  'notice.action-failed': 'The action did not finish. Try again.',
  close: 'Close',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Feishu connection section, tag, guidance, and notices on the Plugins page. */
    'feishu': FeishuKey
  }
}
