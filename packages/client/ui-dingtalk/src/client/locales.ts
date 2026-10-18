/** Locale-owned copy for the DingTalk plugin's account on the Plugins page. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace for every DingTalk account surface. */
export const NS = 'dingtalk'

/** Chinese dictionary and key source. */
export const zh = {
  'section.title': '钉钉账号',
  'status.checking': '正在检查连接',
  'status.disconnected': '未连接',
  'status.unavailable': '暂时无法确认登录状态',
  'status.connected': '已连接',
  'status.stopped': '钉钉组件未运行',
  'step.downloading': '正在下载 dws 及其技能',
  'step.authorizing': '等待在钉钉页面授权',
  'step.connecting': '正在连接',
  'step.signing-out': '正在退出登录',
  'detail.disconnected': '登录已加入组织的钉钉账号后，就可以在对话中使用日程、待办、文档、AI 表格、群聊和通讯录等功能。组织管理员需要先在钉钉开发者后台开启 CLI 访问；未开启时，可以在授权页向管理员申请。',
  'detail.unavailable': '已保留现有登录，可以稍后重试。',
  'detail.missing': '没能下载 dws 或它的技能，请检查网络或代理后重试。',
  'detail.stopped': '“钉钉 CLI 与技能”组件没有运行，可以在下方组件列表查看原因，处理后重试。',
  'detail.connected': '可以在对话中直接请 Agent 使用钉钉。',
  'detail.connectedAs': '已登录为 {name}。可以在对话中直接请 Agent 使用钉钉。',
  'detail.connectedIn': '已登录为 {org} 的 {name}。可以在对话中直接请 Agent 使用钉钉。',
  'detail.authorizing': '在打开的钉钉页面中扫码确认，完成后回到这里查看结果。页面没有打开时，点击“打开授权页面”。',
  hint: '钉钉账号与这台电脑终端里的 dws 共用；关闭插件不会退出登录。',
  failed: '操作未完成，请重试',
  'failed.signIn': '登录未完成，请重试。如果组织还没有开启 CLI 访问，请联系组织管理员开启，或在授权页申请。',
  'failure.details': '排障信息：{details}',
  'failure.exitCode': '退出码 {code}',
  'action.connect': '连接钉钉',
  'action.open': '打开授权页面',
  'action.cancel': '取消',
  'action.signOut': '退出登录',
  'action.retry': '重试',
  'badge.connected': '已连接',
  'badge.disconnected': '未连接',
  'badge.connecting': '连接中',
  'badge.unavailable': '待确认',
  'badge.stopped': '未运行',
  'signOut.title': '退出钉钉登录？',
  'signOut.body': '将退出当前钉钉账号，这台电脑终端里的 dws 也会退出这个账号；本机登录的其他组织账号不受影响。',
  'activation.title': '连接钉钉账号',
  'activation.body': '钉钉插件已开启。连接你的钉钉账号后，就可以在对话中使用它。',
  'activation.later': '稍后',
  'notice.connected': '钉钉已连接',
  'notice.signed-out': '已退出钉钉登录',
  'notice.action-failed': '操作未完成，请重试',
  close: '关闭',
}

/** Every key the DingTalk account surfaces translate. */
export type DingtalkKey = keyof typeof zh

/** English dictionary. */
export const en: Record<DingtalkKey, string> = {
  'section.title': 'DingTalk account',
  'status.checking': 'Checking connection',
  'status.disconnected': 'Not connected',
  'status.unavailable': 'Cannot confirm sign-in right now',
  'status.connected': 'Connected',
  'status.stopped': 'DingTalk component not running',
  'step.downloading': 'Downloading dws and its skills',
  'step.authorizing': 'Waiting for authorization on the DingTalk page',
  'step.connecting': 'Connecting',
  'step.signing-out': 'Signing out',
  'detail.disconnected': 'Sign in with a DingTalk account that belongs to an organization to use calendar, to-dos, docs, AI tables, group chats, contacts, and more in conversations. An organization admin must first turn on CLI access in the DingTalk developer console; until then, you can request it on the authorization page.',
  'detail.unavailable': 'The existing sign-in is kept. Try again later.',
  'detail.missing': 'dws or its skills could not be downloaded. Check the network or proxy, then retry.',
  'detail.stopped': 'The DingTalk CLI and skills component is not running. See the component list below for the reason, then retry.',
  'detail.connected': 'Ask the agent to use DingTalk directly in a conversation.',
  'detail.connectedAs': 'Signed in as {name}. Ask the agent to use DingTalk directly in a conversation.',
  'detail.connectedIn': 'Signed in as {name} at {org}. Ask the agent to use DingTalk directly in a conversation.',
  'detail.authorizing': 'Scan and confirm on the DingTalk page that opened, then come back here to see the result. If the page did not open, select Open authorization page.',
  hint: 'The DingTalk account is shared with dws in this computer\'s terminal. Turning the plugin off does not sign out.',
  failed: 'The action did not finish. Try again.',
  'failed.signIn': 'Sign-in did not finish. Try again. If your organization has not turned on CLI access, ask an organization admin to turn it on, or request it on the authorization page.',
  'failure.details': 'Diagnostic: {details}',
  'failure.exitCode': 'Exit code {code}',
  'action.connect': 'Connect DingTalk',
  'action.open': 'Open authorization page',
  'action.cancel': 'Cancel',
  'action.signOut': 'Sign out',
  'action.retry': 'Retry',
  'badge.connected': 'Connected',
  'badge.disconnected': 'Not connected',
  'badge.connecting': 'Connecting',
  'badge.unavailable': 'Unconfirmed',
  'badge.stopped': 'Not running',
  'signOut.title': 'Sign out of DingTalk?',
  'signOut.body': 'This signs out the current DingTalk account, including in dws in this computer\'s terminal. Accounts of other organizations signed in on this computer stay signed in.',
  'activation.title': 'Connect your DingTalk account',
  'activation.body': 'The DingTalk plugin is on. Connect your DingTalk account to use it in conversations.',
  'activation.later': 'Later',
  'notice.connected': 'DingTalk connected',
  'notice.signed-out': 'Signed out of DingTalk',
  'notice.action-failed': 'The action did not finish. Try again.',
  close: 'Close',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dingtalk': DingtalkKey
  }
}
