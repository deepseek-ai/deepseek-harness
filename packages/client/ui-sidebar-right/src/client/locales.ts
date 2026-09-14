/**
 * `sidebarRight` namespace dictionaries.
 *
 * Everything a user reads in this column is here, including the strings handed
 * to the docking kit — the kit renders no copy of its own, so its whole
 * vocabulary is this package's to own and translate.
 */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'chrome.expand': '打开侧边栏',
  'chrome.expandAria': '打开右侧边栏',
  'chrome.collapse': '收起侧边栏',
  'chrome.collapseAria': '收起右侧边栏',
  'chrome.toFullscreen': '全屏',
  'chrome.exitFullscreen': '退出全屏',
  'dock.emptyPane': '空面板',
  'dock.splitPane': '分栏',
  'dock.splitPaneDisabled': '已达两格上限',
  'dock.splitPaneNarrow': '栏宽不足，拖宽侧边栏后再分栏',
  'dock.closeTab': '关闭',
  'dock.addTab': '新标签页',
  'dock.dockFloat': '收回到侧边栏',
  'dock.closeFloat': '关闭',
  'dock.drop.center': '移到这里',
  'dock.drop.left': '左分栏',
  'dock.drop.right': '右分栏',
  'dock.drop.top': '上分栏',
  'dock.drop.bottom': '下分栏',
  'tab.guide.title': '开始',
  'tab.unavailable': '这类内容还没有可用的查看方式。',
} satisfies Record<string, string>

/** Right-Sidebar dictionary key union. */
export type SidebarRightKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'chrome.expand': 'Open sidebar',
  'chrome.expandAria': 'Open right sidebar',
  'chrome.collapse': 'Collapse sidebar',
  'chrome.collapseAria': 'Collapse right sidebar',
  'chrome.toFullscreen': 'Fullscreen',
  'chrome.exitFullscreen': 'Exit fullscreen',
  'dock.emptyPane': 'Empty pane',
  'dock.splitPane': 'Split',
  'dock.splitPaneDisabled': 'Two panes is the limit',
  'dock.splitPaneNarrow': 'Not enough width to split, widen the sidebar',
  'dock.closeTab': 'Close',
  'dock.addTab': 'New tab',
  'dock.dockFloat': 'Send back to the sidebar',
  'dock.closeFloat': 'Close',
  'dock.drop.center': 'Move here',
  'dock.drop.left': 'Add left split',
  'dock.drop.right': 'Add right split',
  'dock.drop.top': 'Add top split',
  'dock.drop.bottom': 'Add bottom split',
  'tab.guide.title': 'Start',
  'tab.unavailable': 'Nothing here can view this kind of content yet.',
} satisfies Record<SidebarRightKey, string>
