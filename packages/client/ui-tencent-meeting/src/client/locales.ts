/** Locale-owned copy for the Tencent Meeting plugin's account on the Plugins page. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace for every Tencent Meeting account surface. */
export const NS = 'tencent-meeting'

/** Chinese dictionary and key source. */
export const zh = {
  'section.title': '腾讯会议账号',
  'status.checking': '正在检查连接',
  'status.disconnected': '未连接',
  'status.unavailable': '暂时无法确认登录状态',
  'status.connected': '已连接',
  'status.stopped': '腾讯会议组件未运行',
  'step.authorizing': '等待在腾讯会议页面授权',
  'step.connecting': '正在连接',
  'step.signing-out': '正在退出登录',
  'detail.disconnected': '登录腾讯会议账号后，就可以在对话中使用会议、录制、纪要和会议报告等功能。',
  'detail.unavailable': '已保留现有登录，可以稍后重试。',
  'detail.stopped': '“腾讯会议 CLI 与技能”组件没有运行，可以在下方组件列表查看原因，处理后重试。',
  'detail.connected': '已登录为 {name}。可以在对话中直接请 Agent 使用腾讯会议。',
  'detail.authorizing': '在打开的腾讯会议页面中确认授权，完成后回到这里查看结果。页面没有打开时，点击“打开腾讯会议页面”。',
  hint: '腾讯会议账号与这台电脑终端里的 tmeet 共用；关闭插件不会退出登录。',
  failed: '操作未完成，请重试',
  'failure.details': '排障信息：{details}',
  'failure.exitCode': '退出码 {code}',
  'action.connect': '连接腾讯会议',
  'action.open': '打开腾讯会议页面',
  'action.cancel': '取消',
  'action.signOut': '退出登录',
  'action.retry': '重试',
  'badge.connected': '已连接',
  'badge.disconnected': '未连接',
  'badge.connecting': '连接中',
  'badge.unavailable': '待确认',
  'badge.stopped': '未运行',
  'signOut.title': '退出腾讯会议登录？',
  'signOut.body': '将退出 tmeet 的登录，这台电脑终端里的 tmeet 也会一起退出。',
  'activation.title': '连接腾讯会议账号',
  'activation.body': '腾讯会议插件已开启。连接你的腾讯会议账号后，就可以在对话中使用它。',
  'activation.later': '稍后',
  'notice.connected': '腾讯会议已连接',
  'notice.signed-out': '已退出腾讯会议登录',
  'notice.action-failed': '操作未完成，请重试',
  close: '关闭',
}

/** Every key the Tencent Meeting account surfaces translate. */
export type TencentMeetingKey = keyof typeof zh

/** English dictionary. */
export const en: Record<TencentMeetingKey, string> = {
  'section.title': 'Tencent Meeting account',
  'status.checking': 'Checking connection',
  'status.disconnected': 'Not connected',
  'status.unavailable': 'Cannot confirm sign-in right now',
  'status.connected': 'Connected',
  'status.stopped': 'Tencent Meeting component not running',
  'step.authorizing': 'Waiting for authorization on the Tencent Meeting page',
  'step.connecting': 'Connecting',
  'step.signing-out': 'Signing out',
  'detail.disconnected': 'Sign in to Tencent Meeting to use meetings, recordings, minutes, meeting reports, and other features in conversations.',
  'detail.unavailable': 'The existing sign-in is kept. Try again later.',
  'detail.stopped': 'The Tencent Meeting CLI and skills component is not running. See the component list below for the reason, then retry.',
  'detail.connected': 'Signed in as {name}. Ask the agent to use Tencent Meeting directly in a conversation.',
  'detail.authorizing': 'Confirm the authorization on the Tencent Meeting page that opened, then come back here to see the result. If the page did not open, select Open Tencent Meeting page.',
  hint: 'The Tencent Meeting account is shared with tmeet in this computer\'s terminal. Turning the plugin off does not sign it out.',
  failed: 'The action did not finish. Try again.',
  'failure.details': 'Diagnostic: {details}',
  'failure.exitCode': 'Exit code {code}',
  'action.connect': 'Connect Tencent Meeting',
  'action.open': 'Open Tencent Meeting page',
  'action.cancel': 'Cancel',
  'action.signOut': 'Sign out',
  'action.retry': 'Retry',
  'badge.connected': 'Connected',
  'badge.disconnected': 'Not connected',
  'badge.connecting': 'Connecting',
  'badge.unavailable': 'Unconfirmed',
  'badge.stopped': 'Not running',
  'signOut.title': 'Sign out of Tencent Meeting?',
  'signOut.body': 'This signs out tmeet, including tmeet in this computer\'s terminal.',
  'activation.title': 'Connect your Tencent Meeting account',
  'activation.body': 'The Tencent Meeting plugin is on. Connect your Tencent Meeting account to use it in conversations.',
  'activation.later': 'Later',
  'notice.connected': 'Tencent Meeting connected',
  'notice.signed-out': 'Signed out of Tencent Meeting',
  'notice.action-failed': 'The action did not finish. Try again.',
  close: 'Close',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Tencent Meeting account section, tag, guidance, and notices on the Plugins page. */
    'tencent-meeting': TencentMeetingKey
  }
}
