/**
 * Session Controller projection paths: the history tail page's
 * projections block reads the registry's watermark snapshot (asOfSeq = last
 * event seq, one consistent cut); loadOlder pages never carry the block; a
 * composition without the registry serves histories without it; a disposed
 * registration's key leaves subsequent responses; and every unit change is
 * pushed through the control stream.
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { SessionControlFrame, SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/last-user': LastUserState
    'test/internal-count': number
    'test/private-prompt': string | null
  }
  interface SessionProjectionMap {
    'test/last-user': { text: string } | null
  }
}

function request<P>(payload: P): P {
  return payload
}

function page(
  remote: TestSessionRemote,
  request: { sessionId: SessionId; throughSeq: number; beforeSeq?: number; maxMessages?: number },
) {
  return remote.page({
    address: { kind: 'session', sessionId: request.sessionId },
    throughSeq: request.throughSeq,
    ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
    ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
  })
}

/** Read and close one snapshot-first follow generation. */
async function opening(
  remote: TestSessionRemote,
  sessionId: SessionId,
  maxMessages?: number,
): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = remote.follow({
    address: { kind: 'session', sessionId },
    ...(maxMessages === undefined ? {} : { maxMessages }),
  }, abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  abort.abort()
  await iterator.return?.()
  if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
  return first.value
}

/** Whole-value unit folding the latest user/message text; null before the first. */
type LastUserState = { text: string } | null
const lastUserUnit = () => ({
  key: 'test/last-user',
  stateSchema: z.union([z.object({ text: z.string() }), z.null()]),
  init: () => null,
  apply: (state, event) => (event.type === 'user/message'
    ? { text: (event.data.content[0] as { text?: string }).text ?? '' }
    : state),
  wire: {
    viewSchema: z.union([z.object({ text: z.string() }), z.null()]),
    view: state => state,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/last-user', LastUserState>

const internalCountUnit = () => ({
  key: 'test/internal-count',
  stateSchema: z.number().int().nonnegative(),
  init: () => 0,
  apply: (state: number) => state + 1,
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/internal-count', number>

const privatePromptUnit = () => ({
  key: 'test/private-prompt',
  stateSchema: z.string().nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'user/message'
    ? (event.data.content[0] as { text?: string }).text ?? ''
    : state),
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/private-prompt', string | null>

async function harness(withRegistry: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (withRegistry) await ctx.plugin(SessionProjectionRegistry)
  const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
  // The gateway reads both the session and durable inbox baseline.
  ctx.agents.register({ id: session.id, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }), status: 'idle', ctx } as Agent)
  return { ctx, session }
}

/** Append `count` user messages so the log has paginable message boundaries. */
function seedMessages(session: Session, count: number): void {
  for (let i = 0; i < count; i++) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `m${i}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
}

const remote = (ctx: Context) => createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

describe('session.history projections block', () => {
  it('tracks pending and used model selections across repeated request headers', async () => {
    const { ctx, session } = await harness(true)
    remote(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    const selected = { provider: 'p', model: 'next' }
    session.append('model/selection', selected)
    session.append('model/selection', selected)
    session.append('request/header', {
      header: { config: { provider: 'p', model: 'used' } }, reason: 'initial',
    })
    session.append('request/header', {
      header: { config: { provider: 'p', model: 'used' } }, reason: 'initial',
    })

    expect(ctx.sessionProjections.snapshot(session).values.modelSelection).toEqual({
      lastUsed: { provider: 'p', model: 'used' },
      next: selected,
    })

    session.append('request/header', {
      header: { config: selected }, reason: 'initial',
    })
    expect(ctx.sessionProjections.snapshot(session).values.modelSelection).toEqual({
      lastUsed: selected,
      next: selected,
    })
  })

  it('serves the unit value on the tail page with asOfSeq = last event seq', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(lastUserUnit())
    seedMessages(session, 3)
    const snapshot = await opening(remote(ctx), session.id)
    const { records, projections } = snapshot
    expect(projections.asOfSeq).toBe(session.seq - 1)
    expect(projections.values['test/last-user']).toEqual({ text: 'm2' })
    // asOfSeq IS the window tail: the last served event carries it.
    const last = records.at(-1)
    expect(last?.event.seq).toBe(projections.asOfSeq)
  })

  it('returns a complete current replacement cut on each follow generation', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(lastUserUnit())
    seedMessages(session, 2)

    const snapshot = await opening(remote(ctx), session.id)

    expect(snapshot.records.map(record => record.event.seq)).toEqual([0, 1])
    expect(snapshot.projections.asOfSeq).toBe(1)
    expect(snapshot.projections.values).toEqual(
      expect.objectContaining({ 'test/last-user': { text: 'm1' } }),
    )
  })

  it('projects an empty log at cursor -1', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(lastUserUnit())

    const snapshot = await opening(remote(ctx), session.id)

    expect(snapshot.records).toEqual([])
    expect(snapshot.projections.asOfSeq).toBe(-1)
    expect(snapshot.projections.values).toEqual(
      expect.objectContaining({ 'test/last-user': null }),
    )
  })

  it('publishes the attachments imageLimits as a constant unit while both seams are composed', async () => {
    const { ctx, session } = await harness(true)
    const limits = {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2000,
      mediaTypes: ['image/png'] as const,
    }
    await ctx.plugin(class extends AttachmentStore {
      readonly imageLimits = limits
      validateImage(): Promise<void> { return Promise.resolve() }
      saveImage(): Promise<never> { return Promise.reject(new Error('unused')) }
      readImage(): Promise<never> { return Promise.reject(new Error('unused')) }
    })
    const gateway = remote(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    seedMessages(session, 2)
    const snapshot = await opening(gateway, session.id)
    expect(snapshot.projections.values['imageLimits']).toEqual(limits)
    // Constant unit: appending events must never broadcast an imageLimits projection.
    await new Promise(resolve => setTimeout(resolve, 0))
    const abort = new AbortController()
    const iterator = gateway.control(abort.signal)[Symbol.asyncIterator]()
    await iterator.next()
    const next = iterator.next()
    seedMessages(session, 1)
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(next).resolves.toMatchObject({
      done: false,
      value: { type: 'projection', key: 'sessionListMetadata' },
    })
    const extra = iterator.next()
    const quiet = Symbol('quiet')
    expect(await Promise.race([
      extra,
      new Promise<typeof quiet>(resolve => setTimeout(() => { resolve(quiet) }, 0)),
    ])).toBe(quiet)
    abort.abort()
    await expect(extra).resolves.toEqual({ done: true, value: undefined })
  })

  it('leaves the imageLimits key absent while no attachment service is composed', async () => {
    const { ctx, session } = await harness(true)
    seedMessages(session, 1)
    const snapshot = await opening(remote(ctx), session.id)
    expect('imageLimits' in snapshot.projections.values).toBe(false)
  })

  it('never carries the block on loadOlder pages (beforeSeq present)', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(lastUserUnit())
    seedMessages(session, 5)
    const older = await page(remote(ctx), request({
      sessionId: session.id, throughSeq: session.seq - 1, beforeSeq: 3, maxMessages: 2,
    }))
    expect(older.ok).toBe(true)
    if (!older.ok) throw new Error('unreachable')
    expect('projections' in older.value).toBe(false)
  })

  it('serves no block when the composition has no projection registry', async () => {
    const { ctx, session } = await harness(false)
    seedMessages(session, 2)
    const response = await page(remote(ctx), request({ sessionId: session.id, throughSeq: session.seq - 1 }))
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    expect('projections' in response.value).toBe(false)
  })

  it('never exposes a host-only unit through history, listing, or push frames', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(internalCountUnit())
    const proxy = remote(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    const abort = new AbortController()
    const iterator = proxy.control(abort.signal)[Symbol.asyncIterator]()
    const baseline = await iterator.next()
    if (baseline.done || baseline.value.type !== 'baseline') {
      throw new Error('control stream ended before its baseline')
    }
    expect('test/internal-count' in (baseline.value.value.projections[session.id]?.values ?? {}))
      .toBe(false)

    seedMessages(session, 1)
    const changed = await iterator.next()
    expect(changed).toMatchObject({
      done: false,
      value: { type: 'projection', key: 'sessionListMetadata' },
    })
    abort.abort()
    await iterator.return?.()

    const history = await opening(proxy, session.id)
    expect('test/internal-count' in history.projections.values).toBe(false)
    const listing = await proxy.list(request({}))
    if (!listing.ok) throw new Error('listing failed')
    const row = listing.value.items.find(item => item.sessionId === session.id)
    expect('test/internal-count' in (row?.projections?.values ?? {})).toBe(false)
  })

  it('drops a disposed registration from subsequent tail pages (empty block, key absent)', async () => {
    const { ctx, session } = await harness(true)
    const dispose = ctx.sessionProjections.register(lastUserUnit())
    seedMessages(session, 1)
    const proxy = remote(ctx)
    const before = await opening(proxy, session.id)
    expect(before.projections.values['test/last-user']).toEqual({ text: 'm0' })

    dispose()
    const after = await opening(proxy, session.id)
    // The registry stays mounted; only the disposed key leaves while the
    // gateway-owned Session-list unit remains.
    expect(after.projections.asOfSeq).toBe(session.seq - 1)
    expect('test/last-user' in after.projections.values).toBe(false)
    expect(after.projections.values.sessionListMetadata).toEqual({
      blank: true,
      lastPromptAt: session.eventAt(session.seq - 1)?.time,
    })
  })

  it('removes the gateway-owned Session-list unit when the gateway fiber unloads', async () => {
    const { ctx, session } = await harness(true)
    expect('sessionListMetadata' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = ctx.plugin(Object.assign((gatewayCtx: Context) => {
      createSessionTestRemote(gatewayCtx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    }, { inject: ['sessions', 'agents', 'sessionProjections'] }))
    await fiber.await()
    await vi.waitFor(() => {
      expect(ctx.sessionProjections.snapshot(session).values.sessionListMetadata)
        .toEqual({ blank: true, lastPromptAt: null })
    })
    await fiber.dispose()
    expect('sessionListMetadata' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })
})

describe('session.list projections column', () => {
  it('serves every already-materialized wire value from the live registry without folding', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(lastUserUnit())
    const gateway = remote(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    session.append('turn/start', { turn: 1 })
    seedMessages(session, 1)
    const response = await gateway.list(request({}))
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === session.id)
    expect(row?.projections?.values['test/last-user']).toEqual({ text: 'm0' })
    expect(row?.projections?.values.sessionListMetadata).toEqual({
      blank: false,
      lastPromptAt: session.eventAt(session.seq - 1)?.time,
    })
    expect(row?.projections?.asOfSeq).toBe(session.seq - 1)
  })

  it('lists the latest preset selected by a blank Session instead of its creation preset', async () => {
    const { ctx } = await harness(true)
    const session = ctx.sessions.create(SessionId('preset-list'), {
      meta: { cwd: '/workspace', agentPreset: 'standard' },
    })
    ctx.sessionProjections.register(agentPresetProjectionDefinition)
    const gateway = remote(ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    session.append('agent-preset/selected', { agentPreset: 'minimal' })

    const response = await gateway.list(request({}))
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === session.id)
    expect(row?.projections?.values.agentPreset).toBe('minimal')
  })

  it('omits an unmaterialized live projection instead of folding history for listing', async () => {
    const { ctx, session } = await harness(true)
    seedMessages(session, 1)
    const unit = lastUserUnit()
    const apply = vi.fn(unit.apply)
    ctx.sessionProjections.register({ ...unit, apply })

    const response = await remote(ctx).list(request({}))
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === session.id)
    expect(row).toBeDefined()
    expect('test/last-user' in (row?.projections?.values ?? {})).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('omits the column entirely when no registry is mounted', async () => {
    const { ctx, session } = await harness(false)
    seedMessages(session, 1)
    const response = await remote(ctx).list(request({}))
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === session.id)
    expect(row).toBeDefined()
    expect(row !== undefined && 'projections' in row).toBe(false)
  })

  it('serves every available cold projection hint from the cache with zero log loads', async () => {
    const { ctx } = await harness(true)
    const coldId = SessionId('session-cold-listing')
    const load = () => { throw new Error('list must not load event logs') }
    ctx.provide('sessionPersistence', {
      list: async () => [{ version: 0, id: coldId, createdAt: 5, cwd: '/tmp' }],
      locate: () => undefined,
      load,
      inspect: load,
      readFrom: load,
    } as never)
    ctx.provide('sessionProjectionCache', {
      // The carrier hands the listed header through as the identity witness.
      cachedSnapshot: (meta: { id: unknown; createdAt: number }) =>
        (meta.id === coldId && meta.createdAt === 5
          ? {
            asOfSeq: 7,
            values: {
              'test/last-user': { text: 'cached' },
              sessionListMetadata: { blank: false, lastPromptAt: 6 },
              title: 'Cached title',
            },
          }
          : undefined),
    } as never)
    const response = await remote(ctx).list(request({}))
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === coldId)
    expect(row?.running).toBe(false)
    expect(row?.projections).toEqual({
      asOfSeq: 7,
      values: {
        'test/last-user': { text: 'cached' },
        sessionListMetadata: { blank: false, lastPromptAt: 6 },
        title: 'Cached title',
      },
    })
  })

  it('keeps persisted host-only state out of a cold session.list response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-api-projcache-'))
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionProjectionRegistry)
      ctx.sessionProjections.register(privatePromptUnit())
      await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
      const gateway = remote(ctx)
      await new Promise(resolve => setTimeout(resolve, 0))

      const id = SessionId('session-cold-host-state')
      const secret = 'private prompt text from the cache'
      let session: Session | undefined
      const owner = await ctx.plugin(Object.assign((sessionCtx: Context) => {
        session = sessionCtx.sessions.create(id, { meta: { createdAt: 5, cwd: '/workspace' } })
      }, { inject: ['sessions'] }))
      if (session === undefined) throw new Error('session was not created')
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: secret }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      await ctx.sessionProjectionCache.write(session)
      const stored = await readFile(
        join(root, projectionCacheDomainSpec.name, 'sessions', `${id}.json`),
        'utf8',
      )
      expect(stored).toContain(secret)

      const header = session.header
      await owner.dispose()
      expect(ctx.sessions.get(id)).toBeUndefined()
      ctx.provide('sessionPersistence', {
        list: async () => [header],
        locate: () => undefined,
      } as never)

      const response = await gateway.list(request({}))
      if (!response.ok) throw new Error('unreachable')
      const row = response.value.items.find(item => item.sessionId === id)
      expect(row?.projections?.values.sessionListMetadata).toMatchObject({ blank: false })
      expect('test/private-prompt' in (row?.projections?.values ?? {})).toBe(false)
      expect(JSON.stringify(row)).not.toContain(secret)
    } finally {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cold rows without a cache plugin (or without a stored row) just lack the column', async () => {
    const { ctx } = await harness(true)
    const coldId = SessionId('session-cold-uncached')
    ctx.provide('sessionPersistence', {
      list: async () => [{ version: 0, id: coldId, createdAt: 5, cwd: '/tmp' }],
      locate: () => undefined,
    } as never)
    const response = await remote(ctx).list(request({}))
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === coldId)
    expect(row).toBeDefined()
    expect(row !== undefined && 'projections' in row).toBe(false)
  })

  it('a throwing column read degrades that row, never the listing', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register({
      ...lastUserUnit(),
      wire: {
        viewSchema: z.union([z.object({ text: z.string() }), z.null()]),
        view: () => { throw new Error('unit exploded') },
      },
    })
    seedMessages(session, 1)
    const response = await remote(ctx).list(request({}))
    if (!response.ok) throw new Error('unreachable')
    const row = response.value.items.find(item => item.sessionId === session.id)
    expect(row).toBeDefined()
    expect(row !== undefined && 'projections' in row).toBe(false)
  })
})

describe('Session control projection frames', () => {
  /** Drain frames until `count` projection replacements arrive. */
  async function collect(
    iterable: AsyncIterable<SessionControlFrame>,
    count: number,
    abort: AbortController,
  ): Promise<SessionControlFrame[]> {
    const frames: SessionControlFrame[] = []
    for await (const frame of iterable) {
      frames.push(frame)
      if (frames.filter(candidate => candidate.type === 'projection').length >= count) abort.abort()
    }
    return frames
  }

  it('broadcasts changed view references with the causing seq and skips same-reference applies', async () => {
    const { ctx, session } = await harness(true)
    ctx.sessionProjections.register(lastUserUnit())
    const proxy = remote(ctx)
    // The controller's onChanged subscription lives in an inject child whose
    // fiber activates asynchronously; yield until it lands before appending.
    await new Promise(resolve => setTimeout(resolve, 0))
    const abort = new AbortController()
    const stream = proxy.control(abort.signal)
    const collected = collect(stream, 5, abort)

    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    seedMessages(session, 1)
    now.mockReturnValue(200)
    session.append('turn/start', { turn: 1 })
    now.mockReturnValue(300)
    // The equal payload is a new object, so Object.is still treats its view as changed.
    seedMessages(session, 1)
    now.mockRestore()

    const frames = await collected
    const pushes = frames.filter(
      (f): f is Extract<SessionControlFrame, { type: 'projection' }> =>
        f.type === 'projection' && f.key === 'test/last-user',
    )
    expect(pushes).toEqual([
      { type: 'projection', sessionId: session.id, key: 'test/last-user', value: { text: 'm0' }, seq: 0 },
      { type: 'projection', sessionId: session.id, key: 'test/last-user', value: { text: 'm0' }, seq: 2 },
    ])
    expect(frames.filter(
      (f): f is Extract<SessionControlFrame, { type: 'projection' }> =>
        f.type === 'projection' && f.key === 'sessionListMetadata',
    )).toEqual([
      { type: 'projection', sessionId: session.id, key: 'sessionListMetadata', value: { blank: true, lastPromptAt: 100 }, seq: 0 },
      { type: 'projection', sessionId: session.id, key: 'sessionListMetadata', value: { blank: false, lastPromptAt: 100 }, seq: 1 },
      { type: 'projection', sessionId: session.id, key: 'sessionListMetadata', value: { blank: false, lastPromptAt: 300 }, seq: 2 },
    ])
    // Frame seq aligns with the tail block's asOfSeq vocabulary (higher-seq-wins compatible).
    const tail = await opening(proxy, session.id)
    expect(tail.projections.asOfSeq).toBe(pushes.at(-1)?.seq)
  })
})
