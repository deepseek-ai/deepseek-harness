/** Turn-owned admission and acknowledged cleanup for providers implementing held input. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NativeError, type NativeClient } from './native-client.ts'

class InputTurn {
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  private client?: NativeClient
  private removeCleanup?: () => void
  private closing?: Promise<void>

  constructor(readonly agent: Agent, readonly turn: number, signal: AbortSignal,
    private readonly failed: (error: unknown) => void) {
    this.signal = AbortSignal.any([signal, this.controller.signal])
  }

  track(client: NativeClient): void {
    this.signal.throwIfAborted()
    if (this.client && this.client !== client) {
      throw new NativeError('INPUT_CONNECTION_CHANGED', 'Held input belongs to the original connection; finish this turn before selecting another connection')
    }
    if (!this.client) {
      this.removeCleanup = client.registerCleanup(canRequest => this.close(canRequest))
      this.client = client
    }
  }

  close(canRequest = true): Promise<void> {
    this.controller.abort()
    return this.closing ??= Promise.resolve().then(async () => {
      try {
        if (!this.client) return
        if (!canRequest) throw new NativeError('INPUT_CLEANUP_UNCONFIRMED', 'Native connection closed before turn input cleanup was confirmed. Input is disabled for this task; start a new task after checking the desktop')
        await this.client.requestCleanup('releaseHeldInputs', { taskId: this.agent.id, turn: this.turn })
      } catch (error) {
        this.failed(error)
        throw error
      } finally {
        this.removeCleanup?.()
      }
    })
  }
}

/** A provider opts in only when its helper implements the turn-owned input protocol. */
export class CuaInputTurns {
  private readonly turns = new WeakMap<Agent, InputTurn>()
  private readonly failures = new WeakMap<Agent, unknown>()

  /** @param ctx - Provider scope owning the lifecycle listeners. */
  constructor(private readonly ctx: Context) {
    ctx.on('agent/pre-step', (event, next) => {
      if (this.turns.get(event.agent)?.turn !== event.turn) {
        this.turns.set(event.agent, new InputTurn(event.agent, event.turn, event.signal, (error) => {
          this.failures.set(event.agent, error)
          ctx.logger.error('CUA input cleanup was not confirmed; input is disabled for task %s: %s', event.agent.id, error)
        }))
      }
      return next()
    })
    ctx.on('agent/turn-finalizing', ({ agent, turn }) => {
      const owner = this.turns.get(agent)
      if (owner?.turn === turn) return owner.close()
    })
  }

  /**
   * Resolve admission for the current turn; a failed cleanup blocks further CUA dispatch.
   * @param agent - Task issuing the operation.
   * @returns Turn signal and native ownership, or undefined before a turn starts.
   */
  scope(agent: Agent): InputTurn | undefined {
    if (this.failures.has(agent)) {
      throw new NativeError('INPUT_CLEANUP_UNCONFIRMED', 'CUA input cleanup was not confirmed. Input is disabled for this task; start a new task after checking the desktop', { cause: this.failures.get(agent) })
    }
    const boundary = this.ctx.agents.turnBoundaryOf(agent.session)
    if (boundary.openTurnStartSeq === null) return undefined
    const owner = this.turns.get(agent)
    return owner?.turn === boundary.lastTurn ? owner : undefined
  }
}
