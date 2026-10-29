/**
 * A reader's cancel travels the standard Gateway dispatch.
 *
 * A cancel naming the share's own Session and one naming the reader's own fork are both dispatched through
 * the real Connection and Gateway as the reader's Peer, so the `share-viewer` policy decides the call and
 * the Session controller stops whatever turn the target Session runs. A reader whose access ends while the
 * call is decoded or prepared cancels nothing, and one whose grant ended is refused before dispatch.
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { ShareRpcActor } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { HostConnectionService } from '../../../client/connection/src/rpc-host.ts'
import { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { SessionController, type SessionCancelRequest } from '../../../api/session-controller/src/index.ts'
import type { TypertLookup } from '../../../typert/protocol/src/types.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import { createViewerAccessPolicy, readerWriteRefusal, type ViewerAccessFacts } from '../src/host/viewer-access-policy.ts'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import type { ViewerCallRequest } from '../src/viewer-channel.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    /** Test-only lookup holding a cancel request in the Gateway's preparation, after access was checked. */
    viewerCancelAdmissionRequest: TypertLookup<SessionCancelRequest, SessionCancelRequest>
  }
}

const alice = { providerId: 'provider-a', tenantId: 'tenant', subjectId: 'viewer' }
const bob = { ...alice, providerId: 'provider-b' }
const sourceSession = SessionId('source-session')

/** One `session/cancel` as the viewer client sends it. */
function cancelRequest(sessionId: string): ViewerCallRequest {
  return {
    op: 'call',
    path: '/api/session/cancel',
    body: {
      type: 'client-request', rpcId: 'cancel-rpc', method: 'session/cancel',
      payload: { args: { request: { sessionId } } },
    },
  }
}

class DecodingBarrierRequest extends Request {
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()

  override async json(): Promise<unknown> {
    this.entered.resolve(undefined)
    await this.release.promise
    return super.json()
  }
}

/**
 * A running turn on the reader's fork or on the share's own Session, a reader dispatching through the real
 * Connection and Gateway, and this package's `share-viewer` policy registered with the Gateway's remote
 * access service.
 * @param creator - Reader the request is dispatched as.
 * @param target - `fork` drives a recorded child of this reader; `source` drives the shared Session itself.
 */
async function readerHarness(creator: ShareRpcActor, target: 'fork' | 'source' = 'fork') {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-cancel-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  const driver = await mountAgentLoopTestHarness(ctx)
  provideBrowserCredentials(ctx)
  const auth = await BrowserAuth.create(ctx, ctx.credentials, 1)
  new HostConnectionService(ctx, [], auth)
  // Provided on the root Context that also constructs the Session controller below, which re-reads
  // access from that Context's own fiber while a Gateway call runs.
  new RemoteAccessService(ctx)
  await ctx.plugin(TypertGatewayService)
  const controller = await createSessionTestController(ctx, {
    cwd: process.cwd(),
    defaultModelSelection: () => ({ provider: 'unused', model: 'unused' }),
  })
  expect(Reflect.get(controller, 'cancel')).toBe(Reflect.get(SessionController.prototype, 'cancel'))

  const sessionId = target === 'fork' ? SessionId('child-session') : sourceSession
  const forks = new ForkRegistry(join(directory, 'forks.json'))
  if (target === 'fork') {
    await forks.record({ shareId: 'share', sourceSessionId: sourceSession, childSessionId: sessionId,
      creator, boundary: 0, createdAt: '2026-10-12T00:00:00Z' })
  }
  // A turn reaches the `agent/pre-step` waterfall only after the loop resolves a model route, so the
  // fixture gives the harness agent one; the pre-step listener below still spends no model call.
  const agent = await driver.create(sessionId, { provider: 'unused', model: 'unused' })
  const turnEntered = Promise.withResolvers<AbortSignal>()
  const turnRelease = Promise.withResolvers<undefined>()
  agent.ctx.on('agent/pre-step', async ({ signal }, next) => {
    turnEntered.resolve(signal)
    await turnRelease.promise
    const decision = await next()
    return decision.kind === 'enter' ? { ...decision, messages: [] } : decision
  })
  const cancelled = vi.spyOn(agent, 'cancel')
  onTestFinished(async () => {
    turnRelease.resolve(undefined)
    await agent.whenIdle()
    cancelled.mockRestore()
  })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Reader turn' }],
    source: { kind: 'user' },
  }))
  const turnSignal = await turnEntered.promise
  expect(agent.status).toBe('running')

  const admitted = new Set([identityKeyOf(alice), identityKeyOf(bob)])
  const share: ForkShareState = { shareId: 'share', sessionId: sourceSession, sessionMode: 'view',
    allowsFork: true, viewerAdmitted: true, stopped: false }
  const accessFacts: ViewerAccessFacts = {
    share: shareId => shareId === 'share' ? share : undefined,
    viewerAdmitted: (_shareId, actor) => admitted.has(identityKeyOf(actor)),
    sourceConfined: () => true,
    forks,
    workspaces: () => [],
    declaredCapabilities: () => [],
  }
  ctx.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy(accessFacts))

  let decoding = Promise.withResolvers<DecodingBarrierRequest>()
  const preparing = Promise.withResolvers<undefined>()
  const prepareRelease = Promise.withResolvers<undefined>()
  /** Resolve the cancel's `request` parameter through a lookup that waits, as a cold resolution would. */
  const delayPreparation = () => ctx.typert.lookups.register('viewerCancelAdmissionRequest', {
    parameter: 'request', wire: 'request',
    hostTypeSymbol: 'viewer-cancel-admission#SessionCancelRequest',
    wireTypeSymbol: 'viewer-cancel-admission#SessionCancelRequest',
    resolve: async (request) => {
      preparing.resolve(undefined)
      await prepareRelease.promise
      return request
    },
  })
  const wireResponse = Promise.withResolvers<unknown>()
  const requests: DecodingBarrierRequest[] = []
  const pending: Promise<unknown>[] = []
  const peers: PeerScope[] = []
  const dispatchedAs: PeerScope[] = []
  const read = createViewerReadService({
    connection: {
      createSharedFetchHandler: (channel) => {
        const shared = ctx.connection.createSharedFetchHandler('/api')
        expect(channel).toBe('/api')
        return {
          requestBodyMode: request => shared.requestBodyMode(request),
          fetch: async (request, peer) => {
            const blocked = new DecodingBarrierRequest(request)
            requests.push(blocked)
            dispatchedAs.push(peer)
            decoding.resolve(blocked)
            const response = await shared.fetch(blocked, peer)
            wireResponse.resolve(await response.clone().json())
            return response
          },
        }
      },
      createPeer: (options) => {
        const peer = ctx.connection.createPeer(options)
        peers.push(peer)
        return peer
      },
    },
    sharedSessionId: () => sourceSession,
    forkStateOf: () => share,
    viewerStillAdmitted: (_shareId, actor) => admitted.has(identityKeyOf(actor)),
    forks,
    writeRefusal: (viewer, action, sessionId, concrete) => readerWriteRefusal(accessFacts, viewer, action, sessionId, concrete),
  })
  onTestFinished(async () => {
    read.close()
    prepareRelease.resolve(undefined)
    for (const request of requests) request.release.resolve(undefined)
    await Promise.allSettled(pending)
  })

  const call = (actor: ShareRpcActor) => {
    decoding = Promise.withResolvers<DecodingBarrierRequest>()
    const answer = read.answer('share', cancelRequest(sessionId), actor)
    pending.push(answer)
    return answer
  }
  /** End one reader's grant without touching the calls it already opened. */
  const endGrant = (actor: ShareRpcActor): void => {
    admitted.delete(identityKeyOf(actor))
  }
  /** End one reader's access the way the owner's revoke path does: the grant, then its calls and Peer. */
  const revoke = (actor: ShareRpcActor): void => {
    endGrant(actor)
    read.closeViewerStreams('share', actor)
  }
  return {
    ctx, agent, call, endGrant, revoke, get decoding() { return decoding }, wireResponse, peers, dispatchedAs,
    preparing, prepareRelease, delayPreparation, turnSignal, turnRelease, cancelled,
  }
}

describe('reader cancel of its own fork through Connection and Gateway', () => {
  it('does not stop the fork’s turn when its reader is revoked during JSON decoding', async () => {
    const fixture = await readerHarness(alice)
    const answer = fixture.call(alice)
    const rejected = expect(answer).rejects.toThrow('Viewer access ended')
    const request = await fixture.decoding.promise
    await request.entered.promise
    expect(request.signal.aborted).toBe(false)
    // The cancel is dispatched, as the reader's own Peer.
    expect(fixture.dispatchedAs).toEqual([fixture.peers[0]])
    expect(fixture.peers[0]?.principal).toEqual({ kind: 'share-viewer', shareId: 'share', actor: alice })

    fixture.revoke(alice)
    expect(request.signal.aborted).toBe(true)
    request.release.resolve(undefined)
    await rejected
    expect(await fixture.wireResponse.promise).toMatchObject({
      rpcId: 'cancel-rpc', result: { ok: false, error: { code: 'gateway/peer-disposed' } },
    })
    expect(fixture.peers[0]?.signal.aborted).toBe(true)

    expect(fixture.cancelled).not.toHaveBeenCalled()
    expect(fixture.turnSignal.aborted).toBe(false)
    expect(fixture.agent.status).toBe('running')
    // The revoked reader's next cancel is refused before anything is dispatched.
    expect(await fixture.call(alice)).toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    expect(fixture.dispatchedAs).toHaveLength(1)
    fixture.turnRelease.resolve(undefined)
    await fixture.agent.whenIdle()
    expect(fixture.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'completed' } } })
  })

  it('stops the fork’s turn when its reader is revoked during Gateway preparation', async () => {
    // Known limitation: with the controller's access recheck deferred, a cancel already admitted by the
    // Gateway keeps its effect even though the reader's access ends while the Gateway prepares it.
    const fixture = await readerHarness(alice)
    const unregister = fixture.delayPreparation()
    onTestFinished(unregister)
    const answer = fixture.call(alice)
    const rejected = expect(answer).rejects.toThrow('Viewer access ended')
    const request = await fixture.decoding.promise
    await request.entered.promise
    request.release.resolve(undefined)
    // The Gateway has authorized the call and is resolving its arguments.
    await fixture.preparing.promise

    fixture.revoke(alice)
    expect(request.signal.aborted).toBe(true)
    fixture.prepareRelease.resolve(undefined)
    await rejected
    // The admitted cancel still reaches the controller, which no longer re-reads the revoked grant.
    expect(await fixture.wireResponse.promise).toMatchObject({
      rpcId: 'cancel-rpc', result: { ok: true, value: { accepted: true } },
    })
    expect(fixture.cancelled).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(fixture.turnSignal.aborted).toBe(true)
    fixture.turnRelease.resolve(undefined)
    await fixture.agent.whenIdle()
    expect(fixture.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  })

  it('still cancels when the reader’s grant ends during Gateway preparation', async () => {
    // Known limitation: ending the grant does not abort the calls the reader already opened, so an
    // in-flight cancel keeps its effect while no access recheck happens in the controller.
    const fixture = await readerHarness(alice)
    const unregister = fixture.delayPreparation()
    onTestFinished(unregister)
    const answer = fixture.call(alice)
    const request = await fixture.decoding.promise
    await request.entered.promise
    request.release.resolve(undefined)
    await fixture.preparing.promise

    fixture.endGrant(alice)
    expect(request.signal.aborted).toBe(false)
    fixture.prepareRelease.resolve(undefined)
    await answer
    expect(await fixture.wireResponse.promise).toMatchObject({
      rpcId: 'cancel-rpc', result: { ok: true, value: { accepted: true } },
    })
    expect(fixture.cancelled).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(fixture.turnSignal.aborted).toBe(true)
    fixture.turnRelease.resolve(undefined)
    await fixture.agent.whenIdle()
    expect(fixture.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  })

  it('still cancels for a reader with the same subject and tenant but another provider', async () => {
    const fixture = await readerHarness(bob)
    const answer = fixture.call(bob)
    const request = await fixture.decoding.promise
    await request.entered.promise

    fixture.revoke(alice)
    expect(request.signal.aborted).toBe(false)
    request.release.resolve(undefined)
    expect(await answer).toMatchObject({
      status: 200,
      body: { rpcId: 'cancel-rpc', result: { ok: true, value: { accepted: true } } },
    })
    expect(fixture.peers.map(peer => peer.principal)).toEqual([{ kind: 'share-viewer', shareId: 'share', actor: bob }])
    expect(fixture.cancelled).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(fixture.turnSignal.aborted).toBe(true)
    fixture.turnRelease.resolve(undefined)
    await fixture.agent.whenIdle()
    const boundary = fixture.ctx.get('agents')
    expect(boundary?.turnBoundaryOf(fixture.agent.session).openTurnStartSeq).toBeNull()
    expect(fixture.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  })

  it('refuses another reader’s fork before anything is dispatched', async () => {
    const fixture = await readerHarness(alice)
    expect(await fixture.call(bob)).toMatchObject({ status: 403, body: { error: 'fork-viewer-mismatch' } })
    expect(fixture.dispatchedAs).toEqual([])
    expect(fixture.cancelled).not.toHaveBeenCalled()
  })
})

describe('reader cancel of the shared Session through the Gateway', () => {
  it('stops the shared Session’s running turn as the reader', async () => {
    const fixture = await readerHarness(alice, 'source')
    const answer = fixture.call(alice)
    // The fixture holds the request body until the test releases it, as a cold decode would.
    const request = await fixture.decoding.promise
    await request.entered.promise
    request.release.resolve(undefined)

    expect(await answer).toMatchObject({
      status: 200,
      body: { rpcId: 'cancel-rpc', result: { ok: true, value: { accepted: true } } },
    })
    // The cancel reaches the owner's Session controller as the reader's own Peer, with no ownership
    // comparison anywhere: the Gateway's session/cancel stops whatever turn the Session runs.
    expect(fixture.dispatchedAs).toEqual([fixture.peers[0]])
    expect(fixture.peers[0]?.principal).toEqual({ kind: 'share-viewer', shareId: 'share', actor: alice })
    expect(fixture.cancelled).toHaveBeenCalledExactlyOnceWith({ kind: 'user' }, { keepInbox: true })
    expect(fixture.turnSignal.aborted).toBe(true)
    fixture.turnRelease.resolve(undefined)
    await fixture.agent.whenIdle()
    expect(fixture.agent.session.snapshotEvents().findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  })

  it('refuses a revoked reader before the cancel is dispatched', async () => {
    const fixture = await readerHarness(alice, 'source')
    fixture.revoke(alice)

    expect(await fixture.call(alice)).toMatchObject({ status: 403, body: { error: 'viewer-not-authorized' } })
    expect(fixture.dispatchedAs).toEqual([])
    expect(fixture.cancelled).not.toHaveBeenCalled()
    fixture.turnRelease.resolve(undefined)
    await fixture.agent.whenIdle()
  })
})
