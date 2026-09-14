/**
 * Model-facing `job_output`, `job_list`, and `job_kill` tools over
 * `ctx.jobs`. Loading the plugin attaches the controller required by
 * producers. It also delivers unreported completions to the owning agent:
 * injected into a busy owner's next step, or opening a turn on an idle one
 * under the default `wakeup` delivery, bounded per owner.
 * @module @deepseek-ai/dsh-tool-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'

export const name = 'tool-jobs'
export const inject = ['tools', 'jobs', 'systemPrompt']

/**
 * How an unreported completion reaches an owner that is already idle: `wakeup`
 * opens a turn for it, `quiet` leaves it pending until something else wakes the
 * owner. A busy owner is injected either way.
 */
export type CompletionDelivery = 'quiet' | 'wakeup'

/** Configures bounded `job_output` waits and completion-notice delivery. */
export interface Config {
  /** Wait duration applied when `job_output` sets `wait` without `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 10min). */
  maxWaitTimeoutMs?: number
  /** Whether a completion opens a turn on an idle owner (default `wakeup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by completion wakes before the next
   * notice degrades to injection, reset by any user-authored input (default 3).
   * Bounds the self-exciting chain where a woken turn starts the job whose
   * completion wakes it again.
   */
  maxConsecutiveWakes?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1).default(3),
})

/** Task state safe for model-authored programs; ownership/bookkeeping fields are omitted. */
export interface PublicJobSnapshot {
  id: string
  kind: string
  label: string
  status: JobSnapshot['status']
  detail?: string
  startedAt: number
  finishedAt?: number
}

/** Shared schema for job-control outputs. */
const PUBLIC_JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['running', 'stopping', 'completed', 'killed', 'failed'],
    },
    detail: { type: 'string' },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
} as const

/** Remove job ownership and notification bookkeeping from a registry snapshot. */
function publicJob(snapshot: JobSnapshot): PublicJobSnapshot {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...snapshot.detail !== undefined ? { detail: snapshot.detail } : {},
    startedAt: snapshot.startedAt,
    ...snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {},
  }
}

/**
 * Render generic status with optional producer detail.
 * @param snapshot - job state to render.
 * @returns a bracketed status line.
 */
export function statusLine(snapshot: Pick<JobSnapshot, 'status' | 'detail'>): string {
  return snapshot.detail !== undefined
    ? `[status: ${snapshot.status}, ${snapshot.detail}]`
    : `[status: ${snapshot.status}]`
}

const encoder = new TextEncoder()

function retainTail(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(
  content: string,
  suffix: string,
  maxBytes: number | undefined,
  omitted: string,
): string {
  const complete = `${content}${suffix}`
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const fixed = `${content.endsWith(omitted.trimStart()) ? '' : omitted}${suffix}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes)
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * One-line account of a settled job for the `notice` form's collapsed row.
 * @param snapshot - the settled job.
 * @returns its kind, label, and status, bounded like every notice summary.
 */
function completionSummary(snapshot: JobSnapshot): string {
  return boundContextSummary(`${snapshot.kind} ${snapshot.label} ${statusLine(snapshot)}`)
}

function fitCompletionNotice(snapshot: JobSnapshot): string {
  const prefix = `background job ${snapshot.id}`
  const detail = ` (${snapshot.kind}: ${snapshot.label}) finished ${statusLine(snapshot)}`
  const action = '\nDone; job_output.'
  const complete = `${prefix}${detail}. Read its output with job_output.`
  const maxBytes = snapshot.outputLimitBytes
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const omitted = '\n[notice truncated]'
  const fixed = `${prefix}${omitted}${action}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes <= maxBytes) {
    return fixedBytes === maxBytes
      ? fixed
      : `${prefix}${retainHead(detail, maxBytes - fixedBytes)}${omitted}${action}`
  }
  const compact = `${prefix}${action}`
  const compactBytes = encoder.encode(compact).byteLength
  if (compactBytes <= maxBytes) return compact
  const actionBytes = encoder.encode(action).byteLength
  if (actionBytes >= maxBytes) return retainTail(action, maxBytes)
  return `${retainHead(prefix, maxBytes - actionBytes)}${action}`
}

function rawSingleText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block?.type !== 'text') return undefined
  return block.text
}

function boundSingleText(content: readonly ContentBlock[], maxBytes: number): ContentBlock[] | undefined {
  const text = rawSingleText(content)
  if (text === undefined) return undefined
  return [{
    type: 'text',
    text: fitWithSuffix(text, '', maxBytes, '\n[result truncated]'),
  }]
}

function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'job_output' && exec.name !== 'job_kill') return undefined
  const jobId = (exec.arguments as { job_id?: unknown } | null | undefined)?.job_id
  if (typeof jobId !== 'string' || jobId.length === 0) return undefined
  return ctx.jobs.list(exec.agent).find(snapshot => snapshot.id === jobId)?.outputLimitBytes
}

/** Validate the non-empty constraint that ParameterSchemaSpec cannot express. */
function validateJobId(value: string): JobId {
  if (value.length === 0) {
    throw new Error(`invalid job_id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return JobId(value)
}

/** Pending presentation shared by the three generic job controls. */
function presentJobCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes ?? 3

  // Turns this plugin opened on each owner since that owner last consumed
  // human input. Keyed by the exact Agent, so a same-session replacement
  // starts with a full budget.
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(`tool-jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }
  // A budget is a count of turns. `Infinity` would leave the runaway chain this
  // field exists to bound unbounded, and a fraction never names a turn at all.
  if (!Number.isSafeInteger(wakeBudget)) {
    throw new Error(`tool-jobs: maxConsecutiveWakes (${wakeBudget}) must be a whole number of turns`)
  }
  // Nothing spends the budget under quiet delivery, so nothing needs to refill it.
  if (delivery === 'wakeup') {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // Claiming is the point the human's input actually enters a step; a notice
      // this plugin itself queued must not refill the budget it just spent.
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }

  const outputLimits = new WeakMap<ToolExecution, number>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const maxBytes = visibleOutputLimit(ctx, exec)
    if (maxBytes !== undefined) outputLimits.set(exec, maxBytes)
    return next()
  }, { prepend: true })
  const finalizeJobContent: NonNullable<ToolDefinition['finalizeContent']> = (exec, result) => {
    const maxBytes = outputLimits.get(exec) ?? visibleOutputLimit(ctx, exec)
    outputLimits.delete(exec)
    if (maxBytes === undefined) return undefined
    if (exec.name === 'job_output' && !result.isError) {
      // This definition owns and schema-validates the canonical value. Preserve
      // its output/status split only while policy left the default rendering intact.
      const value = result.value as unknown as { text: string; job: PublicJobSnapshot }
      const body = value.text.length > 0 ? value.text : '(no new output)'
      const content = body.endsWith('\n') ? body.slice(0, -1) : body
      const suffix = `\n${statusLine(value.job)}`
      if (rawSingleText(result.content) === `${content}${suffix}`) {
        return [{
          type: 'text',
          text: fitWithSuffix(content, suffix, maxBytes, '\n[output truncated]'),
        }]
      }
    }
    return boundSingleText(result.content, maxBytes)
  }

  // Producers may start work only while a controller is attached.
  ctx.jobs.attachController('tool-jobs')

  // Cross-call guidance follows the filesystem sections and precedes product sections.
  ctx.systemPrompt.section({
    name: 'tool:jobs',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: 'Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job\'s work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.',
  })

  // Use the exact lifecycle owner; reusable ids could resolve to a replacement.
  // A busy owner is injected: the notice waits in its next-step inbox, which
  // the turn cannot close over, so jobs settling together cost one step. An
  // idle owner is woken instead, because an unclaimed notice is a completion
  // the model never learns about. Either way, disposal before the claim
  // discards it with the owner, and teardown settlements arrive `reported`.
  //
  // The registry routes each settlement to the listeners its owner's scope
  // chain reaches, so a mount under one preset never sees another preset's
  // agents; this listener owns delivery, not the choice of whom to deliver to.
  ctx.jobs.onJobDone((snapshot, owner) => {
    if (snapshot.reported || owner === undefined) return
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: fitCompletionNotice(snapshot),
      }],
      source: {
        kind: 'plugin',
        plugin: 'tool-jobs',
        form: 'notice',
        summary: completionSummary(snapshot),
      },
    })
    const spent = spentWakes.get(owner) ?? 0
    if (delivery === 'wakeup' && owner.status === 'idle' && spent < wakeBudget) {
      spentWakes.set(owner, spent + 1)
      owner.followup(message)
      return
    }
    owner.inject(message)
  })

  ctx.tools.register(defineTool({
    name: 'job_output',
    description: 'Read a background job. Stream jobs return only output since the previous read; '
      + 'final-output jobs return their result after settlement. Every response ends with '
      + '`[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap.',
    // A timed-out wait returns job state rather than a TOOL_TIMEOUT error, so
    // this tool owns its deadline instead of using ToolDefinition.timeoutMs.
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the job reaches a terminal status or the timeout expires. A timed-out wait returns [status: running] and leaves the job alive.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds (only meaningful with wait: true). Defaults to the configured wait timeout; capped by the configured maximum.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        const separator = body.endsWith('\n') ? '' : '\n'
        return [{ type: 'text', text: `${body}${separator}${statusLine(value.job)}` }]
      },
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      if (args.wait === true) {
        const timeout = Math.min(args.timeout_ms ?? waitDefault, waitCap)
        await ctx.jobs.wait(id, timeout, exec.agent, exec.signal)
      }
      const read = ctx.jobs.read(id, exec.agent)
      return { text: read.text, job: publicJob(read.snapshot) }
    },
    presentCall: args => presentJobCall(`Read output from background job ${args.job_id}`, 'read', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_list',
    description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.',
    parameters: {},
    output: {
      schema: { type: 'array', items: PUBLIC_JOB_SCHEMA },
      render: (_args, jobs) => [{
        type: 'text',
        text: jobs.length === 0
          ? '(no background jobs)'
          : jobs.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      const jobs = ctx.jobs.list(exec.agent)
      return Promise.resolve(jobs.map(publicJob))
    },
    presentCall: () => presentJobCall('List background jobs', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'job_kill',
    description: 'Request cancellation of a running background job by job id. Returns immediately; the job settles as killed once its work actually stops.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the job.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            required: true,
            enum: ['cancellation-requested', 'already-finished'],
          },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'already-finished'
          ? `job ${value.job.id} had already finished ${statusLine(value.job)}`
          : `requested cancellation of job ${value.job.id}`,
      }],
    },
    execute(args, exec) {
      const id = validateJobId(args.job_id)
      const result = ctx.jobs.kill(id, exec.agent, args.reason)
      // A snapshot describes current state without consuming pending output.
      const snapshot = publicJob(ctx.jobs.get(id, exec.agent))
      return Promise.resolve({
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        job: snapshot,
      })
    },
    presentCall: args => presentJobCall(`Kill background job ${args.job_id}`, 'execute', args.job_id),
  }))
}
