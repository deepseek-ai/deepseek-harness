/**
 * Model-facing `job_output`, `job_list`, and `job_kill` tools over
 * `ctx.jobs`. Loading the plugin attaches the controller required by
 * producers. It also delivers completions the model has not already
 * collected to the owning agent: injected into a busy owner's next step, or
 * opening a turn on an idle one under the default `wakeup` delivery, unbounded
 * unless `maxConsecutiveWakes` caps it per owner. A notice carries the job's
 * output and result when it fits `inlineOutputBytes`, and `job_output`
 * withdraws a notice still pending.
 * @module @deepseek-ai/dsh-tool-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageId } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobEvent, JobView, JobRead } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { publicJob, renderModelDelta, statusLine } from './render.ts'
import type { PublicJobSnapshot } from './render.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-jobs': { kind: 'tool-jobs' } & ContextFormed
  }
}

export const name = 'tool-jobs'
export const inject = ['tools', 'jobs', 'systemPrompt']

/**
 * How an uncollected completion reaches an owner that is already idle: `wakeup`
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
   * notice degrades to injection, reset by any user-authored input. Absent by
   * default: every idle completion wakes its owner. Set it to bound the
   * self-exciting chain where a woken turn starts the job whose completion
   * wakes it again, at the cost of notices past the cap waiting silently for
   * the next user input.
   */
  maxConsecutiveWakes?: number
  /**
   * Largest complete completion notice, in UTF-8 bytes, that carries the
   * job's output and final result inline (default 2048); a larger one, or one
   * over the producer's `outputLimitBytes`, leaves them for `job_output`. 0
   * never inlines.
   */
  inlineOutputBytes?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(600_000),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1),
  inlineOutputBytes: z.natural().default(2048),
})

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
 * @param job - the settled job.
 * @returns its kind, label, and status, bounded like every notice summary.
 */
function completionSummary(job: JobView): string {
  return boundContextSummary(`${job.kind} ${job.label} ${statusLine(publicJob(job))}`)
}

/**
 * The job's label as a notice names it: the first non-empty line, bounded
 * like a notice summary. The model wrote the full command and holds the job id.
 * @param job - the settled job.
 * @returns ` (kind: label) finished [status: …]`.
 */
function noticeDetail(job: JobView): string {
  const text = job.label.trimStart()
  const newline = text.indexOf('\n')
  const label = boundContextSummary(newline === -1 ? text : `${text.slice(0, newline)}…`)
  return ` (${job.kind}: ${label}) finished ${statusLine(publicJob(job))}`
}

/**
 * The notice that carries the job's output and final result, when the
 * complete text fits both `maxBytes` and the producer's cap.
 * @param job - the settled job.
 * @param output - the consuming read taken at settlement.
 * @param maxBytes - the configured inline bound.
 * @returns the notice text, or undefined when it does not fit.
 */
function inlineCompletionNotice(job: JobView, output: string, maxBytes: number): string | undefined {
  const head = `background job ${job.id}${noticeDetail(job)}`
  const text = output.length === 0 ? `${head}. No new output.` : `${head}. Output:\n${output.replace(/\n$/, '')}`
  const bytes = encoder.encode(text).byteLength
  return bytes <= maxBytes && bytes <= (job.outputLimitBytes ?? Infinity) ? text : undefined
}

function fitCompletionNotice(job: JobView): string {
  const prefix = `background job ${job.id}`
  const detail = noticeDetail(job)
  const action = '\nDone; job_output.'
  const complete = `${prefix}${detail}. Read its output with job_output.`
  const maxBytes = job.outputLimitBytes
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
  // A partial UUID cannot identify the job. Point the model at the listing instead.
  const recovery = 'background job ended; use job_list for id.'
  if (encoder.encode(recovery).byteLength <= maxBytes) return recovery
  return retainHead('job_list', maxBytes)
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

/** The producer's cap for the job a `job_output` or `job_kill` call names, when it is visible to the caller. */
function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'job_output' && exec.name !== 'job_kill') return undefined
  const jobId = (exec.arguments as { job_id?: unknown } | null | undefined)?.job_id
  if (typeof jobId !== 'string' || jobId.length === 0) return undefined
  return ctx.jobs.list(exec.agent?.id).find(job => job.id === jobId)?.outputLimitBytes
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

/** A completion notice not yet logged; see the `pending` map in {@link apply}. */
interface PendingNotice {
  readonly owner: NonNullable<JobView['owner']>
  readonly messageId: MessageId
  /** Whether the notice carries `held`; otherwise `job_output` returns it. */
  readonly inline: boolean
  /** The consuming read taken at settlement, absent when the read stayed in the registry. */
  readonly held?: string
}

/** The consuming read as the model sees it: the delta, then the result once, then the status line. */
function readBody(read: JobRead): { text: string; job: PublicJobSnapshot } {
  const delta = renderModelDelta(read.chunks, read.lossy, read.job.output.spillPaths ?? [])
  const text = read.result === undefined
    ? delta
    : `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${read.result}`
  return { text, job: publicJob(read.job) }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 600_000
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes
  const inlineBytes = config.inlineOutputBytes ?? 2048

  // Turns this plugin opened on each owner since that owner last consumed
  // human input. Keyed by the exact Agent, so a same-session replacement
  // starts with a full budget.
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(`tool-jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }
  // A budget is a count of turns: a fraction never names a turn, and
  // `Infinity` would spell an "unbounded" that omitting the field already means.
  if (wakeBudget !== undefined && !Number.isSafeInteger(wakeBudget)) {
    throw new Error(`tool-jobs: maxConsecutiveWakes (${wakeBudget}) must be a whole number of turns`)
  }

  // Each completion notice until the model receives its output. A notice
  // whose job wrote at most `inlineOutputBytes` took the consuming read at
  // settlement. When the complete notice fits, it carries that read until it
  // is logged as a `user/message`; a notice claimed by a step that is then
  // rejected or cancelled leaves the read for `job_output`. Otherwise
  // `job_output` returns the held read. `job_output` also withdraws a notice
  // still pending, which would only repeat its result.
  const pending = new Map<JobId, PendingNotice>()

  if (delivery === 'wakeup' && wakeBudget !== undefined) {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // Claiming is the point the human's input actually enters a step; a notice
      // this plugin itself queued must not refill the budget it just spent.
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'tool-jobs') return
    for (const [id, notice] of pending) {
      if (notice.messageId !== event.data.id || notice.owner !== session.id) continue
      // A logged notice keeps only a read it did not carry, for `job_output`.
      if (notice.inline || notice.held === undefined) pending.delete(id)
    }
  })

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

  // Live jobs whose kill the model itself requested through `job_kill`: that
  // tool result is the model's delivery, so the settlement notice would only
  // repeat it. A wait needs no entry here — the registry reports a settlement
  // that released a live wait as `awaited`, whichever plugin was waiting.
  const killedByModel = new Set<JobId>()

  // Waits this plugin ended on next-step input whose consuming read has not
  // committed yet. A settlement inside that window is carried by that read's
  // terminal state and result, so its notice would repeat them; the registry
  // cannot report it `awaited`, because releasing the wait already left the
  // waiter set. One pending claim per released read keeps parallel waits on the
  // same job covered until the last of their reads commits.
  const releasedReads = new Map<JobId, { pending: number }>()
  /** A settlement a released read is expected to carry; delivered at once if that read never commits. */
  const suppressedSettlements = new Map<JobId, SettledEvent>()
  /** A settlement event, the one kind this plugin delivers. */
  type SettledEvent = Extract<JobEvent, { type: 'settled' }>
  const beginReleasedRead = (id: JobId): (() => void) => {
    const claim = releasedReads.get(id) ?? { pending: 0 }
    releasedReads.set(id, claim)
    claim.pending += 1
    return () => {
      claim.pending -= 1
      if (claim.pending !== 0) return
      releasedReads.delete(id)
      // Every released read committed: the result carried the settlement.
      const pending = suppressedSettlements.get(id)
      if (pending === undefined) return
      suppressedSettlements.delete(id)
      deliverSettlement(pending)
    }
  }

  // A busy owner is injected: the notice waits in its next-step inbox, which
  // the turn cannot close over, so jobs settling together cost one step. An
  // idle owner is woken instead, because an undelivered notice is a completion
  // the model never learns about. Either way, disposal before delivery
  // discards it with the owner, and a teardown settlement has no reader left.
  // A settlement this plugin's own released wait is about to collect is
  // skipped too, so the model receives it once, in that tool result.
  //
  // The registry routes each settlement to the scope this plugin was mounted
  // under, so a mount under one preset never sees another preset's agents;
  // this listener owns delivery, not the choice of whom to deliver to.
  /**
   * Deliver one settlement that no caller already collected.
   * @param event - the settlement to announce.
   */
  const deliverSettlement = (event: SettledEvent): void => {
    if (event.cause === 'teardown' || event.job.owner === undefined) return
    // The destination is the agent registered for the owner session now. An
    // owned job needed the agent registry to start, so the registry is only
    // absent here when it left before settlement — and then no inbox is left.
    const owner = ctx.get('agents')?.get(event.job.owner)
    if (owner === undefined) return
    // A stream longer than the bound cannot fit, so the read stays in the
    // registry. A read whose result makes the notice too long is held for
    // `job_output`, whose result the tool pipeline bounds and spills.
    const held = inlineBytes > 0 && event.job.output.total <= inlineBytes
      ? readBody(ctx.jobs.read(event.job.id, event.job.owner)).text
      : undefined
    const inline = held === undefined ? undefined : inlineCompletionNotice(event.job, held, inlineBytes)
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: inline ?? fitCompletionNotice(event.job),
      }],
      source: {
        kind: 'tool-jobs',
        form: 'notice',
        summary: completionSummary(event.job),
      },
    })
    pending.set(event.job.id, {
      owner: event.job.owner, messageId: message.id, inline: inline !== undefined, ...held === undefined ? {} : { held },
    })
    if (delivery === 'wakeup' && owner.status === 'idle') {
      if (wakeBudget === undefined) {
        owner.followup(message)
        return
      }
      const spent = spentWakes.get(owner) ?? 0
      if (spent < wakeBudget) {
        spentWakes.set(owner, spent + 1)
        owner.followup(message)
        return
      }
    }
    owner.inject(message)
  }

  ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
    if (event.type === 'removed') {
      killedByModel.delete(event.job.id)
      pending.delete(event.job.id)
      return
    }
    if (event.type !== 'settled') return
    // The model's own kill result and a live waiter's collection both deliver
    // this settlement; only a settlement no caller collected is held for a
    // released read that has not committed yet. Holding an already-delivered
    // settlement would repeat it when that read never commits.
    if (killedByModel.delete(event.job.id) || event.awaited) return
    if (releasedReads.has(event.job.id)) {
      suppressedSettlements.set(event.job.id, event)
      return
    }
    deliverSettlement(event)
  })

  ctx.tools.register(defineTool({
    name: 'job_output',
    description: 'Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.',
    // A timed-out wait returns job state rather than a TOOL_TIMEOUT error, so
    // this tool owns its deadline instead of using ToolDefinition.timeoutMs.
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds with wait: true. Defaults to and is capped by configuration.' },
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
      const jobs = ctx.jobs
      const agent = exec.agent
      // A wait this execution ends on next-step input claims the read that
      // follows it: the claim stays open until that read commits, so a
      // settlement landing first is delivered by the result, not a notice.
      // The registry keeps its own abort semantics; this tool's input
      // controller only ends the wait early, and the catch below reads the
      // reason from the caller's signals.
      let endReleasedRead: (() => void) | undefined
      let releasedBy: string | undefined
      try {
        if (args.wait === true) {
          const input = new AbortController()
          // FIXME: this treats an inbox insertion whose source is `user` as a
          // user steer, but the source only says who authored the message: hooks,
          // subagents, and future hosts also deliver current-step input, and a
          // plugin may label its own context as `user`. The decision to stop
          // waiting belongs to the operation that delivered the input, not to
          // this consumer; a shared steer signal (a broadcast or AbortSignal
          // raised by the user-input entry points) should let waiters subscribe
          // and decide locally instead. Tracked in #5965.
          const checkInput = (): void => {
            // Only a user-authored message releases the wait. Other current-step
            // inputs — completion notices and injected context — stay queued for
            // the next step instead of interrupting a wait the user did not.
            if (agent === undefined || !agent.inbox.nextStep.some(message => message.source.kind === 'user')) return
            if (endReleasedRead === undefined) {
              endReleasedRead = beginReleasedRead(id)
              releasedBy = 'user steered'
            }
            input.abort()
          }
          // Subscribe before reading pending input; each parallel wait owns its
          // listener. The notification follows the durable insertion commit.
          // FIXME: only this wait stops on the signal. Other blocking waits
          // (`wait_agent`, future subagent waits) keep waiting for the same
          // input and need the shared steer signal rather than their own copy of
          // this release logic. Tracked in #5965.
          const unsubscribe = agent === undefined ? () => {} : ctx.on('agent/inbox/inserted', ({ agent: subject }) => {
            if (subject === agent) checkInput()
          })
          try {
            checkInput()
            await jobs.wait(id, Math.min(args.timeout_ms ?? waitDefault, waitCap), agent?.id, AbortSignal.any([exec.signal, input.signal]))
          } catch (error) {
            // The registry reports every abort as a cancellation. A wait this
            // tool released with its own input controller ends the same way,
            // so the abort reason is read from the caller's own signal here.
            if (!input.signal.aborted) throw error
            // An input released this wait, so the read below carries the
            // current state; a cancellation leaves no consumer for that read,
            // and the claim's release delivers the settlement it withheld.
            if (exec.signal.aborted) throw new Error('wait aborted')
          } finally {
            unsubscribe()
          }
        }
        const body = readBody(jobs.read(id, exec.agent?.id))
        // This result carries any settlement the released wait suppressed.
        if (releasedBy !== undefined) suppressedSettlements.delete(id)
        const notice = pending.get(id)
        if (notice !== undefined) {
          pending.delete(id)
          // This result covers everything the pending notice reports.
          ctx.get('agents')?.get(notice.owner)?.inbox.remove(notice.messageId)
          body.text = `${notice.held ?? ''}${body.text}`
        }
        // The result, not the schema, explains an interruption: the model sees
        // why a running job came back early beside its unchanged progress line.
        if (releasedBy !== undefined && (body.job.status === 'running' || body.job.status === 'stopping')) {
          body.job.detail = body.job.detail === undefined ? releasedBy : `${body.job.detail}; ${releasedBy}`
        }
        return body
      } finally {
        endReleasedRead?.()
      }
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
      const jobs = ctx.jobs.list(exec.agent?.id)
      return Promise.resolve(jobs.map(publicJob))
    },
    presentCall: () => presentJobCall('List background jobs', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'job_kill',
    description: 'Request cancellation of a running background job.',
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
      const jobs = ctx.jobs
      const result = jobs.kill(id, exec.agent?.id, args.reason)
      // The model's own kill is its delivery: the settlement notice would only
      // repeat what this tool result already said.
      if (result === 'requested') killedByModel.add(id)
      // A projection describes current state without consuming pending output.
      const job = publicJob(jobs.get(id, exec.agent?.id))
      return Promise.resolve({
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        job,
      })
    },
    presentCall: args => presentJobCall(`Kill background job ${args.job_id}`, 'execute', args.job_id),
  }))
}
