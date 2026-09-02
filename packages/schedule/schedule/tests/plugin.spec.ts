import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import * as toolSchedule from '../src/index.ts'

interface StoredProbeSession {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
}

/** In-memory handle-based persistence, just enough for agent-loop's write path. */
class PersistenceProbe extends SessionPersistence {
  private readonly stored = new Map<string, StoredProbeSession>()

  override async create(header: SessionHeader): Promise<SessionHandle> {
    const entry: StoredProbeSession = { header, events: [] }
    this.stored.set(header.id, entry)
    return this.handle(entry, 'write')
  }

  // Appends are durable on resolution here; nothing buffers, so the service-wide flush is a no-op.
  override async flush(): Promise<void> {}

  override async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const entry = this.stored.get(id)
    if (entry === undefined) throw new SessionPersistenceNotFoundError(id)
    return this.handle(entry, access)
  }

  override async stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = this.stored.get(id)
    return entry === undefined ? undefined : this.snapshot(entry)
  }

  override async list(): Promise<SessionPersistenceSnapshot[]> {
    return [...this.stored.values()].map(entry => this.snapshot(entry))
  }

  private snapshot(entry: StoredProbeSession): SessionPersistenceSnapshot {
    return {
      header: entry.header,
      revision: SessionPersistenceRevision(`probe-${entry.header.id}-${entry.events.length}`),
      eventCount: entry.events.length,
    }
  }

  private handle(entry: StoredProbeSession, access: SessionAccess): SessionHandle {
    return {
      id: entry.header.id,
      header: entry.header,
      inheritedEventCount: SessionLogOffset(0),
      access,
      read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) =>
        entry.events.slice(offset, offset + length),
      append: async (events) => { entry.events.push(...events) },
      flush: async () => {},
      close: async () => {},
      [Symbol.asyncDispose]: async () => {},
    }
  }
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(PersistenceProbe)
  ctx.on('session/flush', () => {})
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('Schedule plugin composition', () => {
  it('has the Loader-safe function-plugin export shape', () => {
    expect('default' in toolSchedule).toBe(false)
    expect(toolSchedule.name).toBe('schedule')
    expect(toolSchedule.inject).toEqual(['agents', 'sessions', 'tools', 'sessionPersistence'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolSchedule)).toBe(toolSchedule)
  })

  it('installs only on future root agents and unwinds on plugin disposal', async () => {
    const ctx = await harness()
    const existing = await ctx.agents.create({ sessionId: SessionId('schedule-existing') })
    const plugin = await ctx.plugin(toolSchedule)
    expect(ctx.tools.get('schedule_create', existing.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    const root = await ctx.agents.create({ sessionId: SessionId('schedule-root') })
    expect(ctx.tools.get('schedule_create', root.agent)?.name).toBe('schedule_create')
    expect(ctx.tools.get('schedule_list', root.agent)?.name).toBe('schedule_list')
    expect(ctx.tools.get('schedule_delete', root.agent)?.name).toBe('schedule_delete')
    expect(ctx.tools.get('schedule_create')).toBeUndefined()

    const created = await ctx.agents.withInitiator(root.agent, () => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('schedule-plugin-create'),
      name: 'schedule_create',
      arguments: { prompt: 'future reminder', after_seconds: 3_600 },
      agent: root.agent,
    }))
    expect(created.isError).toBe(false)
    if (created.isError) throw new Error('expected Schedule create value')
    expect(created.value).toMatchObject({ id: 'schedule-1', deliveryMode: 'session-local' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'running' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })

    const child = await root.agent.ctx.agents.create({ sessionId: SessionId('schedule-child') })
    expect(ctx.agents.roots()).toEqual([existing.agent, root.agent])
    expect(ctx.tools.get('schedule_create', child.agent)).toBeUndefined()

    const departing = await ctx.agents.create({ sessionId: SessionId('schedule-departing') })
    expect(ctx.tools.get('schedule_create', departing.agent)).toBeDefined()
    await departing.dispose()
    expect(ctx.tools.get('schedule_create', departing.agent)).toBeUndefined()

    await plugin.dispose()
    expect(ctx.tools.get('schedule_create', root.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_list', root.agent)).toBeUndefined()
    expect(ctx.tools.get('schedule_delete', root.agent)).toBeUndefined()

    await child.dispose()
    await root.dispose()
    await existing.dispose()
    await ctx.fiber.dispose()
  })

  it('does not checkpoint unrelated idle sessions', async () => {
    const ctx = await harness()
    const plugin = await ctx.plugin(toolSchedule)
    const root = await ctx.agents.create({ sessionId: SessionId('schedule-unrelated-idle') })
    await settle()
    let flushes = 0
    const stopFlush = ctx.on('session/flush', (session) => {
      if (session === root.agent.session) flushes += 1
    })

    agentEvents(ctx, root.agent).emit('agent/status', { status: 'running' })
    agentEvents(ctx, root.agent).emit('agent/status', { status: 'idle' })
    await settle()
    expect(flushes).toBe(0)

    stopFlush()
    await root.dispose()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })
})
