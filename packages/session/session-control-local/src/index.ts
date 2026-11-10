/**
 * Current-runtime delivery and cold activation for independent Sessions.
 * @module @deepseek-ai/dsh-session-control-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentSetup } from '@deepseek-ai/dsh-agent'
import { AgentInputClosedError, installModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionControlError } from '@deepseek-ai/dsh-session-control'
import type { SessionControlContext, SessionDeliveryRequest, SessionMessageReceipt } from '@deepseek-ai/dsh-session-control'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionControlLocal: SessionControlLocalProvider
  }
}

/** Resolved deployment preset and setup for a fresh ordinary Agent scope. */
export interface OrdinarySessionComposition {
  /** Preset identity, absent when the deployment has no preset registry. */
  readonly agentPreset?: string
  /** Composition performed before Agent publication. */
  readonly setup: AgentSetup
}

/** Local delivery owner and caller-owned ordinary Session activation. */
export class SessionControlLocalProvider extends Service {
  static inject = ['sessionControl', 'agents', 'sessions', 'sessionQuery', 'agentDefaultModel']
  private readonly handles = new Map<Agent, AgentHandle>()

  constructor(ctx: Context) {
    super(ctx, 'sessionControlLocal')
  }

  protected [Service.init](): void {
    this.ctx.on('agent/disposed', ({ agent }) => { this.handles.delete(agent) }, { global: true })
    const unregister = this.ctx.sessionControl.register({
      deliver: (request, runtime) => this.deliver(request, runtime),
    })
    this.ctx.effect(() => async () => {
      await unregister()
      const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
      this.handles.clear()
      const failures: unknown[] = []
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Session control failed to release restored Agents')
    })
  }

  /**
   * Resolve the preset and its unpublished setup without starting an Agent.
   * @param presetId - requested preset, or the deployment default when omitted.
   * @returns resolved preset identity and scoped setup.
   */
  async compose(presetId: string | undefined): Promise<OrdinarySessionComposition> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (agentCtx) => { installModelSelection(agentCtx) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  /**
   * Supply live deployment defaults until a Session records its own model selection.
   * @returns accessors that read the current default route when the Agent needs it.
   */
  defaultOptions(): AgentOptions {
    const defaults = this.ctx.agentDefaultModel
    return {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
  }

  /**
   * Read the current preset from an exact projected Session observation.
   * @param observation - retained observation carrying the registered projections.
   * @returns the recorded preset, or undefined when none is recorded.
   * @throws when the observation omits its projection snapshot.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }

  /**
   * Restore an ordinary Session with its recorded preset and deployment defaults.
   * The caller retains the observation until this resolves. Its calling Context
   * owns the returned handle and disposes it on unload. Cancellation covers
   * acquisition and setup, never later Agent work.
   * @param observation - exact retained Session observation used to select its preset.
   * @param signal - cancellation before the Agent handle is returned.
   * @returns the acquired Agent handle; callers must retain or dispose it.
   * @throws SessionControlError when subagent routing owns the identity.
   */
  async resumeObserved(observation: SessionObservation, signal?: AbortSignal): Promise<AgentHandle> {
    signal?.throwIfAborted()
    const sessionId = observation.header.id
    const rejectSubagent = (): never => {
      throw new SessionControlError(
        `session "${sessionId}" is owned by subagent routing`,
        'SESSION_CONTROL_SUBAGENT_OWNED',
      )
    }
    if (observation.header.origin === 'subagent') rejectSubagent()
    const composition = await this.compose(this.presetForObservation(observation))
    signal?.throwIfAborted()
    if (this.ctx.sessions.get(sessionId)?.header.origin === 'subagent') rejectSubagent()
    return this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.defaultOptions(),
      setup: composition.setup,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  private assertAdmission(id: SessionId, runtime: SessionControlContext): void {
    runtime.signal.throwIfAborted()
    if (this.ctx.agents.get(runtime.caller.id) !== runtime.caller) {
      throw new SessionControlError('the sending Agent is no longer live', 'SESSION_CONTROL_CALLER_UNAVAILABLE')
    }
    if (this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(id) === true) {
      throw new SessionControlError(`session "${id}" is archived; unarchive it before sending a message`, 'SESSION_CONTROL_ARCHIVED')
    }
  }

  private independent(agent: Agent): Agent {
    if (agent.session.header.origin === 'subagent') {
      throw new SessionControlError(
        `session "${agent.id}" is a subagent; use send_message with its agent name`,
        'SESSION_CONTROL_SUBAGENT_OWNED',
      )
    }
    return agent
  }

  private async target(id: SessionId, runtime: SessionControlContext): Promise<{ agent: Agent; acquired?: AgentHandle }> {
    const live = this.ctx.agents.get(id)
    if (live !== undefined) return { agent: this.independent(live) }
    try {
      using observation = await this.ctx.sessionQuery.observeSession(id, { signal: runtime.signal })
      this.assertAdmission(id, runtime)
      const raced = this.ctx.agents.get(id)
      if (raced !== undefined) return { agent: this.independent(raced) }
      const handle = await this.resumeObserved(observation, runtime.signal)
      return { agent: handle.agent, acquired: handle }
    } catch (error: unknown) {
      runtime.signal.throwIfAborted()
      if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new SessionControlError(`session "${id}" was not found`, 'SESSION_CONTROL_NOT_FOUND', { cause: error })
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        const raced = this.ctx.agents.get(id)
        if (raced !== undefined) return { agent: this.independent(raced) }
        throw new SessionControlError(`session "${id}" has another writer`, 'SESSION_CONTROL_WRITER_HELD', { cause: error })
      }
      if (error instanceof HarnessError) throw error
      throw new SessionControlError(`session "${id}" could not be restored`, 'SESSION_CONTROL_RESTORE_FAILED', { cause: error })
    }
  }

  private async deliver(request: SessionDeliveryRequest, runtime: SessionControlContext): Promise<SessionMessageReceipt> {
    this.assertAdmission(request.id, runtime)
    const { agent: target, acquired } = await this.target(request.id, runtime)
    try {
      this.assertAdmission(request.id, runtime)
      this.independent(target)
      if (this.ctx.agents.get(target.id) !== target) {
        throw new SessionControlError(`session "${target.id}" closed before accepting the message`, 'SESSION_CONTROL_INPUT_CLOSED')
      }
      target.steer(request.message)
    } catch (error: unknown) {
      if (acquired !== undefined) {
        try {
          await acquired.dispose()
        } catch (releaseError: unknown) {
          throw new SessionControlError(
            `session "${target.id}" did not accept the message and could not be released; inspect it before sending again`,
            'SESSION_CONTROL_RELEASE_FAILED',
            { cause: new AggregateError([error, releaseError]) },
          )
        }
      }
      if (error instanceof AgentInputClosedError) {
        throw new SessionControlError(`session "${target.id}" is closing; the message was not accepted`, 'SESSION_CONTROL_INPUT_CLOSED', { cause: error })
      }
      throw error
    }
    if (acquired !== undefined) this.handles.set(target, acquired)
    return { messageId: request.message.id }
  }
}

export default SessionControlLocalProvider
