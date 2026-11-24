/**
 * Live agent hosting for IM sessions: create and resume agents from the stored composition, track live handles, and
 * dispose them on reset, ephemeral idle, and shutdown.
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ImSessionRecord } from './api.ts'
import { ImError } from './error.ts'
import { runKeyed } from './serial.ts'

/**
 * The session id of one generation of a hosted session: `im-${sha256(key + '#' + generation)[0..32]}`.
 * @param key - the owner-defined session key.
 * @param generation - the record's generation (a reset advances it, so the id of the old session never returns).
 * @returns the session id that record's agent runs under.
 */
export function sessionIdOf(key: string, generation: number): SessionId {
  return SessionId(`im-${createHash('sha256').update(`${key}#${generation}`).digest('hex').slice(0, 32)}`)
}

/** Opens, shares and disposes the live agents of hosted IM sessions, one agent per session id and serialized per id. */
export class ImAgentHost {
  /** Live agents this host opened (or adopted), by session id. */
  private readonly handles = new Map<SessionId, AgentHandle>()
  /** Per-session open/dispose serialization. */
  private readonly chains = new Map<SessionId, Promise<unknown>>()

  constructor(readonly ctx: Context) {
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.handles.get(agent.session.id)?.agent === agent) this.handles.delete(agent.session.id)
    })
  }

  /**
   * Live agent of the record: resume when persisted, else create with `record.composition`. Serialized per id.
   * @param record - the session record to host.
   * @returns the live agent of that session id (an agent another client already opened is shared, never replaced).
   */
  open(record: ImSessionRecord): Promise<Agent> {
    return this.serial(record.sessionId, () => this.ctx.agents.withoutInitiator(() => this.openNow(record)))
  }

  /**
   * Live agent opened by this host, if any.
   * @param sessionId - the session id to look up.
   * @returns the agent this host opened, or undefined when it is absent or no longer the registered agent.
   */
  live(sessionId: SessionId): Agent | undefined {
    const handle = this.handles.get(sessionId)
    return handle && this.ctx.agents.get(sessionId) === handle.agent ? handle.agent : undefined
  }

  /**
   * Dispose one live agent (reset, ephemeral idle).
   * @param sessionId - the session id whose agent to dispose; a session with no live agent is a no-op.
   */
  dispose(sessionId: SessionId): Promise<void> {
    return this.serial(sessionId, async () => {
      const handle = this.handles.get(sessionId)
      if (!handle) return
      this.handles.delete(sessionId)
      await handle.dispose()
    })
  }

  /** Dispose every live agent (service shutdown). */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.handles.keys()].map(id => this.dispose(id)))
  }

  private serial<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    return runKeyed(this.chains, sessionId, operation)
  }

  private async openNow(record: ImSessionRecord): Promise<Agent> {
    const id = record.sessionId
    const current = this.live(id)
    if (current) return current
    const live = this.ctx.agents.get(id)
    if (live) {
      // Already live under another client (e.g. the Web GUI restored it): share it, never dispose it.
      this.handles.set(id, { agent: live, dispose: () => Promise.resolve() })
      this.ctx.logger.warn('IM session %s was already live under another client; the IM host shares that agent.', id)
      return live
    }
    const { composition } = record
    const options = {
      agentOptions: { provider: composition.provider, model: composition.model },
      setup: async (agentCtx: Context) => {
        const presets = this.ctx.get('agentPresets')
        if (!presets) throw new ImError('configuration', `IM session ${id} requires the agent preset registry.`)
        await presets.mount(agentCtx, composition.agentPreset)
        if (composition.restrict) agentCtx.tools.restrict(composition.restrict)
      },
    }
    const handle = await this.ctx.sessionPersistence.stat(id)
      ? await this.ctx.agents.resume({ ...options, resumeSessionId: id })
      : await this.ctx.agents.create({
        ...options, sessionId: id, meta: { cwd: composition.cwd, agentPreset: composition.agentPreset },
      })
    this.handles.set(id, handle)
    return handle.agent
  }
}
