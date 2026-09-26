/** Locale bundles for the agent-preset hero chip, header label, and management section. */

import { guideEn, guideZh, type PresetGuideKey } from './guide-locales.ts'

/** Locale keys these surfaces render. */
export type AgentPresetSettingsKey =
  | PresetGuideKey
  | 'builtInGroup'
  | 'customGroup'
  | 'seatHint'
  | 'headerHint'
  | 'nav'
  | 'sectionIntro'
  | 'setDefault'
  | 'view'
  | 'presetStandardName'
  | 'presetStandardDescription'
  | 'presetPtcName'
  | 'presetPtcDescription'
  | 'presetMinimalName'
  | 'presetMinimalDescription'
  | 'presetCordisName'
  | 'presetCordisDescription'
  | 'inUse'
  | 'noDescription'
  | 'brokenBadge'
  | 'switchRefused'
  | 'close'
  | 'creatorDraft'
  | 'enableDevToolsToSetDefault'
  | 'enableDevToolsToCreate'

/** English copy. */
export const en: Record<AgentPresetSettingsKey, string> = {
  ...guideEn,
  builtInGroup: 'Built-in', customGroup: 'Custom',
  sectionIntro: 'Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to DSH.',

  seatHint: 'Choose the agent preset for your new task',
  headerHint: 'The agent preset chosen when this task started',
  nav: 'Agent presets',

  setDefault: 'Set as new task default',
  view: 'View configuration',

  presetStandardName: 'Standard mode',
  presetStandardDescription:
    'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
  presetPtcName: 'PTC mode',
  presetPtcDescription:
    'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
  presetMinimalName: 'Minimal mode',
  presetMinimalDescription:
    'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
  presetCordisName: 'Creator mode',
  presetCordisDescription:
    'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',

  inUse: 'New task default',

  noDescription: 'No description.',
  brokenBadge: 'Failed to load',

  switchRefused: 'Could not switch to {name}: {reason}',

  close: 'Close',

  creatorDraft: 'Let the agent help me create a preset',

  enableDevToolsToSetDefault: 'Turn on Coding Tools in General settings to choose a default',
  enableDevToolsToCreate: 'Turn on Coding Tools in General settings to start Creator mode',
}

/** Simplified Chinese copy. */
export const zh: Record<AgentPresetSettingsKey, string> = {
  ...guideZh,
  builtInGroup: '内置', customGroup: '自定义',
  sectionIntro: '选择 Agent 的工具和工作方式。日常任务用「标准模式」，扩展 DSH 的能力用「创造模式」。',

  seatHint: '选择新任务使用的 Agent 预设',
  headerHint: '本任务的 Agent 预设，在任务开始时确定',
  nav: 'Agent 预设',

  setDefault: '设为新任务默认',
  view: '查看配置',

  presetStandardName: '标准模式',
  presetStandardDescription: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
  presetPtcName: 'PTC 模式',
  presetPtcDescription: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
  presetMinimalName: '极简模式',
  presetMinimalDescription: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
  presetCordisName: '创造模式',
  presetCordisDescription: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',

  inUse: '新任务默认',

  noDescription: '暂无描述。',
  brokenBadge: '加载失败',

  switchRefused: '无法切换到「{name}」：{reason}',

  close: '关闭',

  creatorDraft: '让 Agent 帮我创建预设模式',

  enableDevToolsToSetDefault: '请先在通用设置中开启代码工作工具，再设置默认值',
  enableDevToolsToCreate: '请先在通用设置中开启代码工作工具，再启动创造模式',
}

// The resolution itself is the shared fold in `dsh-agent-preset-registry/display`,
// re-exported here so every surface in this plugin reads one path; the
// Settings plugin list inlines the same fold over this plugin's dictionaries.
export { isBuiltInPreset, presetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
export type { PresetDisplaySource, PresetDisplayText } from '@deepseek-ai/dsh-agent-preset-registry/display'
