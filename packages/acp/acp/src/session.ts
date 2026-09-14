/** One standard ACP session's Agent, configuration, prompt, update, and teardown lifecycle. */

import type { Context } from '@deepseek-ai/cordis'
import {
  RequestError,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle, AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, type UserMessage } from '@deepseek-ai/dsh-llm'
import { type Session, type SessionEvent, type SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { AcpContentError, admitAcpPrompt } from './content.ts'
import { turnEndToStopReason } from './codec.ts'
import { mountAcpMcpServers } from './mcp.ts'
import { AcpModelControl } from './model-control.ts'
import { assistantUpdates, toolCallUpdate, toolResultUpdate } from './updates.ts'

/** The continuable-subagent teardown used without depending on the subagent package. */
interface ContinuableDrain {
  /** Dispose continuable descendants below exact host-owned parents child-first. */
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/** Inputs shared by fresh and resumed ACP session construction. */
interface AcpSessionBuildOptions {
  cwd: string
  mcpServers: readonly McpServer[]
  agentOptions: AgentOptions
  fallbackSelection: ModelSelection | undefined
  signal: AbortSignal
  notify: (notification: SessionNotification) => Promise<void>
}

/** Fresh ACP session construction inputs. */
export interface CreateAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

/** Persisted ACP session construction inputs. */
export interface ResumeAcpSessionOptions extends AcpSessionBuildOptions {
  sessionId: SessionId
}

interface InflightPrompt {
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string | undefined
  messageQueued: boolean
  turn: number | undefined
  endReason: TurnEndReason | undefined
  admissionDone: Promise<void>
  finishAdmission: () => void
  admissionController: AbortController
  cancelRequested: boolean
  settlementStarted: boolean
  outputError: Error | undefined
  agentError: Error | undefined
}

/** Standard invalid-parameter failure with protocol-safe detail. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** Standard internal failure with protocol-safe detail. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Restore the latest logged route before falling back to deployment config. */
function selectionFor(
  logged: {
    config: { provider: string; model: string; reasoningEffort?: ModelSelection['reasoningEffort'] }
    adapterDefaults?: { reasoningEffort?: boolean }
  } | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  return logged === undefined
    ? fallback
    : {
      provider: logged.config.provider,
      model: logged.config.model,
      ...logged.config.reasoningEffort === undefined || logged.adapterDefaults?.reasoningEffort === true
        ? {}
        : { reasoningEffort: logged.config.reasoningEffort },
    }
}

/**
 * Per-session ACP module. It owns the unpublished Agent composition, selected
 * route, one-prompt admission slot, ordered standard updates, and memoized
 * quiescent teardown.
 */
export class AcpSession {
  /** The exact top-level Agent owned by this ACP session. */
  readonly agent: Agent
  private readonly modelControl: AcpModelControl
  private outputTail = Promise.resolve()
  private inflight: InflightPrompt | undefined
  private closing: Promise<void> | undefined
  private readonly pendingSelections = new Map<string, ModelSelection>()

  private constructor(
    private readonly ctx: Context,
    handle: AgentHandle,
    modelControl: AcpModelControl,
    private readonly notify: (notification: SessionNotification) => Promise<void>,
  ) {
    this.agent = handle.agent
    this.modelControl = modelControl
    this.disposeAgent = () => handle.dispose()
  }

  private readonly disposeAgent: () => Promise<void>

  /**
   * Compose a fresh Agent and all requested MCP clients before publication.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - fresh session identity, workspace, route, MCP, and notifier.
   * @returns the fully composed per-session module.
   */
  static async create(ctx: Context, options: CreateAcpSessionOptions): Promise<AcpSession> {
    const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection)
    const handle = await ctx.agents.create({
      sessionId: options.sessionId,
      meta: { cwd: options.cwd },
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx) => {
        modelControl.install(agentCtx)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    return new AcpSession(ctx, handle, modelControl, options.notify)
  }

  /**
   * Restore a persisted Agent and compose the request's fresh MCP connections.
   * @param ctx - ACP plugin context with Agent, LLM, and persistence services.
   * @param options - persisted identity, workspace, fallback route, MCP, and notifier.
   * @returns the restored per-session module.
   */
  static async resume(ctx: Context, options: ResumeAcpSessionOptions): Promise<AcpSession> {
    let modelControl: AcpModelControl | undefined
    const handle = await ctx.agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      signal: options.signal,
      setup: async (agentCtx, agent) => {
        modelControl = new AcpModelControl(
          ctx.llm,
          selectionFor(agent.session.requestHeader(), options.fallbackSelection),
        )
        modelControl.install(agentCtx)
        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd)
      },
    })
    /* v8 ignore start -- a fulfilled Agent resume necessarily ran setup to completion. */
    if (modelControl === undefined) {
      await handle.dispose()
      throw internalError('session/resume did not compose model selection')
    }
    /* v8 ignore stop */
    return new AcpSession(ctx, handle, modelControl, options.notify)
  }

  /**
   * Whether this module owns an exact Agent reference.
   * @param agent - Agent observed on a scoped runtime event.
   * @returns true only for this session's owned Agent.
   */
  owns(agent: Agent): boolean {
    return this.agent === agent
  }

  /**
   * Whether this module owns an exact Session reference.
   * @param session - Session observed on a durable event.
   * @returns true only for this session's owned Session.
   */
  ownsSession(session: Session): boolean {
    return this.agent.session === session
  }

  /**
   * Return the complete standard model configuration state.
   * @param signal - optional request cancellation.
   * @returns provider-grouped model and exact-model reasoning options.
   */
  configOptions(signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.options(signal)
  }

  /**
   * Apply one standard configuration option to later ACP turns.
   * @param configId - advertised standard option id.
   * @param value - selected standard option value.
   * @param signal - optional request cancellation.
   * @returns the complete resulting option state.
   */
  setConfig(configId: string, value: unknown, signal?: AbortSignal): Promise<SessionConfigOption[]> {
    this.assertActive()
    return this.modelControl.set(configId, value, signal)
  }

  /** Resolve topology state off-chain, then serialize its notification without blocking execution updates. */
  topologyChanged(): void {
    if (this.closing !== undefined) return
    void this.modelControl.options()
      .then((configOptions) => {
        if (this.closing !== undefined) return
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({
            sessionId: this.agent.session.id,
            update: { sessionUpdate: 'config_option_update', configOptions },
          }))
          /* v8 ignore start -- the bridge notifier contains transport failure. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      })
      /* v8 ignore start -- option discovery contains per-provider failure. */
      .catch((error: unknown) => {
        this.ctx.logger.warn(`acp: config-option update failed: ${errorChain(error)}`)
      })
    /* v8 ignore stop */
  }

  /**
   * Admit, enqueue, and settle one prompt at whole-Agent quiescence.
   * @param params - standard ACP prompt request for this session.
   * @param imageEnabled - connection capability advertised at initialization.
   * @param requestSignal - JSON-RPC request cancellation signal.
   * @returns the correlated standard stop reason after ordered updates drain.
   */
  async prompt(
    params: PromptRequest,
    imageEnabled: boolean,
    requestSignal?: AbortSignal,
  ): Promise<PromptResponse> {
    this.assertActive()
    if (this.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
    const completion = Promise.withResolvers<StopReason>()
    const admission = Promise.withResolvers<void>()
    const admissionController = new AbortController()
    const inflight: InflightPrompt = {
      resolve: completion.resolve,
      reject: completion.reject,
      messageId: undefined,
      messageQueued: false,
      turn: undefined,
      endReason: undefined,
      admissionDone: admission.promise,
      finishAdmission: admission.resolve,
      admissionController,
      cancelRequested: false,
      settlementStarted: false,
      outputError: undefined,
      agentError: undefined,
    }
    this.inflight = inflight
    const onRequestAbort = (): void => { this.cancelPrompt('ACP prompt request cancelled') }
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
    /* v8 ignore next -- the SDK dispatches a live signal, then notifies abort through its listener. */
    if (requestSignal?.aborted === true) onRequestAbort()
    try {
      let admissionFailure: unknown
      const promptSelection = this.modelControl.snapshot()
      try {
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const content = await admitAcpPrompt(
          this.ctx,
          promptSelection,
          params.prompt,
          imageEnabled,
          admissionController.signal,
        )
        admissionController.signal.throwIfAborted()
        if (this.ctx.agents.get(this.agent.id) !== this.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        inflight.messageId = message.id
        inflight.messageQueued = true
        if (promptSelection !== undefined) this.pendingSelections.set(message.id, promptSelection)
        try {
          this.agent.followup(message)
        } catch (error: unknown) {
          inflight.messageQueued = false
          this.pendingSelections.delete(message.id)
          throw error
        }
      } catch (error: unknown) {
        admissionFailure = error
      } finally {
        inflight.finishAdmission()
      }

      if (inflight.cancelRequested) {
        this.settleAfterQuiescence(inflight)
        return { stopReason: await completion.promise }
      }
      if (admissionFailure !== undefined) {
        this.inflight = undefined
        if (admissionFailure instanceof AcpContentError) {
          throw admissionFailure.kind === 'invalid'
            ? invalidParams(admissionFailure.message)
            : internalError(admissionFailure.message)
        }
        if (admissionFailure instanceof RequestError) throw admissionFailure
        throw internalError(`prompt was not queued: ${(admissionFailure as Error).message}`)
      }

      this.settleAfterQuiescence(inflight)
      return { stopReason: await completion.promise }
    } finally {
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }

  /** Cancel the active prompt, or autonomous work when no ACP prompt exists. */
  cancel(): void {
    const inflight = this.inflight
    this.cancelPrompt('ACP prompt cancelled')
    if (inflight === undefined) this.agent.cancel({ kind: 'user' })
  }

  /**
   * Process one durable event and enqueue its standard ACP projections.
   * @param session - exact event-owning Session.
   * @param event - committed durable event.
   */
  onSessionEvent(session: Session, event: SessionEvent): void {
    try {
      if (event.type === 'assistant/message') {
        const inflight = this.inflight?.turn === event.data.turn ? this.inflight : undefined
        const previous = this.outputTail
        const delivery = previous.then(async () => {
          for (const update of await assistantUpdates(this.ctx, session, event)) {
            await this.notify({ sessionId: this.agent.session.id, update })
          }
        })
        this.outputTail = delivery.catch((error: unknown) => {
          const failure = error as Error
          if (inflight !== undefined) inflight.outputError ??= failure
          this.ctx.logger.warn(`acp: assistant output conversion failed: ${errorChain(error)}`)
        })
      } else if (event.type === 'tool/call') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(() => this.notify({ sessionId: this.agent.session.id, update: toolCallUpdate(event) }))
          /* v8 ignore start -- the bridge notifier contains transport rejection. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      } else if (event.type === 'tool/result') {
        const previous = this.outputTail
        this.outputTail = previous
          .then(async () => this.notify({
            sessionId: this.agent.session.id,
            update: await toolResultUpdate(this.ctx, event),
          }))
          /* v8 ignore start -- supplemental-content conversion failure is contained and cannot fail Agent work. */
          .catch((error: unknown) => {
            this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`)
          })
        /* v8 ignore stop */
      }
    } finally {
      const inflight = this.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
      }
      if (event.type === 'turn/end') this.modelControl.releaseTurn(event.data.turn)
    }
  }

  /**
   * Correlate an accepted user message with its Agent turn and pinned route.
   * @param message - claimed durable inbox message.
   * @param turn - allocated Agent turn.
   */
  onInboxClaimed(message: UserMessage, turn: number): void {
    if (this.inflight !== undefined && this.inflight.messageId === message.id) this.inflight.turn = turn
    const selection = this.pendingSelections.get(message.id)
    this.pendingSelections.delete(message.id)
    if (selection !== undefined) this.modelControl.pinTurn(turn, selection)
  }

  /**
   * Correlate an Agent interval failure with the active ACP prompt.
   * @param turn - failed turn number.
   * @param error - original same-process failure.
   */
  onAgentError(turn: number, error: unknown): void {
    const inflight = this.inflight
    if (inflight === undefined || !inflight.messageQueued) return
    // AgentLoop balances an in-turn failure with durable turn/end; settlement
    // reads that exact error reason. This slot records interval failures outside it.
    if (inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    this.settleAfterQuiescence(inflight)
  }

  /** Await every update queued before this call. */
  drainUpdates(): Promise<void> {
    return this.outputTail
  }

  /**
   * Cancel, drain, flush, and dispose this session once.
   * @param detail - cancellation detail for any prompt still in admission.
   * @returns the shared quiescent teardown promise.
   */
  close(detail: string): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      const failures: unknown[] = []
      const inflight = this.inflight
      this.cancelPrompt(detail)
      if (inflight === undefined || !inflight.messageQueued) this.agent.cancel({ kind: 'user' })
      try {
        await inflight?.admissionDone
        await this.agent.whenIdle()
        await this.outputTail
      } catch (error: unknown) {
        failures.push(new Error('ACP session activity drain failed', { cause: error }))
      }
      const subagents = this.ctx.get('subagents') as ContinuableDrain | undefined
      try {
        await subagents?.drainContinuableDescendants([this.agent])
      } catch (error: unknown) {
        this.ctx.logger.warn(`acp: continuable subagent teardown failed: ${errorChain(error)}`)
        failures.push(new Error('continuable subagent teardown failed', { cause: error }))
      }
      try {
        await this.ctx.sessions.flush(this.agent.session)
      } catch (error: unknown) {
        failures.push(new Error('ACP session persistence flush failed', { cause: error }))
      }
      try {
        await this.disposeAgent()
      } catch (error: unknown) {
        failures.push(error)
      }
      this.pendingSelections.clear()
      if (failures.length === 1) throw failures[0]
      /* v8 ignore start -- independent teardown failures can aggregate only under multiple simultaneous provider faults. */
      if (failures.length > 1) {
        throw new AggregateError(failures, `ACP session teardown failed: ${failures.map(errorChain).join('; ')}`)
      }
      /* v8 ignore stop */
    })()
    return this.closing
  }

  private assertActive(): void {
    if (this.closing !== undefined) throw invalidParams(`session is closing: ${this.agent.session.id}`)
  }

  private cancelPrompt(detail: string): void {
    const inflight = this.inflight
    if (inflight === undefined) return
    inflight.cancelRequested = true
    inflight.admissionController.abort(new Error(detail))
    this.settleAfterQuiescence(inflight)
    if (inflight.messageQueued) this.agent.cancel({ kind: 'user' })
  }

  private settleAfterQuiescence(inflight: InflightPrompt): void {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await inflight.admissionDone
      if (inflight.messageQueued) {
        await this.agent.whenIdle()
        await this.outputTail
      }
      /* v8 ignore next -- this prompt owns the slot until this exact settlement clears it. */
      if (this.inflight !== inflight) return
      this.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
        return
      }
      if (inflight.outputError !== undefined) {
        inflight.reject(internalError(`assistant output delivery failed: ${inflight.outputError.message}`))
        return
      }
      if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
        return
      }
      const end = inflight.endReason
      if (end === undefined) {
        inflight.resolve('cancelled')
      } else if (end.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${end.error.message}`))
      } else {
        inflight.resolve(turnEndToStopReason(end))
      }
    })()
      /* v8 ignore start -- admissionDone only resolves; idle/output gates contain their own failures. */
      .catch((error: unknown) => {
        if (this.inflight !== inflight) return
        this.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }
}
