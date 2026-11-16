import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import defaults from './defaults.ts'
import { appLanguage, defaultReportCadence, languages, MINUTE_MS, PROMPT_LIMIT, progressPrecisions } from './policy.ts'
import type { Language, OutputLanguage, ProgressPrecision } from './policy.ts'
import { reportPeriods, validReportPeriods } from './periods.ts'

/** Profile-owned task tracking, report cadence, and summarization instructions. */
export interface Config {
  /** Generate new interval reports. */
  reportsEnabled: boolean
  /** Minimum elapsed time between reports, in milliseconds. */
  intervalMs: number
  /** Ratios between successive report periods. */
  rollupFactors: number[]
  /** Language for task trees, report summaries, and discussion replies. */
  language: Language
  /** Host display language used for task and report text. */
  uiLanguage: OutputLanguage
  /** Number of decimal places in displayed progress. */
  progressDecimals: ProgressPrecision
  /** Show progress by status on the bar. */
  segmentedProgress: boolean
  /** Keep Todo tools available when the agent preset provides them. */
  allowTodo: boolean
  /** Open the sidebar when the first task tree appears in a conversation. */
  autoOpenSidebar: boolean
  /** Agent iterations without an update before a reminder. */
  reminderIterations: number
  /** Maximum tasks in one tree. */
  maxTasks: number
  /** Maximum trees in a session. */
  maxTrees: number
  /** Maximum simultaneous report requests. */
  maxConcurrent: number
  /** Maximum time for a report request, in milliseconds. */
  timeoutMs: number
  /** Maximum bytes accepted from a report response. */
  maxResponseBytes: number
  /** Writing guidance for the task update tool. */
  taskPrompt: string
  /** Instructions shared by all report levels. */
  summaryPrompt: string
  /** Extra report instructions for each level. */
  levelPrompts: string[]
  /** Maximum model tokens in one report response. */
  reportMaxTokens: number
  /** Optional reasoning effort supported by the selected report model. */
  reportReasoningEffort?: string
}

/** Loader input with live references for settings that can change without a restart. */
export interface PluginConfig extends Pick<Config, 'maxTasks' | 'maxTrees' | 'maxConcurrent' | 'timeoutMs' | 'maxResponseBytes' | 'reportMaxTokens' | 'reportReasoningEffort'> {
  /** Generate new interval reports. */
  reportsEnabled: Volatile<Config['reportsEnabled']>
  /** Minimum elapsed time between reports, in milliseconds. */
  intervalMs: Volatile<Config['intervalMs']>
  /** Ratios between successive report periods. */
  rollupFactors: Volatile<Config['rollupFactors']>
  /** Language for task trees, report summaries, and discussion replies. */
  language: Volatile<Config['language']>
  /** Number of decimal places in displayed progress. */
  progressDecimals: Volatile<Config['progressDecimals']>
  /** Show progress by status on the bar. */
  segmentedProgress: Volatile<Config['segmentedProgress']>
  /** Keep Todo tools available when the agent preset provides them. */
  allowTodo: Volatile<Config['allowTodo']>
  /** Open the sidebar when the first task tree appears in a conversation. */
  autoOpenSidebar: Volatile<Config['autoOpenSidebar']>
  /** Agent iterations without an update before a reminder. */
  reminderIterations: Volatile<Config['reminderIterations']>
  /** Writing guidance for the task update tool. */
  taskPrompt: Volatile<Config['taskPrompt']>
  /** Instructions shared by all report levels. */
  summaryPrompt: Volatile<Config['summaryPrompt']>
  /** Extra report instructions for each level. */
  levelPrompts: Volatile<Config['levelPrompts']>
}

/** No tool-call or browser-visibility gate is applied to timed reports. */
export const Config: Schema<Partial<Config>, PluginConfig> = Schema.object({
  reportsEnabled: Schema.boolean()
    .default(true)
    .description('Generate new interval reports. Saved reports remain available when disabled.')
    .volatile(),
  intervalMs: Schema.number()
    .min(MINUTE_MS)
    .max(86400000)
    .step(1)
    .default(defaultReportCadence.intervalMs)
    .description(
      'Minimum elapsed time between reports, at least one minute. Overdue work is reported on resume.',
    )
    .volatile(),
  rollupFactors: Schema.array(
    Schema.number()
      .min(1 + Number.EPSILON)
      .max(10080),
  )
    .max(4)
    .default([...defaultReportCadence.rollupFactors])
    .description('Ratios between strictly increasing hierarchy periods. Fractional ratios are supported.')
    .volatile(),
  language: Schema.union(languages)
    .default('ui')
    .description(
      'Language for Timeline task-tree text and background summaries only; other work is unchanged.',
    )
    .volatile(),
  progressDecimals: Schema.union(progressPrecisions)
    .default(2)
    .description('Decimal places shown for task progress, from zero to three.')
    .volatile(),
  segmentedProgress: Schema.boolean()
    .default(true)
    .description('Show completed, active, pending or paused, and blocked work as weighted progress segments.')
    .volatile(),
  allowTodo: Schema.boolean()
    .default(false)
    .description('Allow agents to use Todo when it is already provided by their preset.')
    .volatile(),
  autoOpenSidebar: Schema.boolean()
    .default(true)
    .description('Open the sidebar when the first task tree appears in a conversation.')
    .volatile(),
  reminderIterations: Schema.number()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .step(1)
    .default(24)
    .description('Agent iterations without a successful task update before a task-tree reminder.')
    .volatile(),
  maxTasks: Schema.number().min(1).max(1000).step(1).default(500),
  maxTrees: Schema.number().min(1).max(100).step(1).default(30),
  maxConcurrent: Schema.number().min(1).max(8).step(1).default(2),
  timeoutMs: Schema.number().min(1).max(600000).step(1).default(120000),
  maxResponseBytes: Schema.number().min(1).max(1048576).step(1).default(65536),
  reportMaxTokens: Schema.number().min(1).max(32768).step(1).default(4096)
    .description('Maximum model tokens in a report response.'),
  reportReasoningEffort: Schema.string().max(64).required(false)
    .description('Optional reasoning effort id supported by the report model.'),
  taskPrompt: Schema.string()
    .max(PROMPT_LIMIT)
    .role('textarea')
    .default(defaults.taskPrompt)
    .description(
      'Task-writing guidance in the timeline_tasks tool description; not added to the system prompt.',
    )
    .volatile(),
  summaryPrompt: Schema.string()
    .min(1)
    .max(PROMPT_LIMIT)
    .role('textarea')
    .default(defaults.summaryPrompt)
    .description(
      'Instructions for both interval summaries and hierarchical rollups. Output must keep progress, uncertainties, and userActions arrays.',
    )
    .volatile(),
  levelPrompts: Schema.array(Schema.string().max(PROMPT_LIMIT).role('textarea'))
    .max(5)
    .default([])
    .description('Optional extra instructions for each level, added to the global summaryPrompt.')
    .volatile(),
})

// Keep the object schema visible to the config editor and Loader's volatile path lookup.
const standard = Config['~standard']
Object.defineProperty(Config, '~standard', {
  value: {
    ...standard,
    validate(value: unknown) {
      const result = standard.validate(value)
      if ('value' in result) {
        const input = result.value as PluginConfig
        const cadence = { intervalMs: input.intervalMs.get(), rollupFactors: input.rollupFactors.get() }
        if (!validReportPeriods(reportPeriods(cadence)))
          return { issues: [{ path: ['rollupFactors'], message: 'Timeline report periods must increase and stay within seven days.' }] }
      }
      return result
    },
  },
})

/**
 * Keep loader-owned references; reparsing them here would detach live settings updates.
 * @param input - input to validate.
 * @param readLanguage - the Host display language reader.
 * @returns a view that reads the current value of each live setting.
 */
export function liveConfig(input: PluginConfig, readLanguage = () => Intl.DateTimeFormat().resolvedOptions().locale): Config {
  return {
    get reportsEnabled() {
      return input.reportsEnabled.get()
    },
    get intervalMs() {
      return input.intervalMs.get()
    },
    get rollupFactors() {
      return [...input.rollupFactors.get()]
    },
    get language() {
      return input.language.get()
    },
    get uiLanguage() {
      return appLanguage(readLanguage())
    },
    get progressDecimals() {
      return input.progressDecimals.get()
    },
    get segmentedProgress() {
      return input.segmentedProgress.get()
    },
    get allowTodo() {
      return input.allowTodo.get()
    },
    get autoOpenSidebar() {
      return input.autoOpenSidebar.get()
    },
    get reminderIterations() {
      return input.reminderIterations.get()
    },
    get maxTasks() {
      return input.maxTasks
    },
    get maxTrees() {
      return input.maxTrees
    },
    get maxConcurrent() {
      return input.maxConcurrent
    },
    get timeoutMs() {
      return input.timeoutMs
    },
    get maxResponseBytes() {
      return input.maxResponseBytes
    },
    get summaryPrompt() {
      return input.summaryPrompt.get()
    },
    get taskPrompt() {
      return input.taskPrompt.get()
    },
    reportMaxTokens: input.reportMaxTokens,
    ...(input.reportReasoningEffort === undefined ? {} : { reportReasoningEffort: input.reportReasoningEffort }),
    get levelPrompts() {
      return [...input.levelPrompts.get()]
    },
  }
}
