import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'wecom'

export const zh = {
  'section.title': '企业微信授权',
  'status.checking': '正在检查授权',
  'status.disconnected': '未授权',
  'status.unavailable': '暂时无法读取授权状态',
  'status.connected': '已授权',
  'status.stopped': '企业微信组件未运行',
  'step.authorizing': '等待扫码授权',
  'step.connecting': '正在确认授权',
  'detail.disconnected': '用企业微信扫码绑定一个智能机器人。授权后，可以在对话中通过这个机器人使用企业微信的文档、日程、会议、待办和消息等功能。',
  'detail.unavailable': '没能读取 wecom-cli 的授权状态，可以稍后重试。',
  'detail.stopped': '“企业微信 CLI 与技能”组件没有运行，可以在下方组件列表查看原因，处理后重试。',
  'detail.connected': '可以在对话中直接请 Agent 使用企业微信。',
  'detail.authorizing': '在打开的页面中用企业微信扫码并确认，完成后回到这里查看结果。页面没有打开时，点击“打开扫码页面”。',
  hint: '授权与这台电脑终端里的 wecom-cli 共用；关闭插件不会解除授权。',
  failed: '操作未完成，请重试',
  'failure.details': '排障信息：{details}',
  'failure.exitCode': '退出码 {code}',
  'action.connect': '连接企业微信',
  'action.open': '打开扫码页面',
  'action.cancel': '取消',
  'action.retry': '重试',
  'badge.connected': '已授权',
  'badge.disconnected': '未授权',
  'badge.connecting': '授权中',
  'badge.unavailable': '待确认',
  'badge.stopped': '未运行',
  'activation.title': '连接企业微信',
  'activation.body': '企业微信插件已开启。扫码授权后，就可以在对话中使用它。',
  'activation.later': '稍后',
  'notice.connected': '企业微信已授权',
  'notice.action-failed': '操作未完成，请重试',
  close: '关闭',
}

export type WecomKey = keyof typeof zh

export const en: Record<WecomKey, string> = {
  'section.title': 'WeCom authorization',
  'status.checking': 'Checking authorization',
  'status.disconnected': 'Not authorized',
  'status.unavailable': 'Cannot read authorization right now',
  'status.connected': 'Authorized',
  'status.stopped': 'WeCom component not running',
  'step.authorizing': 'Waiting for the QR code scan',
  'step.connecting': 'Confirming authorization',
  'detail.disconnected': 'Scan a QR code with WeCom to bind a smart bot. After that, you can use WeCom docs, calendar, meetings, to-dos, messages, and other features through this bot in conversations.',
  'detail.unavailable': 'The wecom-cli authorization could not be read. Try again later.',
  'detail.stopped': 'The WeCom CLI and skills component is not running. See the component list below for the reason, then retry.',
  'detail.connected': 'Ask the agent to use WeCom directly in a conversation.',
  'detail.authorizing': 'Scan the QR code with WeCom on the page that opened and confirm, then come back here to see the result. If the page did not open, select Open QR code page.',
  hint: 'The authorization is shared with wecom-cli in this computer\'s terminal. Turning the plugin off does not revoke it.',
  failed: 'The action did not finish. Try again.',
  'failure.details': 'Diagnostic: {details}',
  'failure.exitCode': 'Exit code {code}',
  'action.connect': 'Connect WeCom',
  'action.open': 'Open QR code page',
  'action.cancel': 'Cancel',
  'action.retry': 'Retry',
  'badge.connected': 'Authorized',
  'badge.disconnected': 'Not authorized',
  'badge.connecting': 'Authorizing',
  'badge.unavailable': 'Unconfirmed',
  'badge.stopped': 'Not running',
  'activation.title': 'Connect WeCom',
  'activation.body': 'The WeCom plugin is on. Scan a QR code to authorize it, then use it in conversations.',
  'activation.later': 'Later',
  'notice.connected': 'WeCom authorized',
  'notice.action-failed': 'The action did not finish. Try again.',
  close: 'Close',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'wecom': WecomKey
  }
}
