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
  'step.configuring': '第 1 步：关联飞书应用',
  'step.authorizing': '第 2 步：登录飞书账号',
  'step.connecting': '正在连接',
  'step.signing-out': '正在退出登录',
  'detail.disconnected': '连接后，可以在对话中使用飞书文档、消息及其他你授权的功能。首次连接会先关联一个飞书应用。',
  'detail.unavailable': '已保留现有配置和登录，可以稍后重试。',
  'detail.connected': '可以在对话中直接请 Agent 使用飞书。',
  'detail.connectedAs': '已登录为 {name}。可以在对话中直接请 Agent 使用飞书。',
  'detail.configuring': '已打开飞书页面。在页面中创建或选择应用后，回到这里继续。',
  'detail.authorizing': '已打开飞书授权页面。确认后回到这里查看结果。',
  hint: '飞书账号与这台电脑终端里的飞书 CLI 共用。',
  failed: '操作未完成，请重试',
  'action.connect': '连接飞书',
  'action.open': '打开授权页面',
  'action.cancel': '取消',
  'action.signOut': '退出登录',
  'action.retry': '重试',
  'badge.connected': '已连接',
  'badge.disconnected': '未连接',
  'badge.connecting': '连接中',
  'badge.unavailable': '待确认',
  'signOut.title': '退出飞书登录？',
  'signOut.body': '将退出飞书 CLI 的默认账号，这台电脑终端里的 lark-cli 也会一起退出。已关联的飞书应用会保留。',
  'activation.title': '连接飞书账号',
  'activation.body': '飞书插件已开启。连接你的飞书账号后，就可以在对话中使用它。',
  'activation.later': '稍后',
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
  'step.configuring': 'Step 1: Link a Feishu app',
  'step.authorizing': 'Step 2: Sign in to Feishu',
  'step.connecting': 'Connecting',
  'step.signing-out': 'Signing out',
  'detail.disconnected': 'Connect to use Feishu docs, messages, and other features you authorize in conversations. The first connection links a Feishu app.',
  'detail.unavailable': 'The existing setup and sign-in are kept. Try again later.',
  'detail.connected': 'Ask the agent to use Feishu directly in a conversation.',
  'detail.connectedAs': 'Signed in as {name}. Ask the agent to use Feishu directly in a conversation.',
  'detail.configuring': 'The Feishu page is open. Create or choose an app there, then come back here.',
  'detail.authorizing': 'The Feishu authorization page is open. Confirm there, then come back here to see the result.',
  hint: 'The Feishu account is shared with the Feishu CLI in this computer\'s terminal.',
  failed: 'The action did not finish. Try again.',
  'action.connect': 'Connect Feishu',
  'action.open': 'Open authorization page',
  'action.cancel': 'Cancel',
  'action.signOut': 'Sign out',
  'action.retry': 'Retry',
  'badge.connected': 'Connected',
  'badge.disconnected': 'Not connected',
  'badge.connecting': 'Connecting',
  'badge.unavailable': 'Unconfirmed',
  'signOut.title': 'Sign out of Feishu?',
  'signOut.body': 'This signs out the Feishu CLI\'s default account, including lark-cli in this computer\'s terminal. The linked Feishu app is kept.',
  'activation.title': 'Connect your Feishu account',
  'activation.body': 'The Feishu plugin is on. Connect your Feishu account to use it in conversations.',
  'activation.later': 'Later',
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
