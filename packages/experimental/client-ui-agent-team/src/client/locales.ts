/** Agent Teams Web dictionaries. */

/** Locale namespace owned by the Agent Teams Web UI. */
export const NS = 'agent-team'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: '任务板',
  'mode.label': '使用智能体团队',
  'mode.failed': '无法确认智能体团队设置已保存，请重试：{message}',
  'mode.unavailable': '此会话暂时无法切换智能体团队',
  loading: '正在加载任务板…',
  unavailable: '任务板暂不可用',
  failure: '任务记录无效：{message}',
  empty: '暂无共享任务，可以通过对话创建',
  tasks: '共享任务',
  owner: 'Owner',
  unowned: '未分配',
  blockedBy: '依赖',
  writeScopes: '写入范围',
  ready: '可开始',
  blocked: '被依赖阻塞',
  'task.expand': '展开',
  'task.collapse': '收起',
  'status.pending': '待处理',
  'status.in_progress': '进行中',
  'status.completed': '已完成',
} satisfies Record<string, string>

/** Agent Teams locale key union. */
export type TeamKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  trigger: 'Task board',
  'mode.label': 'Use Agent Teams',
  'mode.failed': 'Could not confirm Agent Teams was saved. Try again: {message}',
  'mode.unavailable': 'Agent Teams cannot be changed in this session',
  loading: 'Loading task board…',
  unavailable: 'Task board is unavailable',
  failure: 'Invalid persisted task record: {message}',
  empty: 'No shared tasks yet. Create them through the conversation.',
  tasks: 'Shared tasks',
  owner: 'Owner',
  unowned: 'Unowned',
  blockedBy: 'Blocked by',
  writeScopes: 'Write scopes',
  ready: 'Ready',
  blocked: 'Blocked by dependencies',
  'task.expand': 'Show more',
  'task.collapse': 'Show less',
  'status.pending': 'Pending',
  'status.in_progress': 'In progress',
  'status.completed': 'Completed',
} satisfies Record<TeamKey, string>
