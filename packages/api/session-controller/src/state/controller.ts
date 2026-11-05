/** Passive Session state, coalesced observations and quiescence waits. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { HistoryController } from '../history/controller.ts'
import { DEFAULT_MAX_MESSAGES, rejectNotFound } from '../history.ts'
import type { SessionPendingInput, SessionQueuedItem, SessionState, SessionStateRequest, SessionWaitRequest, SessionWaitValue } from '../types.ts'

import { StateListener } from './listener.ts'
import type { VersionedSessionState } from './listener.ts'

const DEFAULT_WAIT_TIMEOUT_MS = 30_000

/** Reads and waits without activating or cancelling Session execution. */
export class StateController {

  /**
   * @param ctx - live Session and pending Remote event services.
   * @param historyController - passive read entry used for cold state and its bounded output.
   */
  constructor(private readonly ctx: Context, private readonly historyController: HistoryController) {}

  /**
   * Read passive execution and pending-input state.
   * @param request - Session identity.
   * @param signal - read cancellation.
   * @returns current passive state.
   */
  async state(request: SessionStateRequest, signal: AbortSignal): Promise<SessionState> {
    return this.readState(request.sessionId, signal)
  }

  /**
   * Observe complete passive state replacements.
   * @param request - Session identity.
   * @param signal - observation cancellation.
   * @returns complete state replacements, starting with the current state.
   */
  async *observeState(request: SessionStateRequest, signal: AbortSignal): AsyncIterable<SessionState> {
    using listener = this.listen(request.sessionId, signal)
    for await (const { state } of listener.observeStates()) yield state
  }

  /**
   * Wait for quiescence, pending input, or the deadline without cancelling execution.
   * @param request - Session identity, timeout and assistant output window.
   * @param signal - cancellation of this wait only, never of Agent execution.
   * @returns the stopping reason and last complete state; no state before timeout is an error.
   */
  async wait(request: SessionWaitRequest, signal: AbortSignal): Promise<SessionWaitValue> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const afterSeq = request.afterSeq ?? -1
    const maxMessages = request.maxMessages ?? DEFAULT_MAX_MESSAGES
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || Object.is(afterSeq, -0)) {
      throw new RemoteError('gateway/bad-request', 'afterSeq must be an integer greater than or equal to -1', {})
    }
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
      throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
      throw new RemoteError('gateway/bad-request', 'timeoutMs must be a positive supported timer delay', {})
    }
    using timer = deadline(signal, timeoutMs, 'session/wait-timeout')
    using listener = this.listen(request.sessionId, timer.signal)
    const sessionId = request.sessionId
    const statesGenerator = listener.observeStates(1_000)
    let nextStatePromise = statesGenerator.next()
    let currentState: SessionState | undefined
    let reason: SessionWaitValue['reason'] = 'timeout'
    try {
      for (;;) {
        const observedState = await nextStatePromise
        if (observedState.done) {
          timer.signal.throwIfAborted()
          throw new RemoteError('session/observation-ended', 'Session observation ended before a stopping state', {})
        }
        nextStatePromise = statesGenerator.next()
        // Observe rejection on immediate exits without replacing the original demand.
        void nextStatePromise.catch(() => undefined)
        // Only a state the listener still confirms may drive this wait; an invalidated
        // sample never becomes the state a timeout reports.
        if (!listener.isCurrent(observedState.value.revision)) continue
        currentState = observedState.value.state
        const action = computeWaitAction(currentState)
        if (action === 'continue') continue
        if (action === 'input-required' || action === 'idle') {
          reason = action
          break
        }

        const agent = this.ctx.agents.get(sessionId)
        if (agent === undefined || this.ctx.sessions.get(sessionId) !== agent.session) continue
        if (await waitForIdleOrStateChange(agent, nextStatePromise) === 'state-changed') continue
        if (!listener.isCurrent(observedState.value.revision) || this.ctx.agents.get(sessionId) !== agent
          || this.ctx.sessions.get(sessionId) !== agent.session) continue
        reason = 'idle'
        break
      }
    } catch (error: unknown) {
      // A caller cancellation is never a wait outcome; the deadline absorbs only the read
      // it cancelled, and any other failure keeps its own error.
      if (signal.aborted) throw signal.reason
      if (!expired(timer.signal, error)) throw error
    } finally {
      // Wake/cancel a pending read before asking the generator to return.
      listener[Symbol.dispose]()
      await nextStatePromise.catch(() => undefined)
      await statesGenerator.return(undefined)
    }
    signal.throwIfAborted()
    if (currentState === undefined) throw new RemoteError('session/wait-timeout', 'No Session state arrived before the wait deadline', {})
    const output = await this.historyController.assistantOutput(
      sessionId, afterSeq, currentState.cursor, maxMessages, signal,
    )
    return { reason, state: currentState, output }
  }

  private listen(sessionId: SessionId, signal: AbortSignal): StateListener {
    return new StateListener(this.ctx, sessionId, signal, readSignal => this.readState(sessionId, readSignal))
  }

  /**
   * @param sessionId - Session to sample.
   * @param signal - read cancellation.
   * @param retried - whether a live source already redirected this read once.
   * @returns one passive state sample.
   */
  private async readState(sessionId: SessionId, signal: AbortSignal, retried = false): Promise<SessionState> {
    signal.throwIfAborted()
    const agent = this.ctx.agents.get(sessionId)
    if (agent !== undefined) {
      if (agent.session.header.cwd === undefined) rejectNotFound({ kind: 'session', sessionId })
      return {
        cursor: agent.session.seq - 1,
        active: true,
        running: agent.status === 'running',
        queue: queueItems(agent),
        pendingInput: this.pendingInput(agent.session.id),
      }
    }
    const state = await this.historyController.usingObservation({ sessionId, projection: false }, signal, (observation) => {
      // A live source means the Session attached during this read; report its live state
      // rather than a live cursor paired with an inactive sample.
      if (!retried && observation.source === 'live') return undefined
      if (observation.header.cwd === undefined) rejectNotFound({ kind: 'session', sessionId })
      return {
        cursor: observation.cursor,
        active: false,
        running: false,
        queue: null,
        pendingInput: this.pendingInput(observation.header.id),
      }
    })
    signal.throwIfAborted()
    return state ?? this.readState(sessionId, signal, true)
  }

  private pendingInput(sessionId: SessionId): readonly SessionPendingInput[] {
    const kinds = new Set<SessionPendingInput>()
    for (const { event, agentId } of this.ctx.typertGateway.getPendingRemoteEvents()) {
      if (String(agentId) !== sessionId) continue
      kinds.add(event === 'approval/request' ? 'approval' : event === 'user-questions/request' ? 'question' : 'other')
    }
    return [...kinds]
  }
}

/**
 * @param signal - wait deadline signal.
 * @param error - failure raised by the in-flight read.
 * @returns whether the deadline expired and cancelled that read.
 */
function expired(signal: AbortSignal, error: unknown): boolean {
  const reason = timeoutOf(signal, 'session/wait-timeout')
  if (reason === undefined) return false
  // Cancellation carries the deadline reason along its cause chain; any other failure does not.
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current === reason || current.cause === reason) return true
    current = current.cause
  }
  return error === reason
}

/** Choose the next wait action; check-idle requires the caller's whenIdle and identity checks. */
function computeWaitAction(state: SessionState): 'input-required' | 'continue' | 'idle' | 'check-idle' {
  if (state.pendingInput.length > 0) return 'input-required'
  if (state.running) return 'continue'
  if (!state.active) return 'idle'
  return 'check-idle'
}

/** Wait for either driver quiescence or the already-armed next state; preserve rejections from both. */
function waitForIdleOrStateChange(
  agent: Agent,
  nextStatePromise: Promise<IteratorResult<VersionedSessionState>>,
): Promise<'idle' | 'state-changed'> {
  return Promise.race([
    agent.whenIdle().then(() => 'idle' as const),
    nextStatePromise.then(() => 'state-changed' as const),
  ])
}

function queueItems(agent: Agent): SessionQueuedItem[] {
  const item = (message: UserMessage, placement: SessionQueuedItem['placement']): SessionQueuedItem => ({
    id: message.id,
    placement,
    ...message.source.kind === 'user' && 'rpcId' in message.source ? { rpcId: message.source.rpcId } : {},
    content: message.content as typeof message.content & readonly JsonValue[],
  })
  return [
    ...agent.inbox.nextTurn.map(message => item(message, 'queued')),
    ...agent.inbox.nextStep.map(message => item(message, message.source.kind === 'user' ? 'steering' : 'context')),
  ]
}
