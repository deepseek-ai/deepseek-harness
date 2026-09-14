/**
 * Service Definition for the workflow capability seam. Service Providers execute orchestration scripts;
 * observe-only lifecycle events never expose run control.
 * @module @deepseek-ai/dsh-workflow
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowResultInfo,
  WorkflowRunInfo,
} from './types.ts'
import type { WorkflowRun, WorkflowStartRequest } from './runtime-types.ts'

export { WorkflowRunId } from './types.ts'
export type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowAgentOutcome,
  WorkflowMeta,
  WorkflowPhase,
  WorkflowResult,
  WorkflowResultInfo,
  WorkflowRunInfo,
  WorkflowStopReason,
} from './types.ts'
export type { WorkflowRun, WorkflowStartRequest } from './runtime-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowEngine: WorkflowEngine
  }

  interface Events {
    /**
     * A workflow run started — the script's meta block validated, the body
     * about to execute. Paired with {@link Events['workflow/end']}.
     * @param info - the run's identity snapshot (id + meta).
     * @mode emit
     */
    'workflow/start'(info: WorkflowRunInfo): void
    /**
     * The script entered a phase (a `phase(title)` call) — progress grouping
     * for observers; no execution semantics.
     * @param info - the run's identity snapshot.
     * @param title - the phase title, verbatim.
     * @mode emit
     */
    'workflow/phase'(info: WorkflowRunInfo, title: string): void
    /**
     * The script emitted a narration line (a `log(message)` call).
     * @param info - the run's identity snapshot.
     * @param message - the logged message, verbatim.
     * @mode emit
     */
    'workflow/log'(info: WorkflowRunInfo, message: string): void
    /**
     * One `agent()` call established a published child run. Paired with
     * {@link Events['workflow/agent-end']} by `agent.seq`. A call that never
     * receives a published run from the provider emits neither
     * event in this pair.
     * @param info - the run's identity snapshot.
     * @param agent - the call's sequence number, label, phase, and child id.
     * @mode emit
     */
    'workflow/agent-start'(info: WorkflowRunInfo, agent: WorkflowAgentInfo): void
    /**
     * One `agent()` call settled (clean result, child failure, or run
     * cancellation). Paired with {@link Events['workflow/agent-start']} by
     * `agent.seq`, exactly once per started call on every stop path — on an
     * engine termination path the end is
     * engine-synthesized with outcome `'cancelled'`.
     * @param info - the run's identity snapshot.
     * @param agent - the call identity plus its outcome.
     * @mode emit
     */
    'workflow/agent-end'(info: WorkflowRunInfo, agent: WorkflowAgentEndInfo): void
    /**
     * A workflow run settled (any stop reason). Fired when
     * {@link WorkflowRun.result} resolves. Paired with
     * {@link Events['workflow/start']}.
     * @param info - the run's identity snapshot.
     * @param result - the outcome data (stop reason, error, agent count) —
     *   deliberately WITHOUT the result value (see {@link WorkflowResultInfo}).
     * @mode emit
     */
    'workflow/end'(info: WorkflowRunInfo, result: WorkflowResultInfo): void
  }
}

/** The full set of `workflow/*` event names {@link WorkflowEngine.emitWorkflowEvent} dispatches. */
export type WorkflowEventName =
  | 'workflow/start'
  | 'workflow/phase'
  | 'workflow/log'
  | 'workflow/agent-start'
  | 'workflow/agent-end'
  | 'workflow/end'

/**
 * Machine-routable fatal workflow failures: parse/meta/argument/schema errors,
 * resource caps, subagent infrastructure failures, unserializable boundary
 * values, and cancellation. An ordinary child failure resolves its item to
 * `null` and is not one of these fatal codes.
 */
export type WorkflowErrorCode =
  | 'SCRIPT_PARSE'
  | 'META_INVALID'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_OPTION'
  | 'UNSUPPORTED_SCHEMA'
  | 'AGENT_CAP'
  | 'ITEM_CAP'
  | 'AGENT_START'
  | 'AGENT_RESULT'
  | 'RESULT_UNSERIALIZABLE'
  | 'CANCELLED'

/**
 * Typed error for workflow-seam failures. Extends {@link HarnessError}, so the
 * `code` is machine-routable taxonomy. `fatal` drives the combinator
 * discipline: `parallel()`/`pipeline()` re-throw a fatal error (a typo'd
 * option or a tripped cap must kill the script loudly), and reserve the
 * per-item `null` for child-run failures and ordinary in-stage script errors.
 * Every {@link WorkflowErrorCode} is fatal; the flag exists so the
 * distinction is explicit at every catch site rather than implied.
 */
export class WorkflowError extends HarnessError {
  /** Whether combinators must propagate this error instead of nulling the item. */
  readonly fatal: boolean

  constructor(message: string, code: WorkflowErrorCode, options?: ErrorOptions & { fatal?: boolean }) {
    super(message, code, options)
    this.name = 'WorkflowError'
    this.fatal = options?.fatal ?? true
  }
}

/**
 * Whether combinators must re-throw `error` instead of mapping the item to `null`.
 * @param error - any thrown value; fatality is host `instanceof` (unforgeable from a script realm).
 * @returns true iff `error` is a {@link WorkflowError} whose `fatal` flag is set.
 */
export function isFatalWorkflowError(error: unknown): boolean {
  return error instanceof WorkflowError && error.fatal
}

/**
 * Workflow Service Definition contract. Invalid requests throw before publication; a live
 * run is holder-owned, its result never rejects, and disposal waits for script
 * and child cleanup. Lifecycle
 * listener failures are contained, and `workflow/end` fires exactly once as the
 * result settles.
 */
export abstract class WorkflowEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflowEngine')
  }

  /**
   * Parse and execute a workflow script.
   * @param request - the script, its `args`, the parent agent, and an
   *   optional cancel signal.
   * @returns the live run; its `result` resolves when the script settles.
   */
  abstract start(request: WorkflowStartRequest): WorkflowRun

  /**
   * Emit a lifecycle event while containing and logging each listener failure.
   * @param name - the `workflow/*` event to dispatch.
   * @param args - the event's payload, matching its declared signature.
   */
  protected emitWorkflowEvent(name: WorkflowEventName, ...args: unknown[]): void {
    for (const callback of this.ctx.events.dispatch('emit', [name, ...args])) {
      try {
        const returned: unknown = (callback as (...payload: unknown[]) => unknown)(...args)
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`workflow: ${name} listener rejected: ${renderListenerError(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow: ${name} listener threw: ${renderListenerError(error)}`)
      }
    }
  }
}

/**
 * Render any thrown value without violating listener containment.
 * @param error - any thrown value.
 * @returns `String(error)`, or a fixed label when even coercion throws.
 */
function renderListenerError(error: unknown): string {
  try {
    return String(error)
  } catch {
    // String coercion itself may throw.
    return '[unrenderable thrown value]'
  }
}

export default WorkflowEngine
