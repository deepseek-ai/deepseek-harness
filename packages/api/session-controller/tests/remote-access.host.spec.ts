/**
 * Session Controller under non-owner callers: the Session resource kind it
 * registers and its default resolver, which supplies the identities of
 * `session/page` and `session/follow`, `session/list`, `session/search`, and
 * `session/control` called through a `global` role and filtered per Session
 * through `remoteAccess.allows()`, the caller recorded on prompt sources, and
 * `session/projections` admitted per Session through the Gateway.
 */

import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import type { RemoteAccessBinding, RemoteAccessRole } from '@deepseek-ai/dsh-api-remote-access'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods, type PeerId, type PeerScope, type Principal, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type SessionController from '../src/index.ts'
import { ApiSessionList } from '../src/list.ts'
import type { SessionControlFrame, SessionRequestId, SessionSearchValue } from '../src/types.ts'
import { createSessionTestController } from './test-remote.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

const OWNER: Principal = { kind: 'owner' }
const GUEST: Principal = { kind: 'test-guest', guest: 'session-controller' }
const SHARED = SessionId('shared-session')
const PRIVATE = SessionId('private-session')

/** Calls the Session list and control methods; each item still needs a Session role. */
const LISTER: RemoteAccessRole<'global'> = { name: 'test:session-lister', resource: 'global', actions: ['session/list', 'session/control'] }
/** Reads one Session: its list row, its control projections, and its stored projections. */
const READER: RemoteAccessRole<'session'> = {
  name: 'test:session-reader', resource: 'session', actions: ['session/list', 'session/control', 'session/projections'],
}
const LIST_CALLS: RemoteAccessBinding = { role: LISTER, resource: { kind: 'global' } }
const READS_SHARED: RemoteAccessBinding = { role: READER, resource: { kind: 'session', id: SHARED } }
const SEARCH_CALLS: RemoteAccessBinding = {
  role: { name: 'test:session-searcher', resource: 'global', actions: ['session/search'] },
  resource: { kind: 'global' },
}
const SEARCHES_SHARED: RemoteAccessBinding = {
  role: { name: 'test:session-search-reader', resource: 'session', actions: ['session/search'] },
  resource: { kind: 'session', id: SHARED },
}

const owned = new Set<Context>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/**
 * Register the guest policy.
 * @returns the bindings the policy answers with; edits apply from the next Remote call.
 */
function guestPolicy(ctx: Context, ...bindings: RemoteAccessBinding[]): RemoteAccessBinding[] {
  const held = [...bindings]
  ctx.remoteAccess.registerPolicy('test-guest', { bindings: () => held })
  return held
}

/** Invoke `session/<method>` as the guest through the Gateway. */
function guestCall(ctx: Context, method: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const peer: PeerScope = { id: 'session-access-peer' as PeerId, ctx, principal: GUEST, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} }
  return ctx.typertGateway.invoke({ peer, namespace: 'session', method, args })
}

async function harness(): Promise<{
  readonly ctx: Context
  readonly controller: SessionController
  readonly shared: Agent
  readonly hidden: Agent
  /** The Context a Gateway dispatch of `session/<method>` binds for `principal`. */
  readonly as: (principal: Principal, method: string) => Context
}> {
  const ctx = new Context()
  owned.add(ctx)
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  const loop = await mountAgentLoopTestHarness(ctx)
  const shared = await loop.create(SHARED, {}, { cwd: '/tmp' })
  const hidden = await loop.create(PRIVATE, {}, { cwd: '/tmp' })
  const controller = await createSessionTestController(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  const as = (principal: Principal, method: string): Context => {
    const invocation: RemoteInvocation = {
      request: { namespace: 'session', method, args: {} },
      service: 'sessionController',
      peer: { id: 'session-access-peer' as PeerId, ctx, principal, interactions: 'answer', signal: new AbortController().signal, dispose: async () => {} },
      signal: new AbortController().signal,
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    }
    return ctx.extend({ invocation })
  }
  return { ctx, controller, shared, hidden, as }
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('Session Controller access', () => {
  it('owns the Session resource kind and its default resolver', async () => {
    const { ctx } = await harness()
    expect(() => ctx.typert.resources.register('session', { field: 'sessionId' })).toThrow(/already registered/)
  })

  it('reads the Session resource of page and follow requests from the addressed Session', async () => {
    const { ctx, controller } = await harness()
    const resource = ctx.typert.resources.get('session')
    if (resource?.resolve === undefined) throw new Error('Session resource resolver is missing')
    for (const method of ['page', 'follow']) {
      const marker = remoteMethods(controller).find(marker => marker.method === method)
      expect(marker).toBeDefined()
      expect(marker?.resources?.['session']).toBeUndefined()
    }
    const resolve = (request: unknown) => resource.resolve({ args: { request }, parameters: [{ name: 'request', wire: 'request' }] })
    expect(resolve({ address: { kind: 'session', sessionId: SHARED } })).toBe(SHARED)
    expect(resolve({ address: { kind: 'subagent', parentSessionId: SHARED, childSessionId: PRIVATE } })).toBe(PRIVATE)
  })

  it('resolves named Session IDs and first-object requests without treating unrelated strings as identities', async () => {
    const { ctx } = await harness()
    const resource = ctx.typert.resources.get('session')
    if (resource?.resolve === undefined) throw new Error('Session resource resolver is missing')
    const resolve = (args: Readonly<Record<string, unknown>>, ...names: string[]) => resource.resolve({
      args, parameters: names.map(name => ({ name, wire: name })),
    })
    expect(resolve({ sessionId: SHARED, zzz: 'other' }, 'sessionId', 'zzz')).toBe(SHARED)
    expect(resolve({ options: { sessionId: SHARED }, yyy: 'other' }, 'options', 'yyy')).toBe(SHARED)
    expect(resolve({ options: { address: { kind: 'session', sessionId: SHARED } }, xxx: 'other' }, 'options', 'xxx')).toBe(SHARED)
    expect(resolve({ options: { address: { kind: 'subagent', parentSessionId: SHARED, childSessionId: PRIVATE } } }, 'options')).toBe(PRIVATE)
    expect(resolve({ ns: SHARED, value: 'other' }, 'ns', 'value')).toBeUndefined()
    expect(resolve({ ref: SHARED, value: 'other' }, 'ref', 'value')).toBeUndefined()
    expect(resolve({ zzz: 'other', sessionId: SHARED }, 'zzz', 'sessionId')).toBe(SHARED)
    expect(resolve({ first: {}, later: { sessionId: SHARED } }, 'first', 'later')).toBeUndefined()
    expect(resolve({ count: 1, tags: [], empty: null, options: { sessionId: SHARED } }, 'count', 'tags', 'empty', 'options')).toBe(SHARED)
    expect(resolve({}, 'sessionId')).toBeUndefined()
    expect(resolve({})).toBeUndefined()
    expect(resource.resolve({ args: { target: SHARED }, parameters: [{ name: 'sessionId', wire: 'target' }] })).toBe(SHARED)
  })

  it.each(['page', 'follow'])('authorizes %s by Address and rejects coexisting Session IDs through SRC dispatch', async (method) => {
    const { ctx, shared, hidden } = await harness()
    shared.inbox.append('next-turn', message('shared history'))
    hidden.inbox.append('next-turn', message('private history'))
    await ctx.plugin(TypertGatewayService)
    guestPolicy(ctx, {
      role: { name: 'test:history-reader', resource: 'session', actions: ['session/page', 'session/follow'] },
      resource: { kind: 'session', id: SHARED },
    })
    const abort = new AbortController()
    const peer: PeerScope = { id: 'history-access-peer' as PeerId, ctx, principal: GUEST, interactions: 'answer', signal: abort.signal, dispose: async () => {} }
    const invoke = async (request: Record<string, unknown>): Promise<unknown> => {
      const call = { peer, namespace: 'session', method, args: { request }, signal: abort.signal }
      if (method === 'page') return ctx.typertGateway.invoke(call)
      const stream = (await ctx.typertGateway.stream(call))[Symbol.asyncIterator]()
      try {
        return (await stream.next()).value
      } finally {
        await stream.return?.()
      }
    }
    const request = (sessionId: SessionId) => ({ address: { kind: 'session', sessionId }, throughSeq: 0 })
    try {
      await expect(invoke(request(SHARED))).resolves.toBeDefined()
      await expect(invoke(request(PRIVATE))).rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'no-allow' } })
      for (const target of [SHARED, PRIVATE]) {
        await expect(invoke({ ...request(target), sessionId: SHARED }))
          .rejects.toMatchObject({ code: 'remote-access/denied', details: { reason: 'resource-invalid' } })
      }
    } finally {
      abort.abort()
    }
  })

  it('lets a global role call session/list and lists only the Sessions a Session role admits', async () => {
    const { ctx, as } = await harness()
    await ctx.plugin(TypertGatewayService)
    const held = guestPolicy(ctx, LIST_CALLS, READS_SHARED)
    const rows = async (): Promise<SessionId[]> => {
      const value = await guestCall(ctx, 'list', { _request: {} }) as { readonly items: readonly { readonly sessionId: SessionId }[] }
      return value.items.map(item => item.sessionId)
    }
    await expect(rows()).resolves.toEqual([SHARED])
    // The global role admits the call, not any row.
    held.splice(0, held.length, LIST_CALLS)
    await expect(rows()).resolves.toEqual([])
    // A Session role alone does not admit the call: the global resource does not inherit from it.
    held.splice(0, held.length, READS_SHARED)
    await expect(rows()).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'session/list', reason: 'no-allow' },
    })
    const owner = await as(OWNER, 'list').sessionController.list({}, new AbortController().signal)
    expect(owner.items.map(item => item.sessionId).sort()).toEqual([PRIVATE, SHARED].sort())
  })

  it('returns a non-owner only the session/search hits whose Session a Session role admits', async () => {
    const { ctx, as } = await harness()
    await ctx.plugin(TypertGatewayService)
    guestPolicy(ctx, SEARCH_CALLS, SEARCHES_SHARED)
    const hits: SessionSearchValue = {
      items: [{ sessionId: PRIVATE, snippet: 'private hit' }, { sessionId: SHARED, snippet: 'shared hit' }],
      hasMore: true,
    }
    vi.spyOn(ApiSessionList.prototype, 'search').mockResolvedValue(hits)
    await expect(guestCall(ctx, 'search', { request: { query: 'hit' } })).resolves.toEqual({
      items: [{ sessionId: SHARED, snippet: 'shared hit' }],
      hasMore: true,
    })
    await expect(as(OWNER, 'search').sessionController.search({ query: 'hit' }, new AbortController().signal)).resolves.toEqual(hits)
  })

  it('filters session/control baselines and projection frames for a non-owner', async () => {
    const { ctx, shared, hidden, as } = await harness()
    guestPolicy(ctx, LIST_CALLS, READS_SHARED)
    const abort = new AbortController()
    const guest = as(GUEST, 'control').sessionController.control(abort.signal)[Symbol.asyncIterator]()
    const owner = as(OWNER, 'control').sessionController.control(abort.signal)[Symbol.asyncIterator]()
    const baselineSessions = async (iterator: AsyncIterator<SessionControlFrame>): Promise<string[]> => {
      const next = await iterator.next()
      if (next.done === true || next.value.type !== 'baseline') throw new Error('control stream opened without a baseline')
      return Object.keys(next.value.value.projections).sort()
    }
    expect(await baselineSessions(guest)).toEqual([SHARED])
    expect(await baselineSessions(owner)).toEqual([PRIVATE, SHARED].sort())

    hidden.inbox.append('next-turn', message('private work'))
    shared.inbox.append('next-turn', message('shared work'))
    const projected = async (iterator: AsyncIterator<SessionControlFrame>): Promise<SessionId> => {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) throw new Error('control stream ended')
        if (next.value.type === 'projection' && next.value.key === 'inbox') return next.value.sessionId
      }
    }
    // The owner sees the private Session's frame first; the guest's first Inbox frame is the shared one.
    expect(await projected(owner)).toBe(PRIVATE)
    expect(await projected(guest)).toBe(SHARED)
    abort.abort()
    await Promise.all([guest.return?.(), owner.return?.()])
  })

  it('records a non-owner caller on the prompt source and leaves owner sources unchanged', async () => {
    const { shared, as } = await harness()
    const signal = new AbortController().signal
    const prompt = (principal: Principal, requestId: string) => as(principal, 'prompt').sessionController.prompt({
      sessionId: SHARED,
      requestId: requestId as SessionRequestId,
      mode: 'queue',
      content: [{ type: 'text', text: `from ${principal.kind}` }],
    }, signal)
    await expect(prompt(GUEST, 'guest-1')).resolves.toEqual({ accepted: true })
    await expect(prompt(OWNER, 'owner-1')).resolves.toEqual({ accepted: true })
    // The durable Inbox splice records each accepted message with its source.
    const logged = shared.session.snapshotEvents()
      .flatMap(event => event.type === 'agent/inbox/spliced' ? event.data.inserted.map(item => item.source) : [])
    expect(logged).toEqual([
      { kind: 'user', rpcId: 'guest-1', principal: GUEST },
      { kind: 'user', rpcId: 'owner-1' },
    ])
  })

  it('keeps gateway permission checks while allowing an image referenced only by another Session', async () => {
    const { ctx, hidden } = await harness()
    await ctx.plugin(TypertGatewayService)
    const bindings = guestPolicy(ctx)
    const ref = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png' as const, bytes: 2, width: 1, height: 1,
    }
    hidden.session.append('user/message', createUserMessage({
      content: [{ type: 'image', attachment: ref }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const readImage = vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1, 2) }))
    ctx.attachments.readImage = readImage
    const read = (sessionId: SessionId): Promise<unknown> => guestCall(ctx, 'attachment', {
      request: { sessionId, attachment: ref },
    })
    await expect(read(SHARED)).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(readImage).not.toHaveBeenCalled()
    bindings.push({
      role: { name: 'test:attachment-reader', resource: 'session', actions: ['session/attachment'] },
      resource: { kind: 'session', id: SHARED },
    })
    await expect(read(SHARED)).resolves.toEqual({ attachment: ref, data: 'AQI=' })
    expect(readImage).toHaveBeenCalledExactlyOnceWith(ref)
    await expect(read(PRIVATE)).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(readImage).toHaveBeenCalledTimes(1)
  })

  it('lets a non-owner read projections only in a Session its Session role names', async () => {
    const { ctx } = await harness()
    await ctx.plugin(TypertGatewayService)
    guestPolicy(ctx, READS_SHARED)
    const projections = (sessionId: SessionId): Promise<unknown> => guestCall(ctx, 'projections', { request: { sessionId } })
    await expect(projections(SHARED)).resolves.toMatchObject({ kind: 'sequenced' })
    await expect(projections(PRIVATE)).rejects.toMatchObject({
      code: 'remote-access/denied', details: { action: 'session/projections', reason: 'no-allow' },
    })
  })
})
