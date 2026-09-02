/**
 * Cold-session and degenerate-composition paths of the Session Controller:
 * metadata-only listing, Agent-free history reads, subagent ownership
 * isolation, and prompt failure mapping.
 */

import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionHistoryController } from '@deepseek-ai/dsh-api-session-controller/src/history.ts'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import {
  SessionPersistenceRevision,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { ApiSessionList } from '../src/list.ts'
import {
  createSessionTestRemote,
  installSessionReadTestServices,
  testSessionPersistence,
} from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

let nextRequestId = 1
function promptRequest(
  payload: Omit<SessionPromptRequest, 'requestId'>,
): SessionPromptRequest {
  return {
    ...payload,
    requestId: `cold-${String(nextRequestId++)}` as SessionRequestId,
  }
}

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: 0, id: sid(id), createdAt, isSeeded: false, cwd: '/proj', ...extra }
}

function providePersistence(ctx: Context, persistence: Record<string, unknown>): () => void {
  return ctx.provide('sessionPersistence', testSessionPersistence(ctx, persistence) as never)
}

function statSnapshot(
  meta: SessionHeader,
  metrics: Partial<Pick<SessionPersistenceSnapshot, 'eventCount' | 'sizeBytes'>> = {},
): SessionPersistenceSnapshot {
  return { header: meta, revision: SessionPersistenceRevision(`test:${meta.id}:stat`), ...metrics }
}

/** A stored log whose only event is the seed boundary: still blank. */
function blankEvents(): SessionEvent[] {
  return [{ type: 'session/end-seed', seq: SessionSeq(0), time: 700, data: {} }] as SessionEvent[]
}

/** A stored log with one human prompt at time 1200: proven non-blank. */
function conversationEvents(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 800, data: { turn: 1 } },
    {
      type: 'user/message', seq: SessionSeq(1), time: 1200,
      data: createUserMessage({ content: [{ type: 'text', text: 'worked' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
  ] as SessionEvent[]
}

describe('sessions.list cold merge', () => {
  it('serves cold rows from cached projections when stat offers no size metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const metas = [
      header('cached-blank', 100),
      header('cached-conversation', 200),
      header('uncached', 300, { parentSession: sid('session-parent'), origin: 'subagent' }),
      header('seeded-cold', 450, { isSeeded: true }),
      { version: 0, id: sid('missing-cwd'), createdAt: 800, isSeeded: false },
    ]
    const inspect = vi.fn()
    providePersistence(ctx, {
      list: () => Promise.resolve(metas),
      inspect,
    })
    const cacheCalls: string[] = []
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (meta: SessionHeader) => {
        cacheCalls.push(String(meta.id))
        if (meta.id === sid('cached-blank')) {
          return { asOfSeq: 0, values: { sessionListMetadata: { blank: true, lastPromptAt: null } } }
        }
        if (meta.id === sid('cached-conversation')) {
          return { asOfSeq: 1, values: { sessionListMetadata: { blank: false, lastPromptAt: 1000 } } }
        }
        return undefined
      },
    } as never)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const response = await remote.list(request({}))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    const byId = Object.fromEntries(response.value.items.map(item => [item.sessionId, item]))
    expect(byId['cached-blank']).toMatchObject({ blank: true, updatedAt: 100, running: false })
    expect(byId['cached-conversation']).toMatchObject({ blank: false, updatedAt: 1000 })
    // A cache miss with a metadata-less stat leaves blankness unknown; the row stays visible.
    expect(byId['uncached']).toMatchObject({
      blank: false,
      updatedAt: 300,
      parentSessionId: 'session-parent',
      origin: 'subagent',
    })
    expect(byId['missing-cwd']).toBeUndefined()
    // A cold seeded header never consults the cache: its cut is not 0, so a
    // cut-0 lookup would alias a different projection identity.
    expect(byId['seeded-cold']).toMatchObject({ blank: false, updatedAt: 450 })
    expect(cacheCalls).not.toContain('seeded-cold')
    expect(inspect).not.toHaveBeenCalled()
  })

  it('fully observes only small possibly-blank logs gated by stat eventCount', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const metas = [
      header('small-blank', 100),
      header('small-conversation', 200),
      header('large-unknown', 300),
      header('cached-nonblank', 400),
      header('vanished', 600),
      { version: 0, id: sid('missing-cwd'), createdAt: 800, isSeeded: false },
    ]
    const inspect = vi.fn(async (id: SessionId) => {
      if (id === sid('small-blank')) return { meta: metas[0]!, events: blankEvents() }
      if (id === sid('small-conversation')) return { meta: metas[1]!, events: conversationEvents() }
      throw new Error(`unexpected cold read: ${id}`)
    })
    const stat = vi.fn(async (id: SessionId) => {
      if (id === sid('small-blank')) return statSnapshot(metas[0]!, { eventCount: 1 })
      if (id === sid('small-conversation')) return statSnapshot(metas[1]!, { eventCount: 2 })
      if (id === sid('large-unknown')) return statSnapshot(metas[2]!, { eventCount: 17 })
      if (id === sid('vanished')) return undefined
      throw new Error(`unexpected stat: ${id}`)
    })
    providePersistence(ctx, {
      list: () => Promise.resolve(metas),
      stat,
      inspect,
    })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (meta: SessionHeader) => {
        if (meta.id === sid('small-blank')) {
          return { asOfSeq: 0, values: { sessionListMetadata: { blank: true, lastPromptAt: null } } }
        }
        if (meta.id === sid('small-conversation')) {
          return { asOfSeq: 0, values: { sessionListMetadata: { blank: true, lastPromptAt: 900 } } }
        }
        if (meta.id === sid('cached-nonblank')) {
          return { asOfSeq: 1, values: { sessionListMetadata: { blank: false, lastPromptAt: 1000 } } }
        }
        return undefined
      },
      hydratePrepared: (session: Session, events: readonly SessionEvent[]) =>
        ctx.sessionProjections.hydrate(session, {}, events, SessionLogOffset(0)),
    } as never)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const response = await remote.list(request({}))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    const byId = Object.fromEntries(response.value.items.map(item => [item.sessionId, item]))
    expect(byId['small-blank']).toMatchObject({ blank: true, updatedAt: 100, running: false })
    expect(byId['small-conversation']).toMatchObject({ blank: false, updatedAt: 1200 })
    expect(byId['large-unknown']).toMatchObject({ blank: false, updatedAt: 300 })
    expect(byId['cached-nonblank']).toMatchObject({ blank: false, updatedAt: 1000 })
    expect(byId['vanished']).toMatchObject({ blank: false, updatedAt: 600 })
    expect(byId['missing-cwd']).toBeUndefined()
    // A cache row proving blank:false is never re-probed.
    expect(stat.mock.calls.map(([id]) => id)).not.toContain(sid('cached-nonblank'))
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(inspect.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining([
      sid('small-blank'),
      sid('small-conversation'),
    ]))
  })

  it('falls back to the stat sizeBytes gate when no eventCount is offered', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const metas = [header('small-jsonl', 100), header('large-jsonl', 200)]
    const inspect = vi.fn(async (id: SessionId) => {
      if (id === sid('small-jsonl')) return { meta: metas[0]!, events: conversationEvents() }
      throw new Error(`unexpected cold read: ${id}`)
    })
    providePersistence(ctx, {
      list: () => Promise.resolve(metas),
      stat: (id: SessionId) => Promise.resolve(id === sid('small-jsonl')
        ? statSnapshot(metas[0]!, { sizeBytes: 1024 })
        : statSnapshot(metas[1]!, { sizeBytes: 1025 })),
      inspect,
    })
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const response = await remote.list(request({}))
    if (!response.ok) throw new Error('list failed')
    const byId = Object.fromEntries(response.value.items.map(item => [item.sessionId, item]))
    expect(byId['small-jsonl']).toMatchObject({ blank: false, updatedAt: 1200 })
    expect(byId['large-jsonl']).toMatchObject({ blank: false, updatedAt: 200 })
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith(sid('small-jsonl'), expect.anything())
  })

  it('skips the observation when stat offers neither eventCount nor sizeBytes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('no-metrics', 100)
    const inspect = vi.fn()
    const stat = vi.fn(async () => statSnapshot(meta))
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      stat,
      inspect,
    })
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const response = await remote.list(request({}))
    if (!response.ok) throw new Error('list failed')
    expect(response.value.items).toEqual([
      expect.objectContaining({ sessionId: meta.id, blank: false, updatedAt: meta.createdAt }),
    ])
    expect(stat).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('can disable both probe gates without hiding cold Sessions or calling stat', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('probe-disabled', 100)
    const inspect = vi.fn()
    const stat = vi.fn()
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      stat,
      inspect,
    })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
      coldBlankProbeMaxEvents: 0,
      coldBlankProbeMaxBytes: 0,
    })

    const response = await remote.list(request({}))
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.items).toEqual([
      expect.objectContaining({ sessionId: meta.id, blank: false, updatedAt: meta.createdAt }),
    ])
    expect(stat).not.toHaveBeenCalled()
    expect(inspect).not.toHaveBeenCalled()
  })

  it('treats zero as disabling one gate without falling back to the other metric', async () => {
    const bench = async (
      metrics: Partial<Pick<SessionPersistenceSnapshot, 'eventCount' | 'sizeBytes'>>,
      thresholds: { coldBlankProbeMaxEvents?: number; coldBlankProbeMaxBytes?: number },
    ) => {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      const meta = header('gate-off', 100)
      const inspect = vi.fn()
      providePersistence(ctx, {
        list: () => Promise.resolve([meta]),
        stat: () => Promise.resolve(statSnapshot(meta, metrics)),
        inspect,
      })
      const remote = createSessionTestRemote(ctx, {
        defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
        cwd: '/tmp',
        ...thresholds,
      })
      const response = await remote.list(request({}))
      if (!response.ok) throw new Error('list failed')
      expect(response.value.items).toEqual([
        expect.objectContaining({ sessionId: meta.id, blank: false }),
      ])
      expect(inspect).not.toHaveBeenCalled()
    }

    // An offered eventCount never falls through to the byte gate, even disabled.
    await bench({ eventCount: 1, sizeBytes: 10 }, { coldBlankProbeMaxEvents: 0 })
    await bench({ sizeBytes: 10 }, { coldBlankProbeMaxBytes: 0 })
  })

  it('prefers a Session that attaches during its bounded cold observation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const meta = header('attached-during-probe', 100)
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      stat: () => {
        const session = ctx.sessions.create(meta.id, {
          meta,
          seed: [{ type: 'turn/start', seq: SessionSeq(0), time: 200, data: { turn: 1 } }],
        })
        ctx.agents.register({ id: session.id, session, status: 'running', ctx } as Agent)
        return Promise.resolve(statSnapshot(meta, { eventCount: 1 }))
      },
    })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
    })

    const response = await remote.list(request({}))
    if (!response.ok) throw new Error('list failed')
    expect(response.value.items).toEqual([
      expect.objectContaining({ sessionId: meta.id, running: true, blank: false }),
    ])
    await ctx.fiber.dispose()
  })

  it('serves a session whose cold stat fails as visible instead of failing the list', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('broken-stat', 100)
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      stat: () => Promise.reject(new Error('stat failed')),
    })
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
    })

    const response = await remote.list(request({}))
    if (!response.ok) throw new Error('list failed')
    expect(response.value.items).toEqual([
      expect.objectContaining({ sessionId: meta.id, running: false }),
    ])
    expect(warned.mock.calls.join('\n')).toContain('cold stat for "broken-stat" failed')
    warned.mockRestore()
    await ctx.fiber.dispose()
  })

  it('a stat rejection after cancellation propagates instead of degrading', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('stat-abort', 100)
    const controller = new AbortController()
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      stat: () => {
        controller.abort(new Error('caller left'))
        return Promise.reject(new Error('stat failed'))
      },
    })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
    })

    await expect(remote.list(request({}), controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/cancelled' },
    })
    await ctx.fiber.dispose()
  })

  it('serves a small cold Session as visible when its observation fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const meta = header('read-failure', 700)
    const inspect = vi.fn(async () => { throw new Error('simulated read failure') })
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      stat: () => Promise.resolve(statSnapshot(meta, { eventCount: 1 })),
      inspect,
    })
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp',
    })

    const response = await remote.list(request({}))
    if (!response.ok) throw new Error('list failed')
    expect(response.value.items).toEqual([
      expect.objectContaining({ sessionId: meta.id, blank: false, updatedAt: 700 }),
    ])
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('supports an unsignalled probe whose observation has no projection block', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    installSessionReadTestServices(ctx)
    const meta = header('unprojected-small', 100)
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([meta]),
      stat: () => Promise.resolve(statSnapshot(meta, { eventCount: 0 })),
    } as never)
    vi.spyOn(ctx.sessionQuery, 'listSessions').mockResolvedValue([{
      header: meta, live: false, persisted: true,
    }])
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockResolvedValue({
      source: 'prepared', header: meta, inheritedEventCount: SessionLogOffset(0), events: [], cursor: -1,
      retain: vi.fn(), [Symbol.dispose]: vi.fn(),
    })
    const list = new ApiSessionList(ctx, { coldBlankProbeMaxEvents: 16, coldBlankProbeMaxBytes: 1024 })

    await expect(list.list()).resolves.toEqual([
      expect.objectContaining({ sessionId: meta.id, blank: false }),
    ])
    await ctx.fiber.dispose()
  })

  it('serves a cold row visible when no persistence service can stat it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const meta = header('service-less', 100)
    vi.spyOn(ctx.sessionQuery, 'listSessions').mockResolvedValue([{
      header: meta, live: false, persisted: true,
    }])
    const list = new ApiSessionList(ctx, { coldBlankProbeMaxEvents: 16, coldBlankProbeMaxBytes: 1024 })

    await expect(list.list()).resolves.toEqual([
      expect.objectContaining({ sessionId: meta.id, blank: false }),
    ])
    await ctx.fiber.dispose()
  })

  it('prefers a live row attached during the query without folding its seed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const meta = header('attached-during-list', 100)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    providePersistence(ctx, {
      list: async () => {
        started.resolve(undefined)
        await release.promise
        return [meta]
      },
    })
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const listing = remote.list(request({}))
    await started.promise
    const session = ctx.sessions.create(meta.id, {
      seed: [
        { type: 'turn/start', seq: SessionSeq(0), time: 200, data: { turn: 1 } },
        {
          type: 'user/message', seq: SessionSeq(1), time: 300,
          data: createUserMessage({ content: [{ type: 'text', text: 'live' }], source: { kind: 'user' } }),
          surfaceOp: 'append',
        },
      ],
      meta: {
        ...meta.cwd === undefined ? {} : { cwd: meta.cwd },
        createdAt: meta.createdAt,
      },
    })
    ctx.agents.register({ id: session.id, session, status: 'running', ctx } as Agent)
    release.resolve(undefined)

    const response = await listing
    if (!response.ok) throw new Error('list failed')
    expect(response.value.items).toEqual([
      expect.objectContaining({
        sessionId: meta.id,
        blank: false,
        running: true,
        updatedAt: 100,
      }),
    ])
  })

})

describe('attached updatedAt tracks human prompts', () => {
  it('ignores pickup and non-prompt work after the latest human message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    await new Promise(resolve => setTimeout(resolve, 0))

    // Old work, resumed just now: the log tail would report the pickup.
    const worked = 1_000_000
    const resumed = ctx.sessions.create(sid('resumed-untouched'), {
      seed: [
        { type: 'turn/start', seq: SessionSeq(0), time: worked, data: { turn: 1 } },
        {
          type: 'user/message', seq: SessionSeq(1), time: worked,
          data: createUserMessage({ content: [{ type: 'text', text: 'worked' }], source: { kind: 'user' } }),
          surfaceOp: 'append',
        },
        { type: 'turn/end', seq: SessionSeq(2), time: worked + 1, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      meta: { cwd: '/proj', createdAt: 500 },
    })
    ctx.agents.register({ id: resumed.id, session: resumed, status: 'idle', ctx } as Agent)
    const boundary = resumed.snapshotEvents().at(-1)
    expect(boundary?.type).toBe('session/end-seed')
    expect(boundary?.time).toBeGreaterThan(worked)

    const listed = await remote.list(request({}))
    if (!listed.ok) throw new Error('list failed')
    const summary = listed.value.items.find(item => item.sessionId === 'resumed-untouched')
    expect(summary?.updatedAt).toBe(500)

    // A lifecycle boundary is not a human update.
    resumed.append('turn/start', { turn: 2 })
    const afterBoundary = await remote.list(request({}))
    if (!afterBoundary.ok) throw new Error('list failed')
    expect(afterBoundary.value.items.find(item => item.sessionId === 'resumed-untouched')?.updatedAt)
      .toBe(worked)

    const prompt = resumed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'new prompt' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const after = await remote.list(request({}))
    if (!after.ok) throw new Error('list failed')
    const moved = after.value.items.find(item => item.sessionId === 'resumed-untouched')
    expect(moved?.updatedAt).toBe(prompt.time)
  })
})

describe('cold history recovery view', () => {
  it('serves the stored interrupted prefix verbatim without activating the session', async () => {
    // Semantic crash repair is the resuming agent loop's job (it appends the
    // closers durably through its write handle); a cold history read shows the
    // stored prefix exactly as persisted.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const sessionId = sid('session-interrupted')
    const meta = header(sessionId, 1000)
    const events = [{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }] as SessionEvent[]
    providePersistence(ctx, {
      list: () => Promise.resolve([structuredClone(meta)]),
      inspect: () => Promise.resolve({ meta: structuredClone(meta), events: structuredClone(events) }),
    })
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const history = await remote.page({
      address: { kind: 'session', sessionId },
      throughSeq: 0,
      beforeSeq: 1,
      maxMessages: 10,
    })
    if (!history.ok) throw new Error('history failed')
    expect(history.value.records.map(record => record.event)).toMatchInlineSnapshot(`
      [
        {
          "data": {
            "turn": 1,
          },
          "seq": 0,
          "time": 1,
          "type": "turn/start",
        },
      ]
    `)
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('Remote Agent and Session lookup policy', () => {
  it('deduplicates a cold resume across Agent and Session parameters', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = sid('session-remote-cold')
    const meta = header(sessionId, 1000)
    const inspect = vi.fn(() => Promise.resolve({ meta, events: [] as SessionEvent[] }))
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect,
    })
    const resumedSession = { id: sessionId, header: meta, events: [] } as unknown as import('@deepseek-ai/dsh-session').Session
    const resumedAgent = { id: sessionId, session: resumedSession, status: 'idle', ctx } as Agent
    const release = Promise.withResolvers<undefined>()
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      await release.promise
      return { agent: resumedAgent, dispose: () => Promise.resolve() }
    })
    const defaultAgentLookup = ctx.typert.lookups.get('agent')
    const defaultSessionLookup = ctx.typert.lookups.get('session')
    createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    await vi.waitFor(() => {
      expect(ctx.typert.lookups.get('agent')).not.toBe(defaultAgentLookup)
      expect(ctx.typert.lookups.get('session')).not.toBe(defaultSessionLookup)
    })
    const agentLookup = ctx.typert.lookups.get('agent')
    const sessionLookup = ctx.typert.lookups.get('session')
    if (agentLookup === undefined || sessionLookup === undefined) throw new Error('core lookup providers were not mounted')

    const resolvedAgent = Promise.resolve(agentLookup.resolve(sessionId))
    const resolvedSession = Promise.resolve(sessionLookup.resolve(sessionId))
    await vi.waitFor(() => { expect(resume).toHaveBeenCalledOnce() })
    release.resolve(undefined)

    await expect(resolvedAgent).resolves.toBe(resumedAgent)
    await expect(resolvedSession).resolves.toBe(resumedSession)
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('preserves the subagent ownership fence for cold and live Remote lookups', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const coldId = sid('session-remote-cold-child')
    const coldMeta = header(coldId, 1000, {
      parentSession: sid('session-parent'),
      origin: 'subagent',
    })
    const inspect = vi.fn(() => Promise.resolve({ meta: coldMeta, events: [] as SessionEvent[] }))
    providePersistence(ctx, {
      list: () => Promise.resolve([coldMeta]),
      inspect,
    })
    const liveSession = ctx.sessions.create(sid('session-remote-live-child'), {
      meta: { cwd: '/proj', parentSession: sid('session-parent'), origin: 'subagent' },
    })
    const liveAgent = { id: liveSession.id, session: liveSession, status: 'idle', ctx } as Agent
    ctx.agents.register(liveAgent)
    const resume = vi.spyOn(ctx.agents, 'resume')
    const defaultAgentLookup = ctx.typert.lookups.get('agent')
    const defaultSessionLookup = ctx.typert.lookups.get('session')
    createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    await vi.waitFor(() => {
      expect(ctx.typert.lookups.get('agent')).not.toBe(defaultAgentLookup)
      expect(ctx.typert.lookups.get('session')).not.toBe(defaultSessionLookup)
    })
    const agentLookup = ctx.typert.lookups.get('agent')
    const sessionLookup = ctx.typert.lookups.get('session')
    if (agentLookup === undefined || sessionLookup === undefined) throw new Error('core lookup providers were not mounted')
    const ownershipFailure = {
      code: 'session/agent-busy',
      details: { reason: 'use subagent delivery for this child session' },
    }

    const coldFailure = Promise.resolve(agentLookup.resolve(coldId))
    const liveFailure = Promise.resolve(sessionLookup.resolve(liveSession.id))
    await expect(coldFailure).rejects.toMatchObject(ownershipFailure)
    await expect(liveFailure).rejects.toMatchObject(ownershipFailure)
    expect(resume).not.toHaveBeenCalled()
    expect(inspect).toHaveBeenCalledOnce()
  })
})

describe('subagent ownership fence', () => {
  it('reads a cold child without an Agent and rejects generic resume or adoption', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = sid('session-child')
    const meta = header('session-child', 1000, {
      parentSession: sid('session-parent'),
      origin: 'subagent',
    })
    const events = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(2),
        time: 3,
        data: snapshotSubagentDescriptor({
          mode: 'continuable',
          provider: 'spawn',
          label: 'child',
        }),
      },
      { type: 'turn/end', seq: SessionSeq(3), time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const inspect = vi.fn(() => Promise.resolve({ meta, events }))
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect,
    })
    const resume = vi.spyOn(ctx.agents, 'resume')
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    ctx.sessionProjections.register(subagentIdentityProjectionDefinition)

    const history = await new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
    ).page({
      address: {
        kind: 'subagent',
        parentSessionId: meta.parentSession as SessionId,
        childSessionId: sessionId,
        mode: 'continuable',
      },
      throughSeq: 3,
    }, new AbortController().signal)
    expect(history.records.map(record => record.event.type))
      .toEqual(events.map(event => event.type))
    expect(ctx.agents.get(sessionId)).toBeUndefined()

    const prompt = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'follow up' }],
    }))
    expect(prompt.ok).toBe(false)
    if (!prompt.ok) {
      expect(prompt.error).toMatchObject({
        code: 'session/agent-busy',
        details: { reason: 'use subagent delivery for this child session' },
      })
    }

    const create = await remote.create(request({ sessionId, cwd: '/proj' }))
    expect(create.ok).toBe(false)
    if (!create.ok) expect(create.error.code).toBe('session/agent-busy')
    expect(resume).not.toHaveBeenCalled()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    // One log open serves all three cold reads: the observation cache reuses
    // the prepared Session while the stat revision is unchanged.
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('no longer treats a descriptor-only cold child without origin as subagent-owned', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = sid('session-legacy-child')
    const meta = header('session-legacy-child', 1000, {
      parentSession: sid('session-parent'),
    })
    const events = [
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(0),
        time: 1,
        data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'child' },
      },
    ] as SessionEvent[]
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events })    })
    // Stores whose headers predate `origin` classify a child only through the
    // descriptor event; the pre-release decision stops recognizing them, so
    // the ownership fence lets generic resume reach the registry instead of
    // answering `agent-busy`.
    const resume = vi.spyOn(ctx.agents, 'resume')
      .mockRejectedValue(new Error('registry unavailable in this bench'))
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const prompt = await remote.prompt(promptRequest({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'follow up' }],
    }))
    expect(resume).toHaveBeenCalledTimes(1)
    expect(prompt.ok).toBe(false)
    if (!prompt.ok) expect(prompt.error.code).toBe('gateway/internal')
  })

  it('rejects origin-marked and runtime-owned live children from generic controls', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const parentSession = ctx.sessions.create(sid('session-parent'), { meta: { cwd: '/proj' } })
    const parent = { id: parentSession.id, session: parentSession, status: 'idle', ctx } as Agent
    ctx.agents.register(parent)

    const originSession = ctx.sessions.create(sid('session-origin-child'), {
      meta: { cwd: '/proj', parentSession: parent.id, origin: 'subagent' },
    })
    const cancel = vi.fn()
    const updateInbox = vi.fn(() => 'applied' as const)
    const originChild = {
      id: originSession.id,
      session: originSession,
      status: 'idle',
      ctx,
      cancel,
      updateInbox,
    } as unknown as Agent
    ctx.agents.register(originChild)

    const startingSession = ctx.sessions.create(sid('session-starting-child'), {
      meta: { cwd: '/proj', parentSession: parent.id },
    })
    const startingChild = { id: startingSession.id, session: startingSession, status: 'idle', ctx } as Agent
    ctx.agents.enter(startingChild, parent)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const stopped = await remote.cancel(request({ sessionId: originChild.id }))
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) expect(stopped.error.code).toBe('session/agent-busy')
    expect(cancel).not.toHaveBeenCalled()

    const queued = await remote.updateQueue(request({
      sessionId: originChild.id,
      itemId: MessageId('queued-item'),
      action: { kind: 'remove' },
    }))
    expect(queued.ok).toBe(false)
    if (!queued.ok) expect(queued.error.code).toBe('session/agent-busy')
    expect(updateInbox).not.toHaveBeenCalled()

    const selection = await remote.selectModel(request({
      sessionId: startingChild.id,
      provider: 'p',
      model: 'm',
    }))
    expect(selection.ok).toBe(false)
    if (!selection.ok) expect(selection.error.code).toBe('session/agent-busy')

    const create = await remote.create(request({ sessionId: originChild.id, cwd: '/proj' }))
    expect(create.ok).toBe(false)
    if (!create.ok) expect(create.error.code).toBe('session/agent-busy')

    expect(ctx.agents.get(originChild.id)).toBe(originChild)
  })

  it('does not classify an ordinary fork from an inherited ancestor descriptor', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(sid('session-ordinary-fork'), {
      seed: [{
        type: 'subagent/descriptor',
        seq: SessionSeq(0),
        time: 1,
        data: { version: 2, mode: 'continuable', provider: 'spawn', label: 'ancestor' },
      }],
      meta: { cwd: '/proj', parentSession: sid('session-source'), isSeeded: true },
      inheritedEventCount: SessionLogOffset(1),
    })
    const followup = vi.fn()
    const agent = { id: session.id, session, status: 'idle', ctx, followup } as unknown as Agent
    ctx.agents.register(agent)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const response = await remote.prompt(promptRequest({
      sessionId: agent.id,
      mode: 'queue',
      content: [{ type: 'text', text: 'ordinary work' }],
    }))
    expect(response.ok).toBe(true)
    expect(followup).toHaveBeenCalledOnce()
  })

  it('canonicalizes a supplied browser zone on the exact prompt and rejects invalid names', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(sid('session-browser-zone'), { meta: { cwd: '/proj' } })
    const followup = vi.fn()
    const agent = { id: session.id, session, status: 'idle', ctx, followup } as unknown as Agent
    ctx.agents.register(agent)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })

    const alias = 'US/Pacific'
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: alias })
      .resolvedOptions().timeZone
    const zonedRequest = promptRequest({
      sessionId: agent.id,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'zoned work' }],
      clientTimeZone: alias,
    })
    await expect(remote.prompt(zonedRequest)).resolves.toMatchObject({ ok: true })
    expect(followup).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: { kind: 'user', rpcId: zonedRequest.requestId, clientTimeZone: canonical },
    }))

    const utcRequest = promptRequest({
      sessionId: agent.id,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'UTC work' }],
      clientTimeZone: 'UTC',
    })
    await expect(remote.prompt(utcRequest)).resolves.toMatchObject({ ok: true })
    expect(followup).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source: { kind: 'user', rpcId: utcRequest.requestId, clientTimeZone: 'UTC' },
    }))

    const unzonedRequest = promptRequest({
      sessionId: agent.id,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'headless work' }],
    })
    await expect(remote.prompt(unzonedRequest)).resolves.toMatchObject({ ok: true })
    expect(followup).toHaveBeenNthCalledWith(3, expect.objectContaining({
      source: { kind: 'user', rpcId: unzonedRequest.requestId },
    }))

    for (const clientTimeZone of ['', ' UTC', 'CST', 'Not/A_Real_Zone']) {
      const invalid = await remote.prompt(promptRequest({
        sessionId: agent.id,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: 'invalid zone' }],
        clientTimeZone,
      }))
      expect(invalid).toMatchObject({
        ok: false,
        error: {
          code: 'session/invalid-time-zone',
          message: 'clientTimeZone must be UTC or a valid IANA Area/Location name',
          details: { value: clientTimeZone },
        },
      })
    }
    expect(followup).toHaveBeenCalledTimes(3)
  })
})

describe('degenerate composition (no persistence, no factory)', () => {
  it('lists no cold rows and reports an absent point source as not found', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const listed = await remote.list(request({}))
    expect(listed.ok).toBe(true)
    if (listed.ok) expect(listed.value.items).toEqual([])

    // No persistence means cold history cannot inspect a transcript.
    const response = await remote.page({
      address: { kind: 'session', sessionId: sid('session-ghost') },
      throughSeq: -1,
    })
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('session/not-found')
    }
  })

  it('maps a missing direct persistence read to session-not-found', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const inspect = vi.fn()
    const stat = vi.fn(() => Promise.resolve(undefined))
    providePersistence(ctx, {
      list: () => Promise.resolve([]),
      stat,
      inspect,
    })
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const response = await remote.page({
      address: { kind: 'session', sessionId: sid('session-missing') },
      throughSeq: -1,
    })
    expect(response.ok).toBe(false)
    if (!response.ok) expect(response.error.code).toBe('session/not-found')
    // Absence is decided by the stat preflight; the log itself is never opened.
    expect(stat).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
  })
})

describe('sessions.prompt synchronous rejection', () => {
  it('maps a synchronous send throw (disposed/invalid input) to agent-busy with the reason attached', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const session = ctx.sessions.create(sid('session-throwing'))
    // A live structural stub whose delivery verbs throw synchronously, the
    // shape a disposed loop presents at this gateway boundary.
    ctx.agents.register({
      id: session.id,
      session,
      status: 'idle',
      ctx,
      followup: () => { throw new Error('agent "session-throwing" lifecycle disposed') },
      steer: () => { throw new Error('agent "session-throwing" lifecycle disposed') },
    } as unknown as Agent)
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    for (const mode of ['queue', 'steer'] as const) {
      const response = await remote.prompt(promptRequest({
        sessionId: session.id, mode, content: [{ type: 'text' as const, text: 'x' }],
      }))
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.error.code).toBe('session/agent-busy')
        expect(response.error.message).toBe('prompt rejected')
        expect(response.error.details).toEqual({
          reason: 'Error: agent "session-throwing" lifecycle disposed',
        })
      }
    }
  })

  it('classifies a raced cold-resume ID collision as agent-busy', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const sessionId = sid('race-resume')
    const meta: SessionHeader = header('race-resume', 1000)
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] as SessionEvent[] })    })
    // The raced winner: a live parent-owned subagent publishes the identity
    // while the generic cold resume is in flight, so the resume collides.
    const parentSession = ctx.sessions.create(sid('race-parent'), { meta: { cwd: '/proj' } })
    const parent = { id: parentSession.id, session: parentSession, status: 'idle', ctx } as Agent
    ctx.agents.register(parent)
    const childSession = ctx.sessions.create(sessionId, {
      meta: { cwd: '/proj', parentSession: parent.id, origin: 'subagent' },
    })
    const child = { id: sessionId, session: childSession, status: 'idle', ctx } as unknown as Agent
    vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
      // The parent's `enter()` wins the identity between the pre-resume
      // re-check and publication; the generic resume then collides.
      ctx.agents.register(child)
      throw new Error('session id already published')
    })
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const selection = await remote.selectModel(request({ sessionId, provider: 'p', model: 'm' }))
    expect(selection.ok).toBe(false)
    if (!selection.ok) {
      expect(selection.error).toMatchObject({
        code: 'session/agent-busy',
        details: { reason: 'use subagent delivery for this child session' },
      })
    }
  })
})
