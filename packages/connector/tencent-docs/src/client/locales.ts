/** Locale-owned copy for the Tencent Docs plugin's connection on the Plugins page. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { McpAccountKey } from '@deepseek-ai/dsh-client-ui-mcp-account/client'

/** Dictionary namespace for every Tencent Docs connection surface. */
export const NS = 'tencent-docs'

/** Chinese dictionary. */
export const zh: Record<McpAccountKey, string> = {
  'section.title': '腾讯文档账号',
  'status.checking': '正在检查连接',
  'status.disconnected': '未连接',
  'status.waiting-browser': '等待你在浏览器中确认',
  'status.authorizing': '正在连接',
  'status.connecting': '正在连接',
  'status.connected': '已连接',
  'status.reconnect': '需要重新连接',
  'status.unavailable': '暂时无法连接',
  'detail.disconnected': '连接腾讯文档账号后，可以在对话中读取和编辑你有权限的腾讯文档。',
  'detail.waiting-browser': '已打开腾讯文档授权页面。在腾讯文档中确认后，回到这里查看结果。',
  'detail.authorizing': '正在与腾讯文档完成授权。',
  'detail.connecting': '正在连接腾讯文档。',
  'detail.connected': '可以在对话中直接请 Agent 使用腾讯文档。',
  'detail.reconnect.expired': '授权已过期，请重新连接。',
  'detail.reconnect.binding': '授权与当前设置不再匹配，请重新连接。',
  'detail.reconnect.rejected': '腾讯文档不再接受当前授权，请重新连接。',
  'detail.reconnect.scope': '当前授权缺少所需权限。重新连接时，请在腾讯文档中确认权限。',
  'detail.unavailable': '已保留现有授权，可以稍后重试。',
  hostBrowser: '授权需要在运行 DSH 的这台电脑上的浏览器中完成。',
  failed: '授权未完成，请重试',
  'action.connect': '连接腾讯文档',
  'action.reconnect': '重新连接',
  'action.open': '打开授权页面',
  'action.cancel': '取消',
  'action.signOut': '退出登录',
  'action.retry': '重试',
  'badge.connected': '已连接',
  'badge.disconnected': '未连接',
  'badge.reconnect': '需要重新连接',
  'badge.unavailable': '暂时无法连接',
  'badge.connecting': '连接中',
  'signOut.title': '退出腾讯文档登录？',
  'signOut.body': '将删除 DSH 保存的腾讯文档授权，之后对话中无法使用腾讯文档。',
  'activation.title': '连接腾讯文档账号',
  'activation.body': '腾讯文档插件已开启。连接你的腾讯文档账号后，就可以在对话中使用它。',
  'activation.later': '稍后',
  'notice.connected': '腾讯文档已连接',
  'notice.signed-out': '已退出腾讯文档登录',
  'notice.action-failed': '操作未完成，请重试',
  close: '关闭',
}

/** English dictionary. */
export const en: Record<McpAccountKey, string> = {
  'section.title': 'Tencent Docs account',
  'status.checking': 'Checking connection',
  'status.disconnected': 'Not connected',
  'status.waiting-browser': 'Waiting for you to confirm in the browser',
  'status.authorizing': 'Connecting',
  'status.connecting': 'Connecting',
  'status.connected': 'Connected',
  'status.reconnect': 'Reconnection needed',
  'status.unavailable': 'Cannot connect right now',
  'detail.disconnected': 'Connect your Tencent Docs account to read and edit the Tencent Docs you can access, right from a conversation.',
  'detail.waiting-browser': 'The Tencent Docs authorization page is open. Confirm in Tencent Docs, then come back here to see the result.',
  'detail.authorizing': 'Finishing authorization with Tencent Docs.',
  'detail.connecting': 'Connecting to Tencent Docs.',
  'detail.connected': 'Ask the agent to use Tencent Docs directly in a conversation.',
  'detail.reconnect.expired': 'The authorization has expired. Connect again.',
  'detail.reconnect.binding': 'The authorization no longer matches the current settings. Connect again.',
  'detail.reconnect.rejected': 'Tencent Docs no longer accepts the current authorization. Connect again.',
  'detail.reconnect.scope': 'The current authorization lacks required permissions. Confirm them in Tencent Docs when you connect again.',
  'detail.unavailable': 'The existing authorization is kept. Try again later.',
  hostBrowser: 'Authorization must be completed in a browser on the computer running DSH.',
  failed: 'Authorization was not completed. Try again.',
  'action.connect': 'Connect Tencent Docs',
  'action.reconnect': 'Connect again',
  'action.open': 'Open authorization page',
  'action.cancel': 'Cancel',
  'action.signOut': 'Sign out',
  'action.retry': 'Retry',
  'badge.connected': 'Connected',
  'badge.disconnected': 'Not connected',
  'badge.reconnect': 'Reconnect',
  'badge.unavailable': 'Unavailable',
  'badge.connecting': 'Connecting',
  'signOut.title': 'Sign out of Tencent Docs?',
  'signOut.body': 'This deletes the Tencent Docs authorization DSH saved, so conversations can no longer use Tencent Docs.',
  'activation.title': 'Connect your Tencent Docs account',
  'activation.body': 'The Tencent Docs plugin is on. Connect your Tencent Docs account to use it in conversations.',
  'activation.later': 'Later',
  'notice.connected': 'Tencent Docs connected',
  'notice.signed-out': 'Signed out of Tencent Docs',
  'notice.action-failed': 'The action did not finish. Try again.',
  close: 'Close',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Tencent Docs connection section, tag, guidance, and notices on the Plugins page. */
    'tencent-docs': McpAccountKey
  }
}
