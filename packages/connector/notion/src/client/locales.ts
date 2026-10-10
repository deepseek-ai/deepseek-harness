/** Locale-owned copy for the Notion plugin's connection on the Plugins page. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace for every Notion connection surface. */
export const NS = 'notion'

/** Chinese dictionary and key source. */
export const zh = {
  'section.title': 'Notion 账号',
  'status.checking': '正在检查连接',
  'status.disconnected': '未连接',
  'status.waiting-browser': '等待你在浏览器中确认',
  'status.authorizing': '正在连接',
  'status.connecting': '正在连接',
  'status.connected': '已连接',
  'status.reconnect': '需要重新连接',
  'status.unavailable': '暂时无法连接',
  'detail.disconnected': '连接 Notion 账号后，可以在对话中搜索、读取和编辑你授权的页面与数据库。',
  'detail.waiting-browser': '已打开 Notion 授权页面。在 Notion 中确认后，回到这里查看结果。',
  'detail.authorizing': '正在与 Notion 完成授权。',
  'detail.connecting': '正在连接 Notion。',
  'detail.connected': '可以在对话中直接请 Agent 使用 Notion。',
  'detail.reconnect.expired': '授权已过期，请重新连接。',
  'detail.reconnect.binding': '授权与当前设置不再匹配，请重新连接。',
  'detail.reconnect.rejected': 'Notion 不再接受当前授权，请重新连接。',
  'detail.reconnect.scope': '当前授权缺少所需权限。重新连接时，请在 Notion 中确认权限。',
  'detail.unavailable': '已保留现有授权，可以稍后重试。',
  hostBrowser: '授权需要在运行 DSH 的这台电脑上的浏览器中完成。',
  failed: '授权未完成，请重试',
  'action.connect': '连接 Notion',
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
  'signOut.title': '退出 Notion 登录？',
  'signOut.body': '将删除 DSH 保存的 Notion 授权，之后对话中无法使用 Notion。如需在 Notion 一侧撤销连接，请到 Notion 的设置中处理。',
  'activation.title': '连接 Notion 账号',
  'activation.body': 'Notion 插件已开启。连接你的 Notion 账号后，就可以在对话中使用它。',
  'activation.later': '稍后',
  'notice.connected': 'Notion 已连接',
  'notice.signed-out': '已退出 Notion 登录',
  'notice.action-failed': '操作未完成，请重试',
  close: '关闭',
}

/** Every key the Notion connection surfaces translate. */
export type NotionKey = keyof typeof zh

/** English dictionary. */
export const en: Record<NotionKey, string> = {
  'section.title': 'Notion account',
  'status.checking': 'Checking connection',
  'status.disconnected': 'Not connected',
  'status.waiting-browser': 'Waiting for you to confirm in the browser',
  'status.authorizing': 'Connecting',
  'status.connecting': 'Connecting',
  'status.connected': 'Connected',
  'status.reconnect': 'Reconnection needed',
  'status.unavailable': 'Cannot connect right now',
  'detail.disconnected': 'Connect your Notion account to search, read, and edit the pages and databases you authorize, right from a conversation.',
  'detail.waiting-browser': 'The Notion authorization page is open. Confirm in Notion, then come back here to see the result.',
  'detail.authorizing': 'Finishing authorization with Notion.',
  'detail.connecting': 'Connecting to Notion.',
  'detail.connected': 'Ask the agent to use Notion directly in a conversation.',
  'detail.reconnect.expired': 'The authorization has expired. Connect again.',
  'detail.reconnect.binding': 'The authorization no longer matches the current settings. Connect again.',
  'detail.reconnect.rejected': 'Notion no longer accepts the current authorization. Connect again.',
  'detail.reconnect.scope': 'The current authorization lacks required permissions. Confirm them in Notion when you connect again.',
  'detail.unavailable': 'The existing authorization is kept. Try again later.',
  hostBrowser: 'Authorization must be completed in a browser on the computer running DSH.',
  failed: 'Authorization was not completed. Try again.',
  'action.connect': 'Connect Notion',
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
  'signOut.title': 'Sign out of Notion?',
  'signOut.body': 'This deletes the Notion authorization DSH saved, so conversations can no longer use Notion. To revoke the connection on Notion\'s side, use Notion\'s settings.',
  'activation.title': 'Connect your Notion account',
  'activation.body': 'The Notion plugin is on. Connect your Notion account to use it in conversations.',
  'activation.later': 'Later',
  'notice.connected': 'Notion connected',
  'notice.signed-out': 'Signed out of Notion',
  'notice.action-failed': 'The action did not finish. Try again.',
  close: 'Close',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Notion connection section, tag, guidance, and notices on the Plugins page. */
    'notion': NotionKey
  }
}
