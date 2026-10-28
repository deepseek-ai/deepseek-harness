/**
 * A viewer's generation stream carries only the Session notifications the `share-viewer` policy
 * allows, never an Owner interaction, and the viewer's Peer cannot settle one.
 */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import { Peer, type ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope, TypertResourceReader } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ForkRecord } from '../src/host/fork-registry.ts'
import { createViewerAccessPolicy } from '../src/host/viewer-access-policy.ts'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import { readerConnection } from './viewer-read-peers.ts'

const actor = { providerId: 'mock', tenantId: 'tenant', subjectId: 'viewer' }

type GatewayRpc = (endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => Promise<ConnectionRpcResult<unknown>>

/** The Session resource readers the forwarded `api-session/*` notifications declare. */
const sessionArg: Readonly<Record<string, TypertResourceReader>> = { session: (sessionId: string) => sessionId }
const addedSession: Readonly<Record<string, TypertResourceReader>> = {
  session: (summary: { readonly sessionId: string }) => summary.sessionId,
}

describe('viewer forwarded interactions', () => {
  it('forwards a reader only Session notifications about the shared Session and its own forks', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    ctx.provide('connection', { rpc: { intercept: () => () => {} } } as never)
    await ctx.plugin(TypertGateway, {})
    const ownChild: ForkRecord = {
      childSessionId: 'own-child', shareId: 'share', sourceSessionId: 'source', boundary: 1, creator: actor, createdAt: '',
    }
    ctx.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy({
      share: shareId => shareId === 'share'
        ? { shareId, sessionId: 'source', allowsFork: true, viewerAdmitted: true, stopped: false, sessionMode: 'view' }
        : undefined,
      viewerAdmitted: () => true,
      sourceConfined: () => false,
      forks: {
        find: id => id === ownChild.childSessionId ? ownChild : undefined,
        listForShare: () => [ownChild],
        allowsPrompt: () => ({ ok: false, code: 'fork-ceiling-uninstalled', message: 'no ceiling' }),
      },
      workspaces: () => [],
      declaredCapabilities: () => [],
    }))
    const emits = [
      { event: 'api-session/status', args: ['private', true], resources: sessionArg },
      { event: 'api-session/status', args: ['source', true], resources: sessionArg },
      { event: 'api-session/added', args: [{ sessionId: 'own-child' }], resources: addedSession },
      { event: 'api-session/added', args: [{ sessionId: 'someone-else' }], resources: addedSession },
      { event: 'commands/change', args: [] },
    ]
    const go = Promise.withResolvers<undefined>()
    const stop = ctx.typertGateway.registerRemoteEvents(signal => (async function* () {
      await go.promise
      yield* emits
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })(), { home: '/owner' })
    onTestFinished(stop)
    const readers = readerConnection()
    const read = createViewerReadService({
      gateway: ctx.typertGateway, sharedSessionId: () => 'source', connection: readers.connection,
    })
    onTestFinished(async () => {
      read.close()
      await readers.dispose()
    })
    const owner = new Peer(ctx, { principal: { kind: 'owner' } })
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort() })
    const ownerFrames = (await ctx.typertGateway.wireStream.open(
      '$events', { args: {} }, (async function* () {})(), owner, lifetime.signal,
    ))[Symbol.asyncIterator]()
    expect((await ownerFrames.next()).value).toMatchObject({ type: 'ready' })

    expect(await read.answer('share', { op: 'stream-open', id: 1, endpoint: '$events', payload: { args: {} } }, actor))
      .toMatchObject({ status: 200 })
    expect(await read.answer('share', { op: 'stream-next', id: 1 }, actor))
      .toMatchObject({ status: 200, body: { values: [{ type: 'ready' }] } })
    go.resolve(undefined)
    const received: unknown[] = []
    for (const _ of emits) received.push((await ownerFrames.next()).value)
    const delivered: unknown[] = []
    while (delivered.length < 2) {
      const answer = await read.answer('share', { op: 'stream-next', id: 1 }, actor)
      delivered.push(...(answer.body as { readonly values?: readonly unknown[] }).values ?? [])
    }

    // The owner receives every notification; the reader only those about the source and its own fork.
    expect(received.map(frame => (frame as { readonly event: string }).event)).toEqual(emits.map(entry => entry.event))
    expect(delivered).toEqual([
      { type: 'emit', event: 'api-session/status', args: ['source', true] },
      { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'own-child' }] },
    ])
  })

  it('keeps an Owner approval from the viewer and refuses the viewer\u2019s result for it', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    let dispatch: GatewayRpc | undefined
    ctx.provide('connection', {
      rpc: { intercept: (_path: string, _claims: unknown, handler: GatewayRpc) => { dispatch = handler; return () => {} } },
    } as never)
    await ctx.plugin(TypertGateway, {})
    const outcome = Promise.withResolvers<unknown>()
    const queued = Promise.withResolvers<undefined>()
    const subject = { ctx }
    const stop = ctx.typertGateway.registerRemoteEvents(signal => (async function* () {
      yield {
        event: 'approval/request', request: { agent: subject, reason: 'private owner operation' },
        context: { value: ctx, subject, agentId: 'private-owner-agent' },
        resolve: outcome.resolve, reject: outcome.reject,
      }
      queued.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })(), { home: '/owner' })
    onTestFinished(stop)
    await queued.promise
    const gatewayRpc = (endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => {
      if (dispatch === undefined) throw new Error('Gateway interceptor was not registered')
      return dispatch(endpoint, payload, signal, peer)
    }
    const readers = readerConnection(async (request, peer) => {
      const body = await request.json() as { payload: unknown }
      return Response.json({ result: await gatewayRpc('$events/result', body.payload, request.signal, peer) })
    })
    const read = createViewerReadService({
      gateway: ctx.typertGateway, sharedSessionId: () => 'source', connection: readers.connection,
    })
    onTestFinished(async () => {
      read.close()
      await readers.dispose()
    })

    await read.answer('share', { op: 'stream-open', id: 1, endpoint: '$events', payload: { args: {} } }, actor)
    const answer = await read.answer('share', { op: 'stream-next', id: 1 }, actor)
    expect(answer).toMatchObject({ status: 200, body: { values: [{ type: 'ready' }] } })
    expect(JSON.stringify(answer)).not.toContain('private-owner-agent')

    // The Owner's own generation still receives the approval the viewer never saw.
    const owner = new Peer(ctx, { principal: { kind: 'owner' } })
    const lifetime = new AbortController()
    onTestFinished(() => { lifetime.abort() })
    const frames = (await ctx.typertGateway.wireStream.open(
      '$events', { args: {} }, (async function* () {})(), owner, lifetime.signal,
    ))[Symbol.asyncIterator]()
    const ready = (await frames.next()).value as { readonly type: string; readonly clientId: string }
    const approval = (await frames.next()).value as { readonly type: string; readonly eventId: string }
    expect(ready).toMatchObject({ type: 'ready' })
    expect(approval).toMatchObject({ type: 'waterfall', event: 'approval/request', agentId: 'private-owner-agent' })

    // Naming the live event does not let the viewer's Peer settle it.
    const result = (value: string) => ({
      args: { clientId: ready.clientId, eventId: approval.eventId, outcome: { kind: 'result', value } },
    })
    expect(await read.answer('share', {
      op: 'call', path: '/api/$events/result', body: { payload: result('allowed-once') },
    }, actor)).toMatchObject({ status: 200, body: { result: { ok: false, error: { code: 'gateway/invocation-unavailable' } } } })
    expect(await gatewayRpc('$events/result', result('denied'), lifetime.signal, owner)).toEqual({ ok: true })
    expect(await outcome.promise).toEqual({ kind: 'result', value: 'denied' })
  })
})
