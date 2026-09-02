import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SubagentRuntime, {
  SUBAGENT_DESCRIPTOR_VERSION,
  SubagentError,
} from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { seedStoredSession } from './persistence-helpers.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
const projCacheRoots: string[] = []

afterEach(() => {
  for (const root of projCacheRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Boot the continuable stack with real JSONL session persistence. */
async function setup(
  script: Script,
  options: { sessionProjections?: boolean; projectionCache?: boolean } = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-list-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.sessionProjections !== false) await ctx.plugin(SessionProjectionRegistry)
  if (options.projectionCache === true) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-projcache-'))
    projCacheRoots.push(root)
    // The cache opens its domain through the storage stack; the json backend
    // lands it under this tmp root.
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  }
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const loop = ctx.get('agentLoop')
  const parent = loop === undefined
    ? (() => {
      const session = ctx.sessions.create(SessionId('parent'))
      return { id: session.id, session } as Awaited<ReturnType<Context['agentLoop']['create']>>
    })()
    : await loop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

const testSignal = new AbortController().signal

/** Start one continuable child through the real service path and await Activation release. */
async function startChild(
  ctx: Context,
  parent: Agent,
  label: string,
): Promise<SessionId> {
  const started = await ctx.subagents.startContinuable({
    provider: 'spawn',
    label,
    request: { prompt: [{ type: 'text', text: `task: ${label}` }], parent },
    signal: testSignal,
  })
  await vi.waitFor(() => {
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  }, { timeout: 5_000 })
  return started.childId
}

/** Author one persisted child session directly against the persistence backend. */
async function authorChild(
  ctx: Context,
  id: string,
  header: Partial<SessionHeader>,
  events: SessionEvent[],
  inheritedEventCount?: number,
): Promise<SessionId> {
  const sessionId = SessionId(id)
  await seedStoredSession(ctx.sessionPersistence, {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    isSeeded: inheritedEventCount !== undefined,
    ...header,
  }, events, inheritedEventCount === undefined ? undefined : SessionLogOffset(inheritedEventCount))
  return sessionId
}

/**
 * Serve one cold session's point read (the open handle) with a transformed
 * header while the enumeration listing keeps reporting the stored original —
 * the re-published-lifecycle shape the sameLifecycle check exists for.
 */
function mutateStoredHeader(
  ctx: Context,
  target: SessionId,
  mutate: (meta: SessionHeader) => SessionHeader,
): void {
  const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
  ctx.sessionPersistence.open = async (sessionId, access, options) => {
    const handle = await originalOpen(sessionId, access, options)
    if (sessionId !== target) return handle
    return {
      id: handle.id,
      access: handle.access,
      header: mutate(handle.header),
      inheritedEventCount: handle.inheritedEventCount,
      read: (offset, length, readOptions) => handle.read(offset, length, readOptions),
      append: (events, appendOptions) => handle.append(events, appendOptions),
      flush: flushOptions => handle.flush(flushOptions),
      close: () => handle.close(),
      [Symbol.asyncDispose]: () => handle[Symbol.asyncDispose](),
    }
  }
}

/** Minimal complete-turn child log with one descriptor payload. */
function childEvents(descriptor: unknown): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    {
      type: 'user/message',
      seq: SessionSeq(1),
      time: 2,
      data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
    { type: 'subagent/descriptor', seq: SessionSeq(2), time: 3, data: descriptor },
    { type: 'turn/end', seq: SessionSeq(3), time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

function descriptorPayload(label: string, version = SUBAGENT_DESCRIPTOR_VERSION) {
  return { version, mode: 'continuable' as const, provider: 'spawn', label }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    subagentListHostileProbe: { poisoned?: boolean | undefined }
  }
  interface SessionProjectionMap {
    /** Test-only hostile probe proving per-child isolation of foreign unit failures. */
    subagentListHostileProbe: null
  }
}

/**
 * A foreign registered unit that rejects one specific child's log at view
 * time: `apply` never throws (the eager drive passes every committed event
 * through it), while the poisoned state detonates only when a listing read
 * folds or serves this child through the registry.
 */
const hostileProjectionDefinition = {
  key: 'subagentListHostileProbe',
  stateSchema: z.object({ poisoned: z.boolean().optional() }),
  init: () => ({}),
  apply: (state, event) =>
    event.type === 'subagent/descriptor' && (event.data as { label?: string }).label === 'poison me'
      ? { poisoned: true }
      : state,
  wire: {
    viewSchema: z.null(),
    view: (state) => {
      if (state.poisoned === true) throw new Error('hostile unit rejects the poisoned log')
      return null
    },
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'subagentListHostileProbe', { poisoned?: boolean | undefined }>

describe('SubagentRuntime.listChildren', () => {
  it('lists live children without persistence or the continuation runtime', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(SubagentRuntime)
    expect(ctx.get('jobs')).toBeUndefined()
    expect(ctx.get('agents')).toBeUndefined()
    expect(ctx.get('sessionPersistence')).toBeUndefined()

    const parentId = SessionId('live-only-parent')
    ctx.sessions.create(parentId)
    const childId = SessionId('live-only-child')
    const child = ctx.sessions.create(childId, {
      meta: { parentSession: parentId, origin: 'subagent' },
    })
    child.append('turn/start', {
      turn: 1,
    })
    child.append('subagent/descriptor', descriptorPayload('live-only child'))

    await expect(ctx.subagents.listChildren(parentId)).resolves.toEqual([
      {
        kind: 'child', id: childId, label: 'live-only child', mode: 'continuable',
        activity: 'running', hasChildren: false,
      },
    ])
  })

  it('fails loud when the projection registry is not mounted, even with no children', async () => {
    const { ctx, parent } = await setup([], { sessionProjections: false })
    await expect(ctx.subagents.listChildren(parent.id)).rejects.toThrow(
      expect.objectContaining({ code: 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE' }) as Error,
    )
  })

  it('fails loud when the session store is not mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await expect(ctx.subagents.listChildren(SessionId('no-store-parent'))).rejects.toThrow(
      expect.objectContaining({ code: 'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE' }) as Error,
    )
  })

  it('fails loud when the Session query service is not mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)

    await expect(ctx.subagents.listChildren(SessionId('no-query-parent'))).rejects.toThrow(
      expect.objectContaining({ code: 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE' }) as Error,
    )
  })

  it('lists a persisted continuable child as inactive with its durable label', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'summarize the doc')
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'summarize the doc', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('lists one-shot and continuable children under the same parent', async () => {
    const { ctx, parent } = await setup([textResponse('once'), textResponse('again')])
    const oneShot = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: 'finish once' }],
      parent,
      signal: new AbortController().signal,
    })
    const oneShotId = oneShot.id
    await oneShot.result
    await oneShot.dispose()
    const continuableId = await startChild(ctx, parent, 'continuable child')

    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toHaveLength(2)
    expect(entries).toContainEqual({
      kind: 'child',
      id: oneShotId,
      mode: 'one-shot',
      activity: 'inactive',
      hasChildren: false,
    })
    expect(entries).toContainEqual({
      kind: 'child',
      id: continuableId,
      label: 'continuable child',
      mode: 'continuable',
      activity: 'inactive',
      hasChildren: false,
    })
  })

  it('accepts a persisted (non-live) parent target after restart', async () => {
    const { ctx } = await setup([])
    // A parent that exists only in persistence — the restart shape.
    const coldParent = SessionId('00000000-0000-4000-8000-00000000cccc')
    await seedStoredSession(ctx.sessionPersistence, {
      version: SESSION_FORMAT_VERSION,
      id: coldParent,
      createdAt: 1,
      isSeeded: false,
    }, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const childId = await authorChild(ctx, '00000000-0000-4000-8000-00000000cdcd', {
      parentSession: coldParent,
      origin: 'subagent',
    }, childEvents(descriptorPayload('persisted parent case')))
    const entries = await ctx.subagents.listChildren(coldParent)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'persisted parent case', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('orders children by createdAt then id without listing ordinary forks', async () => {
    const { ctx, parent } = await setup([])
    /** Publish one live child with a pinned header ordering key. */
    const liveChild = (parentId: SessionId, id: string, createdAt: number, label: string): SessionId => {
      const session = ctx.sessions.create(SessionId(id), {
        meta: { parentSession: parentId, origin: 'subagent', createdAt },
      })
      session.append('turn/start', { turn: 1 })
      session.append('subagent/descriptor', descriptorPayload(label))
      return session.header.id
    }
    // Live creation order is deliberately shuffled against the expected
    // result: same-createdAt ties break on id, different createdAt orders
    // ascending.
    const late = liveChild(parent.id, '00000000-0000-4000-8000-000000000009', 9, 'late child')
    const tieB = liveChild(parent.id, '00000000-0000-4000-8000-000000000002', 5, 'tie b')
    const tieA = liveChild(parent.id, '00000000-0000-4000-8000-000000000001', 5, 'tie a')
    // An ordinary session fork shares parentSession but has no subagent origin.
    const fork = ctx.sessions.fork(parent.session, undefined, SessionId('plain-fork'))
    await ctx.sessions.flush(fork)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries.map(entry => entry.id)).toEqual([tieA, tieB, late])
    expect(entries.every(entry => entry.kind === 'child')).toBe(true)
  })

  it('omits a live child that has not appended its descriptor yet', async () => {
    const { ctx, parent } = await setup([])
    const pending = ctx.sessions.create(SessionId('creation-window-child'), {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    pending.append('turn/start', { turn: 1 })
    // The creation window: the establishing provider has not appended the
    // descriptor yet, so the row is omitted rather than diagnosed.
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([])
  })

  it('contains a live child projection failure as one corrupt diagnostic', async () => {
    const { ctx, parent } = await setup([])
    const childId = SessionId('live-projection-failure')
    const child = ctx.sessions.create(childId, {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    child.append('subagent/descriptor', descriptorPayload('broken live child'))
    const snapshot = ctx.sessionProjections.snapshot.bind(ctx.sessionProjections)
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation((session, keys) => {
      if (session.id === childId) throw new Error('projection failed')
      return snapshot(session, keys)
    })

    await expect(ctx.subagents.listChildren(parent.id)).resolves.toContainEqual({
      kind: 'diagnostic', id: childId, reason: 'corrupt',
    })
  })

  it('maps a non-Error cold observation failure to unavailable', async () => {
    const { ctx, parent } = await setup([])
    const childId = await authorChild(ctx, '00000000-0000-4000-8000-00000000aa01', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('unreadable child')))
    const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery)
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id, options) => {
      if (id === childId) {
        return Promise.reject('backend unavailable') // oxlint-disable-line typescript/prefer-promise-reject-errors
      }
      return observe(id, options)
    })

    await expect(ctx.subagents.listChildren(parent.id)).resolves.toContainEqual({
      kind: 'diagnostic', id: childId, reason: 'unavailable',
    })
  })

  it('releases a cold observation when cancellation lands after its read', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    const childId = await authorChild(ctx, '00000000-0000-4000-8000-00000000aa02', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('cancelled child')))
    const dispose = vi.fn()
    vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation((id) => {
      if (id !== childId) throw new Error(`unexpected observation: ${id}`)
      controller.abort(new Error('cancelled after observation'))
      return Promise.resolve({
        source: 'prepared',
        header: {
          version: SESSION_FORMAT_VERSION,
          id: childId,
          createdAt: 1,
          parentSession: parent.id,
          origin: 'subagent',
        },
        events: [],
        cursor: -1,
        projections: { asOfSeq: -1, values: {} },
        retain: vi.fn(),
        [Symbol.dispose]: dispose,
      } as unknown as SessionObservation)
    })

    await expect(ctx.subagents.listChildren(parent.id, controller.signal))
      .rejects.toMatchObject({ code: 'CANCELLED' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('lists a one-shot child with its durable creation label', async () => {
    const { ctx, parent } = await setup([])
    const labeled = await authorChild(ctx, '00000000-0000-4000-8000-00000000ab02', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'one-shot',
      provider: 'spawn',
      label: 'labeled one-shot',
    }))
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([
      {
        kind: 'child', id: labeled, mode: 'one-shot', label: 'labeled one-shot',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('reports a live child as running while keeping settled siblings complete', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const settled = await startChild(ctx, parent, 'settled child')
    // A live child session outside persistence: publish a live session with a
    // descriptor and the parent lineage, without starting an Activation.
    const liveId = SessionId('live-child')
    const live = ctx.sessions.create(liveId, {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    live.append('turn/start', { turn: 1 })
    live.append('subagent/descriptor', descriptorPayload('live child'))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({
      kind: 'child', id: settled, label: 'settled child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
    expect(entries).toContainEqual({
      kind: 'child', id: liveId, label: 'live child', mode: 'continuable',
      activity: 'running', hasChildren: false,
    })
  })

  it('lists the last descriptor when a log carries more than one', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const healthy = await startChild(ctx, parent, 'healthy sibling')
    const events = childEvents(descriptorPayload('twice'))
    events.splice(3, 0, {
      type: 'subagent/descriptor',
      seq: SessionSeq(3),
      time: 3,
      data: descriptorPayload('twice again'),
    } as SessionEvent)
    events[4] = { ...events[4]!, seq: SessionSeq(4) }
    const doubled = await authorChild(ctx, '00000000-0000-4000-8000-00000000dupe', {
      parentSession: parent.id,
      origin: 'subagent',
    }, events)
    // The last-wins projection fold serves the final descriptor's identity; a
    // repeated descriptor is not a per-child corruption diagnostic.
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({
      kind: 'child', id: doubled, label: 'twice again', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
    expect(entries).toContainEqual({
      kind: 'child', id: healthy, label: 'healthy sibling', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
  })

  it('serves the serializable null sentinel when a later descriptor invalidates the identity', async () => {
    const { ctx, parent } = await setup([])
    const liveId = SessionId('invalidated-live-child')
    const live = ctx.sessions.create(liveId, {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    live.append('turn/start', { turn: 1 })
    live.append('subagent/descriptor', descriptorPayload('was valid'))
    expect(ctx.sessionProjections.snapshot(live).values.subagent)
      .toEqual({ mode: 'continuable', label: 'was valid', seq: SessionSeq(1) })
    // Last-wins: the malformed follow-up resets the identity to the sentinel.
    live.append(
      'subagent/descriptor',
      { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 7 } as never,
    )
    const values = ctx.sessionProjections.snapshot(live).values
    expect(values.subagent).toBeNull()
    // The sentinel survives a JSON push frame; an undefined field would be
    // dropped there and a consumer would keep the stale identity forever.
    const wired = JSON.parse(JSON.stringify(values)) as Record<string, unknown>
    expect('subagent' in wired).toBe(true)
    expect(wired['subagent']).toBeNull()
    // The listing reads the same null as no value: running → omitted.
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([])
  })

  it('diagnoses a settled child whose later descriptor invalidated the identity as corrupt', async () => {
    const { ctx, parent } = await setup([])
    const events = childEvents(descriptorPayload('was valid'))
    events.splice(3, 0, {
      type: 'subagent/descriptor',
      seq: SessionSeq(3),
      time: 3,
      data: { version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 7 },
    } as SessionEvent)
    events[4] = { ...events[4]!, seq: SessionSeq(4) }
    const invalidated = await authorChild(ctx, '00000000-0000-4000-8000-00000000ad01', {
      parentSession: parent.id,
      origin: 'subagent',
    }, events)
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([
      { kind: 'diagnostic', id: invalidated, reason: 'corrupt' },
    ])
  })

  it('serves a cached own-suffix identity directly without inspection', async () => {
    const { ctx, parent } = await setup([], { projectionCache: true })
    const child = await authorChild(ctx, '00000000-0000-4000-8000-00000000ae01', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('disk label')))
    // seq 2 >= seedLength 0: the cached identity provably comes from the
    // child's own suffix, so it is final and the log is never re-read — the
    // divergent label proves the row, not the log, produced the entry.
    ctx.sessionProjectionCache.cachedSnapshot = () => ({
      asOfSeq: SessionSeq(2),
      values: { subagent: { mode: 'continuable', label: 'cached own', seq: SessionSeq(2) } },
    })
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: child, label: 'cached own', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
    expect(inspect).not.toHaveBeenCalled()
  })

  it('refuses a cached ancestor identity from the fork seed and lets preparation rule', async () => {
    const { ctx, parent } = await setup([], { projectionCache: true })
    // A fork child: the seed replays the ancestor's descriptor (seq 2), and
    // the child's own descriptor arrives in its first own turn (seq 5).
    const seed = childEvents(descriptorPayload('ancestor label'))
    const events = [
      ...seed,
      { type: 'turn/start', seq: SessionSeq(4), time: 5, data: { turn: 2, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'subagent/descriptor', seq: SessionSeq(5), time: 6, data: descriptorPayload('own label') },
      { type: 'turn/end', seq: SessionSeq(6), time: 7, data: { turn: 2, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const forkChild = await authorChild(ctx, '00000000-0000-4000-8000-00000000ae02', {
      parentSession: parent.id,
      origin: 'subagent',
    }, events, seed.length)
    // A creation-window checkpoint carried the ANCESTOR identity: its seq 2
    // fails the own-suffix gate (< seedLength 4), so preparation rules.
    ctx.sessionProjectionCache.cachedSnapshot = () => ({
      asOfSeq: SessionSeq(2),
      values: { subagent: { mode: 'continuable', label: 'ancestor label', seq: SessionSeq(2) } },
    })
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: forkChild, label: 'own label', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['version', (meta: SessionHeader): SessionHeader => ({ ...meta, version: meta.version + 1 })],
    ['id', (meta: SessionHeader): SessionHeader => ({ ...meta, id: SessionId('another-lifecycle') })],
    ['createdAt', (meta: SessionHeader): SessionHeader => ({ ...meta, createdAt: meta.createdAt + 1 })],
    ['cwd', (meta: SessionHeader): SessionHeader => ({ ...meta, cwd: '/elsewhere' })],
    ['parentSession', (meta: SessionHeader): SessionHeader => ({ ...meta, parentSession: SessionId('another-parent') })],
    ['isSeeded', (meta: SessionHeader): SessionHeader => ({ ...meta, isSeeded: !meta.isSeeded })],
    ['delegationDepth', (meta: SessionHeader): SessionHeader => ({ ...meta, delegationDepth: (meta.delegationDepth ?? 0) + 1 })],
  ] as const)('diagnoses an inspection returning another lifecycle (%s) as corrupt', async (_field, mutate) => {
    const { ctx, parent } = await setup([textResponse('done')])
    const healthy = await startChild(ctx, parent, 'healthy sibling')
    const reborn = await authorChild(ctx, '00000000-0000-4000-8000-00000000ae03', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('reborn child')))
    // The id was re-published as a different lifecycle after enumeration.
    mutateStoredHeader(ctx, reborn, mutate)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({ kind: 'diagnostic', id: reborn, reason: 'corrupt' })
    expect(entries).toContainEqual({
      kind: 'child', id: healthy, label: 'healthy sibling', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
  })

  it('lets preparation rule when the cache serves the null sentinel', async () => {
    const { ctx, parent } = await setup([], { projectionCache: true })
    const healthy = await authorChild(ctx, '00000000-0000-4000-8000-00000000ad02', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('actually valid')))
    // A stale cached sentinel must not out-rank the authoritative re-fold.
    ctx.sessionProjectionCache.cachedSnapshot = () => ({ asOfSeq: SessionSeq(0), values: { subagent: null } })
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: healthy, label: 'actually valid', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('maps a child rejected by persistence validation to corrupt', async () => {
    const { ctx, parent } = await setup([])
    // The surface-eligible user/message lacks its required surfaceOp, so the
    // first-party inspection rejects before any projection fold can run.
    const invalid = await authorChild(ctx, '00000000-0000-4000-8000-0000000000ee', {
      parentSession: parent.id,
      origin: 'subagent',
    }, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
      },
      { type: 'subagent/descriptor', seq: SessionSeq(2), time: 3, data: descriptorPayload('broken surface') },
    ] as SessionEvent[])
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: invalid, reason: 'corrupt' }])
  })

  it('diagnoses a malformed descriptor payload as corrupt', async () => {
    const { ctx, parent } = await setup([])
    const malformed = await authorChild(ctx, '00000000-0000-4000-8000-0000000000ff', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents({ version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 7 }))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: malformed, reason: 'corrupt' }])
  })

  it('diagnoses an unknown descriptor version as corrupt', async () => {
    const { ctx, parent } = await setup([])
    const future = await authorChild(ctx, '00000000-0000-4000-8000-0000000000aa', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('from the future', SUBAGENT_DESCRIPTOR_VERSION + 1)))
    // The projection fold does not distinguish an unrecognized version from
    // other invalid descriptors: both serve no identity, and a settled
    // no-value candidate is corrupt.
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: future, reason: 'corrupt' }])
  })

  it('rejects a fork whose only descriptor belongs to its inherited seed', async () => {
    const { ctx, parent } = await setup([])
    // A seed-replayed descriptor predates this child's own suffix and cannot
    // identify the fork as a resumable child.
    const seed = childEvents(descriptorPayload('ancestor label'))
    const forkChild = await authorChild(ctx, '00000000-0000-4000-8000-0000000000f0', {
      parentSession: parent.id,
      origin: 'subagent',
    }, seed, seed.length)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([{ kind: 'diagnostic', id: forkChild, reason: 'corrupt' }])
  })

  it('does not filter by provider availability: children of unmounted providers stay listed', async () => {
    const { ctx, parent } = await setup([])
    const foreign = await authorChild(ctx, '00000000-0000-4000-8000-0000000000bb', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: 'continuable',
      provider: 'not-mounted',
      label: 'orphan provider',
    }))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: foreign, label: 'orphan provider', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('contains a foreign unit failure during a cold fold to that child as corrupt', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    ctx.sessionProjections.register(hostileProjectionDefinition)
    const healthy = await startChild(ctx, parent, 'healthy sibling')
    const poisoned = await authorChild(ctx, '00000000-0000-4000-8000-00000000d00d', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('poison me')))
    // The subagent unit itself folds this child cleanly; the FOREIGN unit's
    // view throws, and that damage stays contained to the one child.
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({ kind: 'diagnostic', id: poisoned, reason: 'corrupt' })
    expect(entries).toContainEqual({
      kind: 'child', id: healthy, label: 'healthy sibling', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
  })

  it('does not evaluate an unrelated wire view when exposing a live child identity', async () => {
    const { ctx, parent } = await setup([])
    ctx.sessionProjections.register(hostileProjectionDefinition)
    const poisonedId = SessionId('live-poisoned-child')
    const poisoned = ctx.sessions.create(poisonedId, {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    poisoned.append('turn/start', { turn: 1 })
    poisoned.append('subagent/descriptor', descriptorPayload('poison me'))
    const healthyId = SessionId('live-healthy-child')
    const healthy = ctx.sessions.create(healthyId, {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    healthy.append('turn/start', { turn: 1 })
    healthy.append('subagent/descriptor', descriptorPayload('live healthy'))
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toContainEqual({
      kind: 'child', id: poisonedId, label: 'poison me', mode: 'continuable',
      activity: 'running', hasChildren: false,
    })
    expect(entries).toContainEqual({
      kind: 'child', id: healthyId, label: 'live healthy', mode: 'continuable',
      activity: 'running', hasChildren: false,
    })
  })

  it('fails the whole enumeration when the persisted listing itself fails', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'never listed')
    ctx.sessionPersistence.list = () => Promise.reject(new Error('backend listing failed'))
    // Without any abort in flight, the original backend failure propagates
    // as the operation failure — no cancellation mapping, no diagnostic rows.
    await expect(ctx.subagents.listChildren(parent.id)).rejects.toThrow('backend listing failed')
  })

  it('maps a failed cold inspection to one unavailable diagnostic and retries it next listing', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const healthy = await startChild(ctx, parent, 'healthy sibling')
    const flaky = await authorChild(ctx, '00000000-0000-4000-8000-00000000f1a7', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('flaky storage')))
    const original = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.open = (sessionId, access, options) => {
      if (sessionId === flaky) {
        return Promise.reject(new Error('backend read failed'))
      }
      return original(sessionId, access, options)
    }
    // Per-child isolation: the failed child degrades to one diagnostic while
    // the healthy sibling stays complete.
    const degraded = await ctx.subagents.listChildren(parent.id)
    expect(degraded).toContainEqual({ kind: 'diagnostic', id: flaky, reason: 'unavailable' })
    expect(degraded).toContainEqual({
      kind: 'child', id: healthy, label: 'healthy sibling', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
    // Nothing is memoized: with the backend healthy again, the next listing
    // folds the same child to its identity.
    ctx.sessionPersistence.open = original
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toContainEqual({
      kind: 'child', id: flaky, label: 'flaky storage', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    })
  })

  it('lists compacted and uncompacted children identically', async () => {
    const { ctx, parent } = await setup([])
    const plain = await authorChild(ctx, '00000000-0000-4000-8000-00000000c0de', {
      parentSession: parent.id,
      createdAt: 1,
      origin: 'subagent',
    }, childEvents(descriptorPayload('twin child')))
    // The compacted twin: a compaction checkpoint replaces the whole surface,
    // while the append-only log retains the model-hidden descriptor event.
    const compactedEvents = childEvents(descriptorPayload('twin child'))
    compactedEvents.push({
      type: 'user/message',
      seq: SessionSeq(4),
      time: 5,
      data: createUserMessage({
        content: [{ type: 'text', text: 'summary of everything' }],
        source: { kind: 'plugin', plugin: 'compact' },
      }),
      surfaceOp: { op: 'replace', start: SessionSeq(1), end: SessionSeq(1) },
      sourceEventSeqs: [SessionSeq(1)],
    })
    const compacted = await authorChild(ctx, '00000000-0000-4000-8000-00000000c1de', {
      parentSession: parent.id,
      createdAt: 2,
      origin: 'subagent',
    }, compactedEvents)
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: plain, label: 'twin child', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
      {
        kind: 'child', id: compacted, label: 'twin child', mode: 'continuable',
        activity: 'inactive', hasChildren: false,
      },
    ])
  })

  it('reports an origin-classified grandchild without inspecting it', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'direct child')
    const grandchildId = await authorChild(ctx, '00000000-0000-4000-8000-0000000000cc', {
      parentSession: childId,
      origin: 'subagent',
    }, childEvents(descriptorPayload('grandchild')))
    const inspected: SessionId[] = []
    const original = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.open = (sessionId, access, options) => {
      inspected.push(sessionId)
      return original(sessionId, access, options)
    }
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: childId, label: 'direct child', mode: 'continuable',
        activity: 'inactive', hasChildren: true,
      },
    ])
    // The grandchild contributes only its header to the hasChildren hint.
    expect(inspected).toContain(childId)
    expect(inspected).not.toContain(grandchildId)
  })

  it('inspects each cold child exactly once and a live child never', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const coldStarted = await startChild(ctx, parent, 'cold started child')
    const coldAuthored = await authorChild(ctx, '00000000-0000-4000-8000-00000000ab01', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('cold authored child')))
    const liveId = SessionId('live-mixed-child')
    const live = ctx.sessions.create(liveId, {
      meta: { parentSession: parent.id, origin: 'subagent' },
    })
    live.append('turn/start', { turn: 1 })
    live.append('subagent/descriptor', descriptorPayload('live mixed child'))

    const inspected: SessionId[] = []
    const original = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.open = (sessionId, access, options) => {
      inspected.push(sessionId)
      return original(sessionId, access, options)
    }
    const entries = await ctx.subagents.listChildren(parent.id)
    expect(entries).toHaveLength(3)
    // The cost model: one inspection per cold child, none for a live child,
    // whose identity is served from the registry's watermark cache.
    expect(inspected.filter(id => id === coldStarted)).toHaveLength(1)
    expect(inspected.filter(id => id === coldAuthored)).toHaveLength(1)
    expect(inspected).not.toContain(liveId)
  })

  it('serves a cold child from the projection cache without any inspection', async () => {
    const { ctx, parent } = await setup([textResponse('done')], { projectionCache: true })
    const childId = await startChild(ctx, parent, 'cached child')
    // The child's turn/end and disposal are the cache's mandatory checkpoint
    // points; both writes are fail-soft asynchronous, so wait for the row.
    const header = (await ctx.sessionPersistence.list()).find(snapshot => snapshot.header.id === childId)?.header
    await vi.waitFor(() => {
      expect(ctx.sessionProjectionCache.cachedSnapshot(header!, SessionLogOffset(0))?.values.subagent).toBeDefined()
    }, { timeout: 5_000 })
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: childId, label: 'cached child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
    expect(inspect).not.toHaveBeenCalled()
  })

  it('falls back to inspection when the cache serves no identity for the child', async () => {
    const { ctx, parent } = await setup([], { projectionCache: true })
    const foreign = await authorChild(ctx, '00000000-0000-4000-8000-00000000ac01', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('uncached child')))
    const expected = [{
      kind: 'child', id: foreign, label: 'uncached child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }]
    // No stored row at all for a foreign child this process never ran.
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual(expected)
    expect(inspect).toHaveBeenCalledTimes(1)
    // A stored row whose cut predates the descriptor: the subagent key is
    // absent from the served values, and preparation still rules.
    ctx.sessionProjectionCache.cachedSnapshot = () => ({ asOfSeq: SessionSeq(0), values: {} })
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual(expected)
    expect(inspect).toHaveBeenCalledTimes(2)
  })

  it('takes the preparation rung directly when no projection cache is mounted', async () => {
    const { ctx, parent } = await setup([])
    expect(ctx.get('sessionProjectionCache')).toBeUndefined()
    const foreign = await authorChild(ctx, '00000000-0000-4000-8000-00000000ac02', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('uncacheable child')))
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: foreign, label: 'uncacheable child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('silently falls through to preparation when the cache read throws', async () => {
    const { ctx, parent } = await setup([], { projectionCache: true })
    const recovered = await authorChild(ctx, '00000000-0000-4000-8000-00000000ac03', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('recovered child')))
    ctx.sessionProjectionCache.cachedSnapshot = () => {
      // A poisoned stored row (any unit's) detonates at view time; the cache
      // is derived data, so its failure must not become a verdict.
      throw new Error('poisoned cache row')
    }
    const inspect = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: recovered, label: 'recovered child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('does not count an ordinary grandchild without subagent origin', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'direct child')
    await authorChild(ctx, '00000000-0000-4000-8000-0000000000f1', {
      parentSession: childId,
    }, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])

    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: childId, label: 'direct child', mode: 'continuable',
      activity: 'inactive', hasChildren: false,
    }])
  })

  it('counts an origin-classified diagnostic grandchild', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const childId = await startChild(ctx, parent, 'direct child')
    const diagnosticId = await authorChild(ctx, '00000000-0000-4000-8000-0000000000f2', {
      parentSession: childId,
      origin: 'subagent',
    }, childEvents({ version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 7 }))

    await expect(ctx.subagents.listChildren(childId)).resolves.toEqual([
      { kind: 'diagnostic', id: diagnosticId, reason: 'corrupt' },
    ])
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([{
      kind: 'child', id: childId, label: 'direct child', mode: 'continuable',
      activity: 'inactive', hasChildren: true,
    }])
  })

  it('a pre-aborted signal stops before any persistence read', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    controller.abort()
    ctx.sessionPersistence.list = () => Promise.reject(new Error('must not be called'))
    await expect(ctx.subagents.listChildren(parent.id, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('forwards cancellation to the persisted listing and reports the stable subagent error', async () => {
    const { ctx, parent } = await setup([])
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.list = (options) => {
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('backend listing aborted'))
        }, { once: true })
      })
    }
    const listing = ctx.subagents.listChildren(parent.id, controller.signal)
    await entered.promise
    controller.abort()
    await expect(listing).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('forwards cancellation to a cold inspection and reports the stable subagent error', async () => {
    const { ctx, parent } = await setup([])
    await authorChild(ctx, '00000000-0000-4000-8000-00000000ce11', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('cancelled cold read')))
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    ctx.sessionPersistence.open = (_sessionId, _access, options) => {
      entered.resolve(undefined)
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new Error('backend read aborted'))
        }, { once: true })
      })
    }
    const listing = ctx.subagents.listChildren(parent.id, controller.signal)
    await entered.promise
    controller.abort()
    await expect(listing).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('an abort observed after a cold inspection resolves cannot become a successful result', async () => {
    const { ctx, parent } = await setup([])
    await authorChild(ctx, '00000000-0000-4000-8000-00000000ce12', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('cancelled mid-listing')))
    const controller = new AbortController()
    const original = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.open = async (sessionId, access, options) => {
      const result = await original(sessionId, access, options)
      controller.abort()
      return result
    }
    // The post-read checkpoint throws the stable subagent error instead of
    // interpreting the fully-read log as a successful listing.
    await expect(ctx.subagents.listChildren(parent.id, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'CANCELLED' }) as Error)
  })

  it('a cold inspection failure during an abort cannot become an unavailable diagnostic', async () => {
    const { ctx, parent } = await setup([])
    await authorChild(ctx, '00000000-0000-4000-8000-00000000ce13', {
      parentSession: parent.id,
      origin: 'subagent',
    }, childEvents(descriptorPayload('aborted behind a failure')))
    const controller = new AbortController()
    ctx.sessionPersistence.open = () => {
      // The read fails while the caller aborts: cancellation normalization
      // must fail the listing rather than return a one-diagnostic success.
      controller.abort()
      return Promise.reject(new Error('backend read failed'))
    }
    await expect(ctx.subagents.listChildren(parent.id, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
  })

  it('returns an empty array for a parent with no children', async () => {
    const { ctx, parent } = await setup([])
    await ctx.sessions.flush(parent.session)
    await expect(ctx.subagents.listChildren(parent.id)).resolves.toEqual([])
  })

  it('SubagentError from listChildren is typed with its stable code', async () => {
    const { ctx, parent } = await setup([], { sessionProjections: false })
    const caught: unknown = await ctx.subagents.listChildren(parent.id).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(SubagentError)
    expect((caught as SubagentError).code).toBe('SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE')
  })
})

describe('SubagentRuntime.listDescendants', () => {
  it('flattens the complete tree in stable pre-order with verified parent and depth', async () => {
    const { ctx, parent } = await setup([])
    const childA = await authorChild(ctx, '00000000-0000-4000-8000-00000000aaa1', {
      parentSession: parent.id,
      createdAt: 1,
      origin: 'subagent',
    }, childEvents(descriptorPayload('branch a')))
    const grandchild = await authorChild(ctx, '00000000-0000-4000-8000-00000000aaa2', {
      parentSession: childA,
      createdAt: 2,
      origin: 'subagent',
    }, childEvents(descriptorPayload('under a')))
    const childB = await authorChild(ctx, '00000000-0000-4000-8000-00000000aaa3', {
      parentSession: parent.id,
      createdAt: 3,
      origin: 'subagent',
    }, childEvents(descriptorPayload('branch b')))

    const entries = await ctx.subagents.listDescendants(parent.id)
    expect(entries).toEqual([
      {
        kind: 'child', id: childA, label: 'branch a', mode: 'continuable',
        activity: 'inactive', hasChildren: true, parentId: parent.id, depth: 1,
      },
      {
        kind: 'child', id: grandchild, label: 'under a', mode: 'continuable',
        activity: 'inactive', hasChildren: false, parentId: childA, depth: 2,
      },
      {
        kind: 'child', id: childB, label: 'branch b', mode: 'continuable',
        activity: 'inactive', hasChildren: false, parentId: parent.id, depth: 1,
      },
    ])
  })

  it('returns an empty result when the root has no descendants', async () => {
    const { ctx, parent } = await setup([])
    await ctx.sessions.flush(parent.session)
    await expect(ctx.subagents.listDescendants(parent.id)).resolves.toEqual([])
  })

  it('omits a live creation-window candidate while continuing through its subtree', async () => {
    const { ctx, parent } = await setup([])
    const bareId = SessionId('live-creation-window')
    const bare = ctx.sessions.create(bareId, {
      meta: { createdAt: 1, parentSession: parent.id, origin: 'subagent' },
    })
    bare.append('turn/start', { turn: 1 })
    const below = await authorChild(ctx, '00000000-0000-4000-8000-00000000aaaf', {
      parentSession: bareId,
      createdAt: 2,
      origin: 'subagent',
    }, childEvents(descriptorPayload('below the creation window')))

    await expect(ctx.subagents.listDescendants(parent.id)).resolves.toEqual([{
      kind: 'child', id: below, label: 'below the creation window', mode: 'continuable',
      activity: 'inactive', hasChildren: false, parentId: bareId, depth: 2,
    }])
  })

  it('contains a corrupt parent cycle without revisiting the requested root', async () => {
    const { ctx } = await setup([])
    const rootId = SessionId('cycle-root')
    const nodeId = SessionId('cycle-node')
    await authorChild(ctx, rootId, {
      parentSession: nodeId,
      createdAt: 2,
    }, childEvents(descriptorPayload('ordinary cycle root')))
    await authorChild(ctx, nodeId, {
      parentSession: rootId,
      createdAt: 1,
      origin: 'subagent',
    }, childEvents(descriptorPayload('cycle child')))

    await expect(ctx.subagents.listDescendants(rootId)).resolves.toEqual([{
      kind: 'child', id: nodeId, label: 'cycle child', mode: 'continuable',
      activity: 'inactive', hasChildren: false, parentId: rootId, depth: 1,
    }])
  })


  it('walks a deeply nested ordinary-session chain without consuming the call stack', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([])
    const depth = 10_000
    let parentId = parent.id
    for (let level = 1; level < depth; level += 1) {
      const session = ctx.sessions.create(SessionId(`deep-ordinary-${level}`), {
        meta: { createdAt: level, parentSession: parentId },
      })
      parentId = session.id
    }
    const leafId = SessionId('deep-subagent-leaf')
    const leaf = ctx.sessions.create(leafId, {
      meta: { createdAt: depth, parentSession: parentId, origin: 'subagent' },
    })
    leaf.append('turn/start', { turn: 1 })
    leaf.append('subagent/descriptor', descriptorPayload('deep leaf'))

    await expect(ctx.subagents.listDescendants(parent.id)).resolves.toEqual([{
      kind: 'child', id: leafId, label: 'deep leaf', mode: 'continuable',
      activity: 'running', hasChildren: false, parentId, depth,
    }])
  })

  it('discovers continuable descendants below ordinary and one-shot intermediates', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    // An ordinary fork has no descriptor: omitted itself, subtree still walked.
    const fork = ctx.sessions.fork(parent.session, undefined, SessionId('plain-fork'))
    await ctx.sessions.flush(fork)
    const underFork = await authorChild(ctx, '00000000-0000-4000-8000-00000000bbb1', {
      parentSession: fork.header.id,
      createdAt: 2,
      origin: 'subagent',
    }, childEvents(descriptorPayload('under the fork')))
    // A real one-shot child, then a continuable authored below it.
    const oneShot = await ctx.subagents.start('spawn', {
      label: 'one-shot intermediate',
      prompt: [{ type: 'text', text: 'one-shot task' }],
      parent,
      signal: testSignal,
    })
    await oneShot.result
    await ctx.sessions.flush(oneShot.localAgent!.session)
    const oneShotId = oneShot.id
    await oneShot.dispose()
    const underOneShot = await authorChild(ctx, '00000000-0000-4000-8000-00000000bbb2', {
      parentSession: oneShotId,
      createdAt: 9_999_999_999_999,
      origin: 'subagent',
    }, childEvents(descriptorPayload('under the one-shot')))

    const entries = await ctx.subagents.listDescendants(parent.id)
    // The fork is absent (descriptor-less); the one-shot is present with its
    // mode so a caller can see the lineage it walked through.
    expect(entries.map(entry => entry.id)).not.toContain(fork.header.id)
    expect(entries).toContainEqual({
      kind: 'child', id: underFork, label: 'under the fork', mode: 'continuable',
      activity: 'inactive', hasChildren: false, parentId: fork.header.id, depth: 2,
    })
    expect(entries).toContainEqual(expect.objectContaining({
      kind: 'child', id: oneShotId, mode: 'one-shot', parentId: parent.id, depth: 1,
    }))
    expect(entries).toContainEqual({
      kind: 'child', id: underOneShot, label: 'under the one-shot', mode: 'continuable',
      activity: 'inactive', hasChildren: false, parentId: oneShotId, depth: 2,
    })
    // Pre-order: every child appears after its own parent entry.
    const position = new Map(entries.map((entry, index) => [entry.id, index]))
    expect(position.get(underOneShot)!).toBeGreaterThan(position.get(oneShotId)!)
  })

  it('diagnoses a settled descriptor-less node while walking its subtree', async () => {
    const { ctx, parent } = await setup([])
    // A settled origin-marked candidate without an identity is corrupt under
    // the projection contract, but its subtree remains independently visible.
    const bare = await authorChild(ctx, '00000000-0000-4000-8000-00000000eee1', {
      parentSession: parent.id,
      createdAt: 1,
      origin: 'subagent',
    }, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[])
    const below = await authorChild(ctx, '00000000-0000-4000-8000-00000000eee2', {
      parentSession: bare,
      createdAt: 2,
      origin: 'subagent',
    }, childEvents(descriptorPayload('below the bare node')))

    await expect(ctx.subagents.listDescendants(parent.id)).resolves.toEqual([
      { kind: 'diagnostic', id: bare, reason: 'corrupt', parentId: parent.id, depth: 1 },
      {
        kind: 'child', id: below, label: 'below the bare node', mode: 'continuable',
        activity: 'inactive', hasChildren: false, parentId: bare, depth: 2,
      },
    ])
  })

  it('keeps traversing below a corrupt intermediate and positions its diagnostic', async () => {
    const { ctx, parent } = await setup([])
    const corrupt = await authorChild(ctx, '00000000-0000-4000-8000-00000000ccc1', {
      parentSession: parent.id,
      createdAt: 1,
      origin: 'subagent',
    }, childEvents(descriptorPayload('unsupported descriptor', 999)))
    const below = await authorChild(ctx, '00000000-0000-4000-8000-00000000ccc2', {
      parentSession: corrupt,
      createdAt: 2,
      origin: 'subagent',
    }, childEvents(descriptorPayload('below the corrupt node')))

    const entries = await ctx.subagents.listDescendants(parent.id)
    expect(entries).toEqual([
      { kind: 'diagnostic', id: corrupt, reason: 'corrupt', parentId: parent.id, depth: 1 },
      {
        kind: 'child', id: below, label: 'below the corrupt node', mode: 'continuable',
        activity: 'inactive', hasChildren: false, parentId: corrupt, depth: 2,
      },
    ])
  })

  it('verifies a cold candidate still belongs to its enumerated lifecycle', async () => {
    const { ctx, parent } = await setup([])
    const childId = await authorChild(ctx, '00000000-0000-4000-8000-00000000ddd1', {
      parentSession: parent.id,
      createdAt: 1,
      origin: 'subagent',
    }, childEvents(descriptorPayload('lineage checked')))
    // The exact read reports a different durable parent than enumeration did.
    mutateStoredHeader(ctx, childId, meta => ({ ...meta, parentSession: SessionId('someone-else') }))
    await expect(ctx.subagents.listDescendants(parent.id)).resolves.toEqual([
      { kind: 'diagnostic', id: childId, reason: 'corrupt', parentId: parent.id, depth: 1 },
    ])
  })

  it('a pre-aborted signal stops the descendant scan before persistence reads', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    await startChild(ctx, parent, 'never read')
    const list = vi.spyOn(ctx.sessionPersistence, 'list')
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.subagents.listDescendants(parent.id, controller.signal)).rejects.toThrow(
      expect.objectContaining({ code: 'CANCELLED' }) as Error,
    )
    expect(list).not.toHaveBeenCalled()
  })

  it('fails loud when the projection registry is not mounted', async () => {
    const { ctx, parent } = await setup([], { sessionProjections: false })
    await expect(ctx.subagents.listDescendants(parent.id)).rejects.toThrow(
      expect.objectContaining({ code: 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE' }) as Error,
    )
  })
})
