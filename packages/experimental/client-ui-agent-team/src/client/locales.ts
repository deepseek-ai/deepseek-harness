/** Agent Teams Web dictionaries. */

/** Locale namespace owned by the Agent Teams Web UI. */
export const NS = 'agent-team'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  trigger: '任务板',
  loading: '正在加载任务板…',
  unavailable: '任务板暂不可用',
  failure: '任务记录无效：{message}',
  empty: '暂无共享任务，可以通过对话创建',
  tasks: '共享任务',
  owner: '负责人',
  lead: '主代理',
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
  loading: 'Loading task board…',
  unavailable: 'Task board is unavailable',
  failure: 'Invalid persisted task record: {message}',
  empty: 'No shared tasks yet. Create them through the conversation.',
  tasks: 'Shared tasks',
  owner: 'Owner',
  lead: 'Lead',
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
