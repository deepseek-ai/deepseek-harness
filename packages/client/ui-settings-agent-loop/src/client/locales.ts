/** Locale bundles for the agent loop's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type AgentLoopSettingsLocaleKey =
  | 'title' | 'description' | 'maxParallel' | 'maxParallelHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<AgentLoopSettingsLocaleKey, string> = {
  title: 'Agent loop',
  description: 'Control how the Agent dispatches tool calls.',
  maxParallel: 'Parallel tool calls',
  maxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<AgentLoopSettingsLocaleKey, string> = {
  title: 'Agent 循环',
  description: '控制 Agent 派发工具调用的方式。',
  maxParallel: '并行工具调用数',
  maxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: AgentLoopSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
