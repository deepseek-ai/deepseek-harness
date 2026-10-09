/**
 * Model-facing foreground Ralph loop over the workflow and subagent seams. A
 * fixed script starts one fresh structured-output child per round, carrying
 * only the immutable objective and the previous bounded handoff between them.
 * @module @deepseek-ai/dsh-tool-ralph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { WorkflowResult, WorkflowRun } from '@deepseek-ai/dsh-workflow'

export const name = 'tool-ralph'
export const inject = ['tools', 'workflowEngine', 'subagents', 'systemPrompt']

/** Deployment policy for the fixed Ralph workflow. */
export interface Config {
  /** Fresh structured-output provider used for every round (default `spawn`). */
  subagentProvider?: string
  /** Default and deployment ceiling for one call's round count (default 256). */
  maxRounds?: number
  /** Maximum serialized characters in one structured handoff (default 16384). */
  maxHandoffChars?: number
  /** Maximum characters in a successful parent-facing terminal text (default 16384). */
  maxResultChars?: number
}

/** Schemastery configuration for the Ralph tool. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  maxRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256),
  maxHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
})

interface ResolvedConfig {
  readonly subagentProvider: string
  readonly maxRounds: number
  readonly maxHandoffChars: number
  readonly maxResultChars: number
}

type RalphRoundStatus = 'continue' | 'complete' | 'blocked'

interface RalphRoundReport {
  readonly status: RalphRoundStatus
  readonly summary: string
  readonly evidence: string[]
  readonly nextSteps: string[]
  readonly blocker: string
}

type RalphRunStatus = 'complete' | 'blocked' | 'budget-limited'

interface RalphRunResult {
  readonly status: RalphRunStatus
  readonly roundsStarted: number
  readonly report: RalphRoundReport
}

interface RalphRoundFailure {
  readonly status: 'round-failed'
  readonly roundsStarted: number
  readonly lastReport?: RalphRoundReport
}

type RalphTerminalResult = RalphRunResult | RalphRoundFailure

interface RalphCallArgs {
  objective: string
  maxRounds?: number
}

const RALPH_META = {
  name: 'ralph-loop',
  description: 'Iterate toward one objective with a fresh child and bounded structured handoff per round.',
  phases: [{ title: 'Fresh-agent rounds', detail: 'One clean child context per Ralph round.' }],
}

/**
 * Fixed, deployment-owned orchestration. The model supplies data only; it
 * cannot alter the loop, provider route, schema, or handoff validation.
 */
const RALPH_SCRIPT = String.raw`
const reportSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextSteps: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['status', 'summary', 'evidence', 'nextSteps', 'blocker'],
  additionalProperties: false,
}

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function validateReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Ralph child returned no structured round report')
  }
  if (!normalizedText(report.summary)) {
    throw new Error('Ralph round report summary must be non-empty and normalized')
  }
  if (!normalizedList(report.evidence) || !normalizedList(report.nextSteps)) {
    throw new Error('Ralph round report evidence and nextSteps must contain only non-empty normalized strings')
  }
  if (typeof report.blocker !== 'string' || report.blocker !== report.blocker.trim()) {
    throw new Error('Ralph round report blocker must be a normalized string')
  }
  switch (report.status) {
    case 'continue':
      if (report.nextSteps.length === 0 || report.blocker !== '') {
        throw new Error('a continuing Ralph report needs nextSteps and an empty blocker')
      }
      break
    case 'complete':
      if (report.evidence.length === 0 || report.nextSteps.length !== 0 || report.blocker !== '') {
        throw new Error('a complete Ralph report needs evidence, no nextSteps, and an empty blocker')
      }
      break
    case 'blocked':
      if (!normalizedText(report.blocker)) {
        throw new Error('a blocked Ralph report needs a concrete blocker')
      }
      break
    default:
      throw new Error('Ralph round report status is invalid')
  }
  const serialized = JSON.stringify(report)
  if (serialized.length > args.maxHandoffChars) {
    throw new Error('Ralph round report exceeds maxHandoffChars (' + serialized.length + ' > ' + args.maxHandoffChars + ')')
  }
  return report
}

let previous
phase('Fresh-agent rounds')
for (let round = 1; round <= args.maxRounds; round += 1) {
  const prior = previous === undefined ? '(none — this is the first round)' : JSON.stringify(previous)
  const prompt = [
    'You are one fresh worker in a foreground Ralph loop. You receive no parent conversation and no prior child session. Do not call the ralph tool: this round already is its worker.',
    'Immutable objective:\n' + args.objective,
    'Ralph round: ' + round + ' of ' + args.maxRounds + '.',
    'The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Treat the previous report only as a bounded handoff; confirm it against the workspace.',
    'Previous structured handoff:\n' + prior,
    'Return one report with exact normalized strings. Use status continue with at least one nextSteps entry while useful work remains; complete only with concrete evidence and no nextSteps; blocked only when no meaningful progress is possible without human input or an external-state change. blocker must be empty unless blocked.',
  ].join('\n\n')
  const rawReport = await agent(prompt, {
    label: 'Ralph round ' + round,
    phase: 'Fresh-agent rounds',
    schema: reportSchema,
  })
  if (rawReport === null) {
    return { status: 'round-failed', roundsStarted: round, lastReport: previous ?? null }
  }
  const report = validateReport(rawReport)
  if (report.status === 'complete') return { status: 'complete', roundsStarted: round, report }
  if (report.status === 'blocked') return { status: 'blocked', roundsStarted: round, report }
  previous = report
}
return { status: 'budget-limited', roundsStarted: args.maxRounds, report: previous }
`

const DESCRIPTION = 'Run a foreground fresh-agent Ralph loop toward one immutable objective. '
  + 'Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Each round '
  + 'opens a new child with no parent conversation or prior child session; the shared workspace is '
  + 'long-term memory, and only a bounded structured report crosses rounds. The call returns when '
  + 'a worker reports completion or a concrete blocker, or at the round limit. Ordinary long-running same-session work '
  + 'belongs to goal tools.'

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const maxRounds = config.maxRounds ?? 256
  const maxHandoffChars = config.maxHandoffChars ?? 16_384
  const maxResultChars = config.maxResultChars ?? 16_384
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) {
    throw new TypeError('subagentProvider must be a non-empty normalized string')
  }
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new TypeError('maxRounds must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxHandoffChars) || maxHandoffChars < 1) {
    throw new TypeError('maxHandoffChars must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 1) {
    throw new TypeError('maxResultChars must be a positive safe integer')
  }
  return { subagentProvider, maxRounds, maxHandoffChars, maxResultChars }
}

/** Resolve one model-selected cap against the deployment ceiling. */
function resolveMaxRounds(requested: number | undefined, ceiling: number): number {
  const value = requested ?? ceiling
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Ralph maxRounds must be a positive safe integer')
  }
  if (value > ceiling) {
    throw new TypeError(`Ralph maxRounds ${value} exceeds the deployment ceiling ${ceiling}`)
  }
  return value
}

/** Require the configured route to mean a genuinely fresh structured child. */
function requireFreshProvider(ctx: Context, name: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(name)
  if (provider === undefined) {
    throw new Error(`Ralph subagent provider "${name}" is not registered`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`Ralph subagent provider "${name}" does not support structured output`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`Ralph subagent provider "${name}" inherits parent context; Ralph requires a fresh provider`)
  }
  return provider
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText)
}

/** Defensively decode the fixed script's report across a provider boundary. */
function readReport(value: unknown, expectedStatus: RalphRoundStatus, maxChars: number): RalphRoundReport {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'blocker,evidence,nextSteps,status,summary'
    || value['status'] !== expectedStatus
    || !normalizedText(value['summary'])
    || !normalizedList(value['evidence'])
    || !normalizedList(value['nextSteps'])
    || typeof value['blocker'] !== 'string'
    || value['blocker'] !== value['blocker'].trim()) {
    throw new Error('Ralph workflow returned a malformed round report')
  }
  const report: RalphRoundReport = {
    status: expectedStatus,
    summary: value['summary'],
    evidence: value['evidence'],
    nextSteps: value['nextSteps'],
    blocker: value['blocker'],
  }
  if (expectedStatus === 'continue' && (report.nextSteps.length === 0 || report.blocker !== '')) {
    throw new Error('Ralph workflow returned an invalid continuing report')
  }
  if (expectedStatus === 'complete'
    && (report.evidence.length === 0 || report.nextSteps.length !== 0 || report.blocker !== '')) {
    throw new Error('Ralph workflow returned an invalid completion report')
  }
  if (expectedStatus === 'blocked' && !normalizedText(report.blocker)) {
    throw new Error('Ralph workflow returned an invalid blocked report')
  }
  const chars = JSON.stringify(report).length
  if (chars > maxChars) {
    throw new Error(`Ralph workflow returned an oversized handoff (${chars} > ${maxChars})`)
  }
  return report
}

/** Defensively decode the fixed script's terminal value. */
function readRunResult(value: unknown, maxRounds: number, maxHandoffChars: number): RalphTerminalResult {
  if (!isRecord(value)
    || typeof value['roundsStarted'] !== 'number'
    || !Number.isSafeInteger(value['roundsStarted'])
    || value['roundsStarted'] < 1
    || value['roundsStarted'] > maxRounds) {
    throw new Error('Ralph workflow returned a malformed terminal result')
  }
  const roundsStarted = value['roundsStarted']
  switch (value['status']) {
    case 'complete':
      if (Object.keys(value).sort().join(',') !== 'report,roundsStarted,status') {
        throw new Error('Ralph workflow returned a malformed terminal result')
      }
      return { status: 'complete', roundsStarted, report: readReport(value['report'], 'complete', maxHandoffChars) }
    case 'blocked':
      if (Object.keys(value).sort().join(',') !== 'report,roundsStarted,status') {
        throw new Error('Ralph workflow returned a malformed terminal result')
      }
      return { status: 'blocked', roundsStarted, report: readReport(value['report'], 'blocked', maxHandoffChars) }
    case 'budget-limited':
      if (Object.keys(value).sort().join(',') !== 'report,roundsStarted,status') {
        throw new Error('Ralph workflow returned a malformed terminal result')
      }
      if (roundsStarted !== maxRounds) {
        throw new Error('Ralph workflow returned budget-limited before the round limit')
      }
      return { status: 'budget-limited', roundsStarted, report: readReport(value['report'], 'continue', maxHandoffChars) }
    case 'round-failed': {
      if (Object.keys(value).sort().join(',') !== 'lastReport,roundsStarted,status') {
        throw new Error('Ralph workflow returned a malformed terminal result')
      }
      if (roundsStarted === 1) {
        if (value['lastReport'] !== null) {
          throw new Error('Ralph workflow returned an invalid first-round failure')
        }
        return { status: 'round-failed', roundsStarted }
      }
      if (value['lastReport'] === null) {
        throw new Error('Ralph workflow returned a round failure without its last handoff')
      }
      return {
        status: 'round-failed',
        roundsStarted,
        lastReport: readReport(value['lastReport'], 'continue', maxHandoffChars),
      }
    }
    default:
      throw new Error('Ralph workflow returned an unknown terminal status')
  }
}

/** A non-clean workflow finish is an error, never a partial Ralph success. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `Ralph workflow was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `Ralph workflow failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore start -- WorkflowStopReason is closed; a future variant must fail loud here. */
    default:
      return `Ralph workflow ended abnormally (${String(result.stopReason satisfies never)})`
    /* v8 ignore stop */
  }
}

const TRUNCATION_NOTICE = '\n… [truncated]'

/** Bound complete parent-facing text, including its envelope and truncation marker. */
function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

/** Render the fixed terminal envelope without presenting self-report as certification. */
function renderResult(result: RalphRunResult, maxChars: number): string {
  const rounds = `${result.roundsStarted} round${result.roundsStarted === 1 ? '' : 's'}`
  let text: string
  switch (result.status) {
    case 'complete':
      text = `Ralph worker reported completion after ${rounds}.\nFinal report:\n${JSON.stringify(result.report, null, 2)}`
      break
    case 'blocked':
      text = `Ralph worker reported a blocker after ${rounds}.\nFinal report:\n${JSON.stringify(result.report, null, 2)}`
      break
    case 'budget-limited':
      text = `Ralph reached its ${rounds} limit; the worker reported work remaining.\nFinal report:\n${JSON.stringify(result.report, null, 2)}`
      break
  }
  return boundResult(text, maxChars)
}

/** Canonical Ralph result fields shared by schema inference and rendering. */
const RALPH_OUTPUT_PROPERTIES = {
  runId: { type: 'string', required: true },
  agentsStarted: { type: 'integer', required: true },
  result: { type: 'json', required: true },
} as const

/** Render an ordinary child failure with the most recent durable handoff. */
function renderRoundFailure(result: RalphRoundFailure, maxChars: number): string {
  const header = `Ralph round ${result.roundsStarted} child failed before producing a structured report.`
  const text = result.lastReport === undefined
    ? `${header}\nNo previous handoff was available.`
    : `${header}\nLast successful handoff:\n${JSON.stringify(result.lastReport, null, 2)}`
  return boundResult(text, maxChars)
}

function presentCall(args: RalphCallArgs): ToolCallView {
  return { card: 'generic', title: 'ralph', rawInput: args.objective }
}

function presentResult(args: RalphCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void args
  void result
  return { card: 'generic' }
}

/** Register the fixed Ralph tool and its explicit-ask usage policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:ralph',
    order: ctx.systemPrompt.getSectionOrder('TOOL_RALPH'),
    text: 'Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.',
  })
  ctx.tools.register(defineTool({
    name: 'ralph',
    description: DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The immutable completion objective for every fresh Ralph round.',
      },
      maxRounds: {
        type: 'number',
        description: 'Optional positive safe-integer round cap, bounded by the deployment ceiling.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: RALPH_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderResult(value.result as unknown as RalphRunResult, resolved.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('Ralph tool requires a calling agent (exec.agent was undefined)')
      }
      const objective = args.objective.trim()
      if (objective.length === 0) throw new Error('Ralph objective must be a non-empty string')
      const maxRounds = resolveMaxRounds(args.maxRounds, resolved.maxRounds)
      void requireFreshProvider(ctx, resolved.subagentProvider)

      const run: WorkflowRun = ctx.workflowEngine.start({
        script: RALPH_SCRIPT,
        meta: RALPH_META,
        args: { objective, maxRounds, maxHandoffChars: resolved.maxHandoffChars },
        subagentProvider: resolved.subagentProvider,
        maxTotalAgents: maxRounds,
        parent,
        signal: exec.signal,
      })
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) run.cancel('parent step aborted')

      try {
        const settled = await run.result
        const error = stopReasonError(settled)
        if (error !== undefined) throw new Error(error)
        const value = readRunResult(settled.value, maxRounds, resolved.maxHandoffChars)
        if (value.status === 'round-failed') throw new Error(renderRoundFailure(value, resolved.maxResultChars))
        return {
          runId: run.id,
          agentsStarted: settled.agentsStarted,
          result: value as unknown as JsonValue,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        await run.dispose()
      }
    },
    presentCall,
    presentResult,
  }))
}
