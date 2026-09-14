/** Workflow child ownership and progress over the shared sandboxed PTC executor. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PtcBindingFunction, PtcJsonValue, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { assertNever, snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { WORKFLOW_GUEST_SOURCE } from './guest-source.ts'
import type { WorkflowProgress } from './guest-types.ts'
import { renderThrown } from './realm.ts'
import type { ExecutionObserver } from './runtime.ts'
import type { ChildStartRequest, WorkerInit } from './types.ts'

interface ChildRecord {
  readonly callId: number
  readonly run: SubagentRun
  disposal?: Promise<void>
}

const GUEST_URL = `data:text/javascript,${encodeURIComponent(WORKFLOW_GUEST_SOURCE)}`
const PROGRAM = `const { runWorkflowGuest } = await import(${JSON.stringify(GUEST_URL)}); return await runWorkflowGuest(workflowHost);`

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow binding requires an object')
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`workflow ${name} must be a string`)
  return value
}

function json(value: unknown): PtcJsonValue {
  const result = snapshotJsonValue(value)
  if (result === undefined) throw new Error('workflow binding value must be lossless JSON')
  return result as PtcJsonValue
}

function childRequest(value: unknown): ChildStartRequest {
  const request = object(value)
  const prompt = text(request.prompt, 'prompt')
  const provider = request.provider === undefined ? undefined : text(request.provider, 'provider')
  const model = request.model === undefined ? undefined : text(request.model, 'model')
  let schema: ObjectJsonSchema | undefined
  if (request.schema !== undefined) {
    const candidate = object(request.schema)
    assertObjectJsonSchema(candidate)
    schema = candidate
  }
  return {
    prompt,
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    ...schema === undefined ? {} : { schema },
  }
}

function agentInfo(value: unknown): WorkflowAgentInfo {
  const info = object(value)
  if (!Number.isSafeInteger(info.seq) || (info.seq as number) < 1) throw new Error('workflow agent sequence must be a positive integer')
  return {
    seq: info.seq as number,
    label: text(info.label, 'agent label'),
    childId: SessionId(text(info.childId, 'child id')),
    ...info.phase === undefined ? {} : { phase: text(info.phase, 'agent phase') },
  }
}

function progress(value: unknown): WorkflowProgress {
  const event = object(value)
  switch (event.type) {
    case 'phase': return { type: 'phase', title: text(event.title, 'phase') }
    case 'log': return { type: 'log', message: text(event.message, 'log') }
    case 'agent-start': return { type: 'agent-start', info: agentInfo(event.info) }
    case 'agent-end': {
      const info = object(event.info)
      if (info.outcome !== 'completed' && info.outcome !== 'failed' && info.outcome !== 'cancelled') throw new Error('invalid workflow agent outcome')
      return { type: 'agent-end', info: { ...agentInfo(info), outcome: info.outcome } }
    }
    default: throw new Error('invalid workflow progress event')
  }
}

function progressBatch(value: unknown): WorkflowProgress[] {
  if (!Array.isArray(value)) throw new Error('workflow progress requires an array of events')
  return value.map(progress)
}

function workflowResult(value: unknown): WorkflowResult {
  const result = object(value)
  if (result.stopReason !== 'completed' && result.stopReason !== 'error' && result.stopReason !== 'cancelled') throw new Error('invalid workflow stop reason')
  if (!Number.isSafeInteger(result.agentsStarted) || (result.agentsStarted as number) < 0) throw new Error('invalid workflow agent count')
  if (!Object.hasOwn(result, 'value')) throw new Error('workflow result is missing its value')
  return {
    value: result.value,
    stopReason: result.stopReason,
    agentsStarted: result.agentsStarted as number,
    ...result.error === undefined ? {} : { error: text(result.error, 'error') },
  }
}

/**
 * Holder-owned workflow. Cancellation stops the program immediately; settlement waits for
 * its managed process and every admitted child startup/disposal. Engine unload does not
 * invalidate the captured runtime or subagent handles.
 */
export class PtcWorkflowRun implements WorkflowRun {
  readonly result: Promise<WorkflowResult>
  private readonly controller = new AbortController()
  private readonly children = new Map<number, ChildRecord>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private started = 0
  private terminal = false
  private cancelReason: string | undefined
  private disposed: Promise<void> | undefined
  private readonly externalAbort: () => void

  constructor(
    private readonly ctx: Context,
    private readonly subagents: SubagentRuntime,
    private readonly runtime: PtcRuntime,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    private readonly init: WorkerInit,
    private readonly provider: string,
    private readonly policy: SandboxExecutionPolicy,
    private readonly observer: ExecutionObserver,
    private readonly signal?: AbortSignal,
  ) {
    this.externalAbort = () => { this.cancel('workflow signal aborted') }
    if (signal?.aborted) this.externalAbort()
    else signal?.addEventListener('abort', this.externalAbort, { once: true })
    // Consumers attach durable run recording after start() returns.
    this.result = Promise.resolve().then(() => this.drive())
  }

  /**
   * Stop the script and abort pending and published children.
   * @param reason - Human-readable cancellation cause; the first request wins.
   */
  cancel(reason = 'workflow cancelled'): void {
    if (this.terminal || this.cancelReason !== undefined) return
    this.cancelReason = reason
    this.controller.abort(reason)
    for (const record of this.children.values()) void this.disposeChild(record)
  }

  /**
   * Cancel unfinished work and await the program and child cleanup.
   * @returns One shared completion promise for repeated disposal calls.
   */
  dispose(): Promise<void> {
    this.cancel('workflow disposed')
    this.disposed ??= this.result.then(() => {})
    return this.disposed
  }

  private requireActive(): void {
    this.controller.signal.throwIfAborted()
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    void task.then(() => { this.pending.delete(task) }, () => { this.pending.delete(task) })
    return task
  }

  private bindings(): Record<string, PtcBindingFunction> {
    return {
      begin: () => { this.requireActive(); return Promise.resolve(json(this.init)) },
      startChild: value => this.track(this.startChild(childRequest(value))),
      childResult: value => this.track(this.childResult(this.child(value))),
      disposeChild: async (value) => { await this.disposeChild(this.child(value)); return null },
      progress: (value) => {
        for (const event of progressBatch(value)) this.onProgress(event)
        return Promise.resolve(null)
      },
    }
  }

  private child(value: unknown): ChildRecord {
    this.requireActive()
    const callId = object(value).callId
    if (!Number.isSafeInteger(callId)) throw new Error('workflow child call id must be an integer')
    const record = this.children.get(callId as number)
    if (record === undefined) throw new Error('workflow child call is not active')
    return record
  }

  private async startChild(request: ChildStartRequest): Promise<PtcJsonValue> {
    this.requireActive()
    const callId = ++this.started
    const run = await this.subagents.start(this.provider, {
      prompt: [{ type: 'text', text: request.prompt }],
      parent: this.parent,
      signal: this.controller.signal,
      ...request.schema === undefined ? {} : { outputSchema: request.schema },
      ...request.provider === undefined && request.model === undefined ? {} : {
        agentOptions: {
          ...request.provider === undefined ? {} : { provider: request.provider },
          ...request.model === undefined ? {} : { model: request.model },
        },
      },
    })
    const record: ChildRecord = { callId, run }
    this.children.set(callId, record)
    // A provider can publish after the signal fired while startup was pending.
    if (this.controller.signal.aborted) {
      await this.disposeChild(record)
      throw new Error('workflow child started after cancellation')
    }
    return { callId, childId: run.id }
  }

  private async childResult(record: ChildRecord): Promise<PtcJsonValue> {
    const signal = this.controller.signal
    signal.throwIfAborted()
    const aborted = Promise.withResolvers<never>()
    const onAbort = (): void => { aborted.reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await Promise.race([record.run.result, aborted.promise])
      return json({
        output: result.output,
        stopReason: result.stopReason,
        ...result.structured === undefined ? {} : { structured: result.structured },
      })
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private disposeChild(record: ChildRecord): Promise<void> {
    record.disposal ??= Promise.resolve().then(() => record.run.dispose()).catch((error: unknown) => {
      this.ctx.logger.warn(`workflow-ptc: child dispose failed: ${renderThrown(error)}`)
    }).finally(() => {
      this.children.delete(record.callId)
    })
    return record.disposal
  }

  private onProgress(event: WorkflowProgress): void {
    this.requireActive()
    switch (event.type) {
      case 'phase': this.observer.phase(event.title); break
      case 'log': this.observer.log(event.message); break
      case 'agent-start':
        this.liveAgents.set(event.info.seq, event.info)
        this.observer.agentStart(event.info)
        break
      case 'agent-end': this.endAgent(event.info); break
      /* v8 ignore next -- progress() validates the closed message union before dispatch. */
      default: assertNever(event, 'workflow progress')
    }
  }

  private endAgent(info: WorkflowAgentEndInfo): void {
    if (!this.liveAgents.delete(info.seq)) return
    this.observer.agentEnd(info)
  }

  private cancelled(): WorkflowResult {
    return { value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${this.cancelReason}`, agentsStarted: this.started }
  }

  private async drive(): Promise<WorkflowResult> {
    let result: WorkflowResult
    try {
      const outcome = await this.runtime.run(this.runtime.resolve({
        program: PROGRAM,
        bindings: [{ global: 'workflowHost', functions: this.bindings() }],
        cwd: this.policy.workspaceRoot,
        sandboxPolicy: this.policy,
        timeoutMs: null,
        signal: this.controller.signal,
      }))
      this.terminal = true
      if (this.cancelReason !== undefined) result = this.cancelled()
      else if (outcome.error !== undefined) result = { value: null, stopReason: 'error', error: `workflow execution failed (${outcome.error.kind}): ${outcome.error.message}`, agentsStarted: this.started }
      else result = workflowResult(outcome.value)
    } catch (error: unknown) {
      this.terminal = true
      result = this.cancelReason === undefined
        ? { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: this.started }
        : this.cancelled()
    } finally {
      this.terminal = true
      this.signal?.removeEventListener('abort', this.externalAbort)
      this.controller.abort('workflow settled')
      // Disposing published children releases binding waits; pending starts may publish more.
      for (const record of this.children.values()) void this.disposeChild(record)
      while (this.pending.size > 0) await Promise.allSettled([...this.pending])
      await Promise.all([...this.children.values()].map(record => this.disposeChild(record)))
      this.children.clear()
      for (const info of this.liveAgents.values()) this.endAgent({ ...info, outcome: 'cancelled' })
    }
    return result
  }
}
