/** Execution-period records, capacity slots, child serialization, and local output capture.
 * @module @deepseek-ai/dsh-subagent/activation
 */

import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { finalAssistantOutput } from './assistant-output.ts'
import { epochStopReason } from './lifecycle.ts'
import { SubagentError } from './error.ts'
import type { StructuredAttachment } from './structured.ts'
import type { SubagentResult, SubagentRun, SubagentRunId } from './types.ts'

/** Process-local capacity shared by every member of a subagent tree. */
export class ActivationPool {
  private readonly slots = new Set<symbol>()

  /**
   * Reserve before reconstruction; release also tolerates unpublished rollback.
   * @param capacity - the maximum simultaneous activations in this pool.
   * @returns an idempotent slot release.
   */
  reserve(capacity: number): () => void {
    if (this.slots.size >= capacity) {
      throw new SubagentError(
        `subagent limit reached (active child limit: ${capacity}); wait for an existing child to finish `
        + 'or complete this work with the current agents',
        'ACTIVATION_LIMIT_REACHED',
      )
    }
    const slot = Symbol()
    this.slots.add(slot)
    return () => { this.slots.delete(slot) }
  }
}

/**
 * One residency epoch for a local child or an external execution.
 * The manager owns admission, execution handles, and resource release.
 */
interface ActivationBase {
  /** Return this epoch's slot after its handle has finished disposal. */
  readonly releaseSlot: () => void
  /** The durable child this Activation is an epoch of. */
  readonly childId: SessionId
  /** Unique identity shared by this residency epoch's start/end event pair. */
  readonly runId: SubagentRunId
  /** Provider recorded at creation, retained across cold resumes. */
  readonly provider: string
  /** Exact live subagent tree root owning this instance and its shared capacity. */
  readonly root: Agent
  /** Verified creation ancestors, from subagent tree root to direct creator. */
  readonly ancestors: readonly SessionId[]
  /** Slash-separated names from the root; undefined when this child or a creator below the root has no name. */
  readonly path: string | undefined
  readonly delivery: 'parent' | 'caller'
  readonly result: PromiseWithResolvers<SubagentResult>
  /** Published synchronously before teardown; subsequent callers share this transaction. */
  closing: Promise<void> | undefined
  /**
   * Whether local input was accepted or external startup completed, including
   * any required catalog publication. Until then, teardown owes the parent no
   * settlement notice, even if this epoch's start event was already published.
   */
  accepted: boolean
}

/** Resources retained only for the selected execution kind. */
export type ActivationResource =
  | {
    readonly kind: 'local'
    readonly handle: AgentHandle
    readonly outputStart: SessionLogOffset
    readonly structured: StructuredAttachment | undefined
    /** Latest live failure not superseded by a later committed turn ending. */
    failureAt: SessionLogOffset | undefined
    /** Renewed when local settlement must recheck input. */
    poke: PromiseWithResolvers<void>
    /**
     * Whether this child's settlement notice omits its closing text: true while
     * the child's last logged tool call was a message to its direct parent and
     * no input was claimed since.
     */
    omitClosingText: boolean
  }
  | {
    readonly kind: 'external'
    readonly run: SubagentRun
    readonly controller: AbortController
  }

/** One managed execution period with its provider-specific resources. */
export type Activation = ActivationBase & ActivationResource

/** Local residency with input admission and Session-backed result capture. */
export type LocalActivation = Extract<Activation, { kind: 'local' }>

/**
 * Read the live Agent retained by local execution.
 * @param activation - the managed local or external execution.
 * @returns the local Agent, absent for an external run.
 */
export function activationAgent(activation: Activation): Agent | undefined {
  return activation.kind === 'local' ? activation.handle.agent : undefined
}

/**
 * Require local residency before accepting further input.
 * @param activation - execution targeted by message delivery.
 * @returns the local activation.
 * @throws when the external backend cannot accept another message.
 */
export function requireLocalActivation(activation: Activation): LocalActivation {
  switch (activation.kind) {
    case 'local': return activation
    case 'external':
      throw new SubagentError(`subagent "${activation.childId}" does not accept follow-up input`, 'NOT_CONTINUABLE')
    /* v8 ignore next 2 -- Both execution kinds are handled above. */
    default: return assertNever(activation)
  }
}

/**
 * Retain local failures whose turn ending could not be committed.
 * @param activation - exact local Agent and epoch receiving the scoped observers.
 * @param wake - notify its settlement watcher when failure changes readiness.
 */
export function observeLocalFailure(activation: LocalActivation, wake: () => void): void {
  const child = activation.handle.agent
  child.ctx.on('agent/error', ({ agent }) => {
    if (agent !== child) return
    activation.failureAt = child.session.seq
    wake()
  })
  child.ctx.on('session/event', (session, event) => {
    if (session === child.session && event.type === 'turn/end'
      && activation.failureAt !== undefined && event.seq >= activation.failureAt) {
      activation.failureAt = undefined
    }
  })
}

/**
 * Capture local output and retain failures without a later committed turn ending.
 * @param activation - the settled local execution and any structured result.
 * @returns final output, stop reason, and committed structured value.
 */
export function captureLocalResult(activation: LocalActivation): SubagentResult {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = activation.handle.agent.session.snapshotEvents(activation.outputStart)
  const output = finalAssistantOutput(events) ?? []
  const stopReason = activation.failureAt === undefined ? epochStopReason(events) : 'error'
  const structured = activation.structured
  if (structured !== undefined) {
    const captured = structured.captured()
    if (captured !== undefined) return { output, stopReason, structured: captured.value }
    if (stopReason === 'completed') return { output, stopReason: 'error' }
  }
  return { output, stopReason }
}

/** Serialize each durable child's delivery, release, and disposal. */
export class ChildLock {
  private tails = new Map<SessionId, Promise<unknown>>()

  /**
   * Run `operation` after every previously queued operation for `childId`.
   * @param childId - the durable child whose operations are linearized.
   * @param operation - the critical section to run in order.
   * @returns the operation's own settlement.
   */
  run<T>(childId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(childId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    // Absorb rejections in the chaining tail so one failed critical section
    // cannot reject an unrelated later caller.
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(childId, tail)
    void tail.then(() => {
      if (this.tails.get(childId) === tail) this.tails.delete(childId)
    })
    return result
  }
}
