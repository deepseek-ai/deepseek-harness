/** Trajectory Host inspector retaining tool values only for live Session instances. */
import { addAbortListener } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionToolResultRequest, SessionToolResultValue } from './types.ts'

export type { SessionToolResultRequest, SessionToolResultValue } from './types.ts'

interface LiveResults {
  readonly values: Map<ToolCallId | number, JsonValue>
  readonly listeners: Set<(seq?: number) => void>
}

function emptyResults(): LiveResults {
  return { values: new Map(), listeners: new Set() }
}

/** Count limit for each live Session's transient tool results. */
export interface Config {
  /** Maximum retained results per Session, including values awaiting a result event. */
  maxResultsPerSession: number
}

/** Read-only Remote inspection of tool values produced in this Session lifetime. */
export default class SessionToolResults extends TypertRemoteService {
  static inject = ['sessions', 'typert']
  static Config: z<Partial<Config>, Config> = z.object({
    maxResultsPerSession: z.natural().min(1).default(1000),
  })
  private readonly results = new Map<Session, LiveResults>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - Owner of the live Session registry and tool result notifications.
   * @param config - Validated per-Session retention limit.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionToolResults', { namespace: 'toolResults' })
    ctx.on('tools/result', (exec, result) => {
      const session = exec.agent?.session
      if (result.isError || session === undefined || ctx.sessions.get(session.id) !== session) return
      const state = this.forSession(session)
      state.values.set(exec.callId, result.value)
      if (state.values.size <= config.maxResultsPerSession) return
      for (const oldest of state.values.keys()) {
        state.values.delete(oldest)
        if (typeof oldest === 'number') for (const listener of state.listeners) listener(oldest)
        break
      }
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      const callId = event.type === 'tool/result' ? event.data.message.toolCallId
        : event.type === 'tool/ptc-dispatch' ? event.data.subCallId : undefined
      if (callId === undefined) return
      const state = this.results.get(session)
      const value = state?.values.get(callId)
      if (state === undefined || value === undefined) return
      state.values.delete(callId)
      state.values.set(event.seq, value)
      for (const listener of state.listeners) listener(event.seq)
    }, { global: true })
    ctx.on('session/disposed', (session) => {
      const state = this.results.get(session)
      if (state === undefined) return
      this.results.delete(session)
      state.values.clear()
      for (const listener of state.listeners) listener()
    }, { global: true })
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const state of this.results.values()) state.values.clear()
      this.results.clear()
    }, 'tool-results: live values and followers')
  }

  private forSession(session: Session): LiveResults {
    let state = this.results.get(session)
    if (state === undefined) {
      state = emptyResults()
      this.results.set(session, state)
    }
    return state
  }

  private forRequest(request: SessionToolResultRequest): LiveResults {
    const session = this.ctx.sessions.get(request.sessionId)
    return session === undefined ? emptyResults() : this.forSession(session)
  }

  /**
   * Observe one committed result without loading a Session or reading its history.
   * Values disappear on count eviction or when the exact Session instance leaves
   * the registry. A cold read stays unavailable; opening a new stream observes
   * the current instance. Inspection does not extend a result's retention.
   * @param request - Authorized Session identity and durable result event sequence.
   * @param signal - Remote consumer lifetime.
   * @returns Current availability and changes until cancellation or service disposal.
   */
  @Remote({ mode: 'stream' })
  async *watch(request: SessionToolResultRequest, signal: AbortSignal): AsyncIterable<SessionToolResultValue> {
    const lifetime = AbortSignal.any([signal, this.lifetime.signal])
    if (lifetime.aborted) return
    const state = this.forRequest(request)
    let update = Promise.withResolvers<void>()
    const changed = (seq?: number): void => {
      if (seq === undefined || seq === request.seq) update.resolve()
    }
    state.listeners.add(changed)
    using _cancellation = addAbortListener(lifetime, () => { update.resolve() })
    try {
      while (!lifetime.aborted) {
        const value = state.values.get(request.seq)
        yield value === undefined ? { available: false } : { available: true, value }
        await update.promise
        update = Promise.withResolvers<void>()
      }
    } finally {
      state.listeners.delete(changed)
    }
  }
}
