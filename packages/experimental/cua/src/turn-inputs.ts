/** Turn-owned admission and acknowledged cleanup for providers implementing held input. */
import type { Context } from '@deepseek-ai/cordis'
import { emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { NativeError, type NativeClient } from './native-client.ts'

class InputTurn {
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  private client?: NativeClient
  private removeCleanup: (() => void) | undefined
  private closing?: Promise<void>

  constructor(readonly agent: Agent, readonly turn: number, signal: AbortSignal,
    private readonly failed: (error: unknown) => void) {
    this.signal = AbortSignal.any([signal, this.controller.signal])
  }

  /** installCua retains one Agent connection until its registered cleanup closes admission here. */
  track(client: NativeClient): void {
    this.signal.throwIfAborted()
    if (!this.client) {
      this.removeCleanup = client.registerCleanup(canRequest => this.close(canRequest))
      this.client = client
    }
  }

  get pending(): boolean { return this.removeCleanup !== undefined }

  /** Close reports and disables the failed owner; background and maintenance waits must still settle. */
  async settle(): Promise<void> {
    try { await this.close() }
    catch (_error) { /* close has reported the failure and disabled this task's CUA operations. */ }
  }

  close(canRequest = true): Promise<void> {
    this.controller.abort()
    return this.closing ??= Promise.resolve().then(async () => {
      try {
        if (!this.client) return
        if (!canRequest) throw new NativeError('INPUT_CLEANUP_UNCONFIRMED', 'Native connection closed before turn cleanup was confirmed. All CUA operations are disabled for this task; inspect the desktop manually before starting a new task')
        await this.client.requestCleanup('releaseHeldInputs', { taskId: this.agent.id, turn: this.turn })
      } catch (error) {
        this.failed(error)
        throw error
      } finally {
        this.removeCleanup?.()
        this.removeCleanup = undefined
      }
    })
  }
}

/** A provider opts in only when its helper implements the turn-owned input protocol. */
export class CuaInputTurns {
  private readonly turns = new WeakMap<Agent, InputTurn>()
  private readonly failures = new WeakMap<Agent, unknown>()

  /** @param ctx - Provider scope owning the lifecycle listeners. */
  constructor(private readonly ctx: Context) {}

  /**
   * Install turn admission, post-turn cleanup and whole-agent maintenance waits.
   * @returns Exact disposers for the runtime effect to retain through native cleanup.
   */
  *install(): Generator<() => void> {
    const ctx = this.ctx
    yield ctx.on('agent/pre-step', async (event, next) => {
      const previous = this.turns.get(event.agent)
      if (previous?.turn !== event.turn) {
        await previous?.settle()
        this.turns.set(event.agent, new InputTurn(event.agent, event.turn, event.signal, (error) => {
          this.failures.set(event.agent, error)
          ctx.logger.error('CUA cleanup was not confirmed; all CUA operations are disabled for task %s: %s', event.agent.id, error)
          emitAgentEvent(ctx, event.agent, 'agent/error', { turn: event.turn, step: 0, error })
        }))
      }
      return next()
    })
    yield ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.id)
      if (agent?.session !== session) return
      const owner = this.turns.get(agent)
      if (owner?.turn === event.data.turn) void owner.settle()
    })
    yield ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      const owner = this.turns.get(agent)
      if (!owner?.pending) return
      // Claim the idle phase before notification consumers submit more work. whenIdle follows maintenance.
      void agent.runMaintenance(() => owner.settle())
    }, { prepend: true })
  }

  /**
   * Wait for an ended turn before a direct CUA operation can acquire the connection.
   * @param agent - Task issuing the operation.
   * @returns Completion after cleanup has settled and any failure has been reported.
   */
  async ready(agent: Agent): Promise<void> {
    const owner = this.turns.get(agent)
    if (owner?.controller.signal.aborted) {
      await owner.settle()
    }
  }

  /**
   * Resolve admission for the current turn; a failed cleanup blocks further CUA dispatch.
   * @param agent - Task issuing the operation.
   * @returns Turn signal and native ownership, or undefined before a turn starts.
   */
  scope(agent: Agent): InputTurn | undefined {
    if (this.failures.has(agent)) {
      throw new NativeError('INPUT_CLEANUP_UNCONFIRMED', 'CUA cleanup was not confirmed. All CUA operations are disabled for this task; inspect the desktop manually before starting a new task', { cause: this.failures.get(agent) })
    }
    const boundary = this.ctx.agents.turnBoundaryOf(agent.session)
    if (boundary.openTurnStartSeq === null) return undefined
    const owner = this.turns.get(agent)
    return owner?.turn === boundary.lastTurn ? owner : undefined
  }
}
