/**
 * Which Session a reader's call is authorized for is the Session the real Connection and Gateway act on.
 *
 * The reader reads the `share-viewer` policy's write rules before it prepares or dispatches a prompt or
 * cancel, and every dispatched call speaks for the reader's own Peer, so the Gateway decides the same
 * policy on the resources it resolves from the call's actual wire arguments.
 */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentRef } from '../../../attachment/attachment/src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { HostConnectionService } from '../../../client/connection/src/rpc-host.ts'
import { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { READ_ONLY_FORK_CEILING, type ForkShareState, type ViewerSessionMode } from '../src/host/fork-policy.ts'
import { createViewerAccessPolicy, readerWriteRefusal, type ViewerAccessFacts } from '../src/host/viewer-access-policy.ts'
import { createViewerReadService } from '../src/host/viewer-read.ts'

const actor = { providerId: 'fixture', tenantId: 'tenant', subjectId: 'viewer' }
const source = SessionId('source')
const child = SessionId('own-child')
const privateSession = SessionId('private-session')

function call(method: string, request: object) {
  return { op: 'call' as const, path: `/api/${method}`, body: {
    type: 'client-request', rpcId: `rpc-${method}`, method, payload: { args: { request } },
  } }
}

/** The Gateway's refusal of one call the policy denied, as the reader relays it. */
function deniedBy(action: string, reason: string) {
  return {
    status: 200,
    body: { type: 'server-response', result: { ok: false, error: { code: 'remote-access/denied', details: { action, reason } } } },
  }
}

async function harness(mode: ViewerSessionMode = 'write') {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-target-'))
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
    cwd: process.cwd(), defaultModelSelection: () => ({ provider: 'unused', model: 'unused' }),
  })
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next()
    return decision.kind === 'enter' ? { ...decision, messages: [] } : decision
  })
  const agents = await Promise.all([source, child, privateSession].map(id => driver.create(id, {}, { cwd: process.cwd() })))
  const privateAgent = agents[2]!
  const image: ImageAttachmentRef = { attachmentId: AttachmentId('private-image'),
    mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  privateAgent.session.append('user/message', createUserMessage({
    content: [{ type: 'image', attachment: image }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const readImage = vi.fn(async (ref: ImageAttachmentRef) => ({ ref, data: Uint8Array.of(42) }))
  ctx.attachments.readImage = readImage
  const followup = vi.spyOn(privateAgent, 'followup')
  const cancelled = vi.spyOn(privateAgent, 'cancel')
  const attachment = vi.spyOn(controller, 'attachment')
  const forks = new ForkRegistry(join(directory, 'forks.json'))
  await forks.record({ shareId: 'share', sourceSessionId: source, childSessionId: child,
    creator: actor, boundary: 0, createdAt: '2026-10-12T00:00:00Z' })
  forks.installEnforcement(child, READ_ONLY_FORK_CEILING)
  const share: ForkShareState = { shareId: 'share', sessionId: source, sessionMode: mode,
    allowsFork: mode !== 'view', viewerAdmitted: true, stopped: false }
  const accessFacts: ViewerAccessFacts = {
    share: shareId => shareId === 'share' ? share : undefined,
    viewerAdmitted: () => true,
    sourceConfined: () => true,
    forks,
    workspaces: () => [],
    declaredCapabilities: () => [],
  }
  ctx.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy(accessFacts))
  const shared = ctx.connection.createSharedFetchHandler('/api')
  const dispatch = vi.fn((request: Request, peer: PeerScope) => shared.fetch(request, peer))
  const peers: PeerScope[] = []
  const reader = createViewerReadService({
    sharedSessionId: () => source, forks,
    forkStateOf: () => share,
    sourceConfined: () => true, viewerStillAdmitted: () => true,
    connection: {
      createSharedFetchHandler: () => ({ requestBodyMode: request => shared.requestBodyMode(request), fetch: dispatch }),
      createPeer: (options) => {
        const peer = ctx.connection.createPeer(options)
        peers.push(peer)
        return peer
      },
    },
    gateway: ctx.typertGateway,
    writeRefusal: (viewer, action, sessionId, concrete) => readerWriteRefusal(accessFacts, viewer, action, sessionId, concrete),
  })
  onTestFinished(() => { reader.close() })
  return { ctx, reader, dispatch, peers, followup, cancelled, attachment, readImage, controller, image, agents }
}

describe('viewer target admission through the share-viewer policy and the real Gateway', () => {
  it.each(['session/prompt', 'session/cancel'])(
    'refuses %s naming a Session this reader cannot see before anything is dispatched', async (method) => {
      const fixture = await harness()
      const request = { sessionId: privateSession, requestId: 'attack', mode: 'queue',
        content: [{ type: 'text', text: 'must not enter private inbox' }],
        address: { kind: 'session', sessionId: source } }
      expect(await fixture.reader.answer('share', call(method, request), actor))
        .toMatchObject({ status: 403, body: { error: 'fork-unknown-child' } })
      expect(fixture.dispatch).not.toHaveBeenCalled()
      expect(fixture.followup).not.toHaveBeenCalled()
      expect(fixture.cancelled).not.toHaveBeenCalled()
    },
  )

  it.each(['session/prompt', 'session/cancel'])(
    'refuses %s carrying both a Session id and an address before the target child runs', async (method) => {
      const fixture = await harness()
      const childAgent = fixture.agents[1]
      if (childAgent === undefined) throw new Error('the harness created no child Agent')
      const followup = vi.spyOn(childAgent, 'followup')
      const cancel = vi.spyOn(childAgent, 'cancel')
      onTestFinished(() => { followup.mockRestore(); cancel.mockRestore() })
      const answer = await fixture.reader.answer('share', call(method, {
        sessionId: child,
        address: { kind: 'session', sessionId: source },
        ...(method === 'session/prompt'
          ? { requestId: 'both-identities', mode: 'queue', content: [{ type: 'text', text: 'private-marker' }] }
          : {}),
      }), actor)
      // The two identities reach the Gateway, whose Session resolver refuses the body as invalid
      // resources, so the child's operation never runs and no request content comes back.
      expect(answer).toMatchObject(deniedBy(method, 'resource-invalid'))
      expect(JSON.stringify(answer)).not.toContain('private-marker')
      expect(fixture.dispatch).toHaveBeenCalledOnce()
      expect(followup).not.toHaveBeenCalled()
      expect(cancel).not.toHaveBeenCalled()
    },
  )

  it.each(['session/state', 'session/events'])(
    'admits %s for the visible source and refuses a hidden Session', async (method) => {
      const fixture = await harness()
      const request = (sessionId: typeof source) => method === 'session/events'
        ? { address: { kind: 'session', sessionId }, throughSeq: 0 }
        : { sessionId }
      expect(await fixture.reader.answer('share', call(method, request(source)), actor))
        .toMatchObject({ status: 200 })
      expect(await fixture.reader.answer('share', call(method, request(privateSession)), actor))
        .toMatchObject(deniedBy(method, 'liveshare/read-only'))
    },
  )

  it('refuses a fork of a Session other than the shared one before anything is dispatched', async () => {
    const fixture = await harness()
    const answer = await fixture.reader.answer('share', call('session/fork', {
      sessionId: privateSession, address: { kind: 'session', sessionId: source },
    }), actor)
    expect(answer).toMatchObject({ status: 403, body: { error: 'source-session-mismatch' } })
    expect(fixture.dispatch).not.toHaveBeenCalled()
  })

  it('names the policy’s refusal for another reader’s child, and drives both Sessions of a view share', async () => {
    const write = await harness()
    const prompt = (sessionId: string) => call('session/prompt', { sessionId, requestId: 'refused', mode: 'queue',
      content: [{ type: 'text', text: 'refused' }] })
    expect(await write.reader.answer('share', prompt(child), { ...actor, tenantId: 'other-tenant' }))
      .toMatchObject({ status: 403, body: { error: 'fork-viewer-mismatch' } })
    expect(write.dispatch).not.toHaveBeenCalled()

    // The view tier drives the shared Session and the branch this reader made: the confined layer is what
    // decides writing, and this reader's own branch runs under its own read-only ceiling.
    const view = await harness('view')
    for (const sessionId of [source, child]) {
      expect(await view.reader.answer('share', prompt(sessionId), actor)).toMatchObject({ status: 200 })
    }
    expect(view.dispatch).toHaveBeenCalledTimes(2)
  })

  it('lets the Gateway refuse a hidden attachment without disclosing bytes', async () => {
    const fixture = await harness()
    for (const [request, reason] of [
      // Two identities in one body are invalid resources before any policy reads either.
      [{ sessionId: privateSession, attachmentId: 'private-image', address: { kind: 'session', sessionId: source } },
        'resource-invalid'],
      [{ attachmentId: 'private-image', address: {} }, 'liveshare/read-only'],
    ] as const) {
      const answer = await fixture.reader.answer('share', call('session/attachment', request), actor)
      expect(answer).toMatchObject(deniedBy('session/attachment', reason))
      expect(JSON.stringify(answer)).not.toContain('Kg==')
    }
    expect(fixture.dispatch).toHaveBeenCalledTimes(2)
    expect(fixture.attachment).not.toHaveBeenCalled()
    expect(fixture.readImage).not.toHaveBeenCalled()
    // The image is genuinely readable to the Owner; viewer denial is not an empty fixture.
    expect(await fixture.controller.attachment({ sessionId: privateSession, attachment: fixture.image }))
      .toMatchObject({ data: 'Kg==' })
  })

  it.each(['session/page', 'session/follow'])(
    'refuses %s naming a hidden Session or carrying two identities', async (method) => {
      const fixture = await harness()
      for (const [request, reason] of [
        // A body carrying both `sessionId` and `address` names two Session identities, which the
        // Gateway's Session resolver refuses as invalid resources.
        [{ sessionId: source, address: {} }, 'resource-invalid'],
        [{ sessionId: source, address: { kind: 'session', sessionId: privateSession } }, 'resource-invalid'],
        // A subagent address names the child's own Session, here one no share reader can see.
        [{ address: { kind: 'subagent', parentSessionId: source, childSessionId: privateSession, mode: 'continuable' } },
          'liveshare/read-only'],
        // A lone Session identity names a Session this reader cannot see.
        [{ sessionId: privateSession }, 'liveshare/read-only'],
      ] as const) {
        if (method === 'session/page') {
          expect(await fixture.reader.answer('share', call(method, { ...request, throughSeq: 0 }), actor))
            .toMatchObject(deniedBy(method, reason))
          continue
        }
        expect(await fixture.reader.answer('share', { op: 'stream-open', id: 1, endpoint: method,
          payload: { args: { request } } }, actor))
          .toMatchObject({ status: 200, body: { failure: { code: 'remote-access/denied', details: { action: method, reason } } } })
      }
    },
  )

  it('lets the Session Controller refuse a subagent address naming the reader\u2019s fork under another parent', async () => {
    const fixture = await harness()
    const address = { kind: 'subagent', parentSessionId: privateSession, childSessionId: child, mode: 'continuable' }
    const answer = await fixture.reader.answer('share', call('session/page', { address, throughSeq: 0 }), actor)
    expect(answer).toMatchObject({
      status: 200,
      body: { result: { ok: false, error: { code: 'subagent/unauthorized', details: { childSessionId: child } } } },
    })
  })

  it.each(['session/attachment', 'session/fork', 'session/prompt', 'session/cancel'])(
    'fails closed when %s carries no Session identity', async (method) => {
      const fixture = await harness()
      const answer = await fixture.reader.answer('share', call(method, { address: { sessionId: source } }), actor)
      // Fork is decided by the host before the policy: a body naming no Session is a malformed request,
      // not a permissions answer. Every other method reaches the policy and is refused there.
      expect(answer).toMatchObject(method === 'session/fork'
        ? { status: 400, body: { error: 'fork-session-required' } }
        : deniedBy(method, 'liveshare/read-only'))
      expect(fixture.followup).not.toHaveBeenCalled()
      expect(fixture.cancelled).not.toHaveBeenCalled()
      expect(fixture.attachment).not.toHaveBeenCalled()
    },
  )

  it('keeps typed source and own-child requests available as the reader’s Peer', async () => {
    const fixture = await harness()
    for (const sessionId of [source, child]) {
      expect(await fixture.reader.answer('share', call('session/prompt', { sessionId,
        requestId: `valid-${sessionId}`, mode: 'queue', content: [{ type: 'text', text: 'valid' }] }), actor))
        .toMatchObject({ status: 200, body: { result: { ok: true, value: { accepted: true } } } })
      const id = sessionId === source ? 1 : 2
      expect(await fixture.reader.answer('share', { op: 'stream-open', id,
        endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }, actor))
        .toMatchObject({ status: 200 })
      expect(await fixture.reader.answer('share', { op: 'stream-next', id }, actor))
        .toMatchObject({ status: 200, body: { values: [{ type: 'snapshot', header: { id: sessionId } }] } })
      await fixture.reader.answer('share', { op: 'stream-cancel', id }, actor)
      expect(await fixture.reader.answer('share', call('session/page', {
        address: { kind: 'session', sessionId }, throughSeq: 0,
      }), actor)).toMatchObject({ status: 200, body: { result: { ok: true } } })
    }
    await Promise.all(fixture.agents.map(agent => agent.whenIdle()))
    expect(fixture.followup).not.toHaveBeenCalled()
    // Every call and stream spoke for one Peer: this reader of this share.
    expect(fixture.peers).toHaveLength(1)
    expect(fixture.peers[0]?.principal).toEqual({ kind: 'share-viewer', shareId: 'share', actor })
    expect(fixture.dispatch.mock.calls.every(([, peer]) => peer === fixture.peers[0])).toBe(true)
  })

  // `skills/list` is unavailable to this harness (the skill catalog plugin is not mounted), so the
  // Session resolver coverage for it stays with the generic Gateway and resolver tests.
  it.each([
    ['session/rename', { title: 'renamed-child' }, child],
    // The fork pre-screen refuses a target other than the share's Session before dispatch, so the
    // two-identity body must name the source to reach the Gateway.
    ['session/fork', {}, source],
    ['session/projections', {}, child],
  ] as const)('refuses %s whose request names two Session identities', async (method, extra, target) => {
    const fixture = await harness()
    const answer = await fixture.reader.answer('share', call(method, {
      sessionId: target,
      address: { kind: 'session', sessionId: source },
      ...extra,
    }), actor)
    // The Gateway's Session resolver refuses two identities as invalid resources before any operation runs.
    expect(answer).toMatchObject(deniedBy(method, 'resource-invalid'))
    expect(fixture.dispatch).toHaveBeenCalledOnce()
  })

})
