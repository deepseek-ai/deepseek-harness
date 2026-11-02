/**
 * Reader access binds the receiving Session: the answer of the `share-viewer` policy the share host
 * registers for each Session a reader names, the Gateway refusing a reader Peer before the controller
 * runs, and the pre-step re-check of queued reader input, including input recovered from a durable Inbox.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import * as JsonlSessionPersistence from '../../../session/session-persistence-jsonl/src/index.ts'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { TunnelRegistrationToken, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { ForkRegistry } from '../src/host/fork-registry.ts'
import { apply } from '../src/host/share-host.ts'
import { shareViewerPrincipal } from '../src/host/viewer-principal.ts'

const worker = vi.hoisted(() => ({ event: undefined as ((event: TunnelWorkerEvent) => void) | undefined }))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(callback: (event: TunnelWorkerEvent) => void) { worker.event = callback; return () => {} }
  send() {}
  stop() { worker.event = undefined; return Promise.resolve() }
} }))
const actor = { providerId: 'fixture', tenantId: 'tenant', subjectId: 'viewer' }
const stranger = { ...actor, subjectId: 'other-viewer' }

type Mode = 'view' | 'write'

async function harness(empty = false, mode: Mode = 'write', options: { readonly gateway?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-agent-target-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const file = join(directory, 'owner.json')
  const share = (shareId: string, sessionId: string) => ({ relay: 'https://relay.test', shareId, sessionId,
    sessionTitle: sessionId, accessMode: 'selected', gatewayToken: 'token', allowedSubjectIds: [identityKeyOf(actor)],
    createdAt: '2026-10-12T00:00:00Z', sessionMode: mode, allowsFork: mode !== 'view' })
  writeFileSync(file, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.test',
    shares: empty ? [] : [share('share', 'source'), share('other-share', 'other-source')] }))
  const forks = new ForkRegistry(join(directory, 'forks.json'))
  for (const [shareId, sourceSessionId, childSessionId, creator] of [
    ['share', 'source', 'own-child', actor], ['share', 'source', 'stranger-child', stranger],
    ['other-share', 'other-source', 'other-child', actor],
  ] as const) await forks.record({ shareId, sourceSessionId, childSessionId, creator,
    boundary: 0, createdAt: '2026-10-12T00:00:00Z' })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('connection', {
    fetch: { register: () => () => {} },
    createPeer: (peer: ConstructorParameters<typeof Peer>[1]) => new Peer(ctx, peer),
  } as never)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  if (options.gateway === true) await ctx.plugin(TypertGateway)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    expect(new URL(request.url).origin).toBe('https://relay.test')
    if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
    return Response.json({ version: 1, accessMode: 'selected', allowedSubjectIds: [identityKeyOf(actor), identityKeyOf(stranger)],
      sessionMode: mode, requests: [] })
  })
  vi.stubGlobal('fetch', fetch)
  onTestFinished(() => { vi.unstubAllGlobals() })
  const start = async () => {
    const stop = await apply(ctx, { ownerStateFile: file })
    onTestFinished(stop)
    // The policy registers once the remote-access service is injected, which settles after this tick.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    // The Relay's complete authority for both shares, as the gateway socket delivers it.
    for (const shareId of empty ? [] : ['share', 'other-share']) {
      worker.event?.({ type: 'share-access-state', registrationToken: randomUUID() as TunnelRegistrationToken,
        shareId, version: 1, accessMode: 'selected',
        allowedSubjectIds: [identityKeyOf(actor), identityKeyOf(stranger)],
        sessionMode: mode })
    }
  }
  /** The registered policy's answer, through the remote access service, for this reader of `share` on one Session. */
  const decide = (sessionId: string, action: 'session/prompt' | 'session/cancel', args?: Readonly<Record<string, unknown>>) =>
    ctx.remoteAccess.decide({ principal: shareViewerPrincipal('share', actor), action,
      resources: [{ kind: 'session', id: SessionId(sessionId) }], ...(args === undefined ? {} : { args }) })
  const agent = (id: string) => ({ id: SessionId(id), session: { id: SessionId(id) } }) as Agent
  return { ctx, start, agent, fetch, file, decide }
}

describe('share-bound receiving Session admission', () => {
  it.each([
    ['private', 'fork-unknown-child'],
    ['other-source', 'fork-unknown-child'],
    ['other-child', 'fork-unknown-child'],
    ['stranger-child', 'fork-viewer-mismatch'],
  ])('denies reader prompt and cancel on %s', async (id, reason) => {
    const fixture = await harness()
    await fixture.start()
    expect(fixture.decide(id, 'session/prompt')).toEqual({ kind: 'deny', reason })
    expect(fixture.decide(id, 'session/cancel')).toEqual({ kind: 'deny', reason })
  })

  it('refuses a reader Peer at the Gateway before the controller prompts or cancels an unshared Session', async () => {
    const fixture = await harness(false, 'write', { gateway: true })
    await mountAgentLoopTestDependencies(fixture.ctx)
    const driver = await mountAgentLoopTestHarness(fixture.ctx)
    await createSessionTestController(fixture.ctx, {
      cwd: process.cwd(), defaultModelSelection: () => ({ provider: 'unused', model: 'unused' }),
    })
    const agent = await driver.create(SessionId('private'))
    const followup = vi.spyOn(agent, 'followup')
    const cancel = vi.spyOn(agent, 'cancel')
    await fixture.start()
    const reader = new Peer(fixture.ctx, { principal: shareViewerPrincipal('share', actor) })
    await expect(fixture.ctx.typertGateway.invoke({ peer: reader, namespace: 'session', method: 'prompt',
      args: { request: { sessionId: agent.session.id, requestId: 'direct' as SessionRequestId, mode: 'queue',
        content: [{ type: 'text', text: 'attack' }] } } }))
      .rejects.toMatchObject({ code: 'remote-access/denied', details: { action: 'session/prompt', reason: 'fork-unknown-child' } })
    await expect(fixture.ctx.typertGateway.invoke({ peer: reader, namespace: 'session', method: 'cancel',
      args: { request: { sessionId: agent.session.id } } }))
      .rejects.toMatchObject({ code: 'remote-access/denied', details: { action: 'session/cancel', reason: 'fork-unknown-child' } })
    expect(followup).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(agent.inbox.nextTurn).toEqual([])
  })

  it('allows the reader its own fork, and its source only once a confined layer exists', async () => {
    const fixture = await harness()
    await fixture.start()
    expect(fixture.decide('own-child', 'session/prompt')).toEqual({ kind: 'allow' })
    // A concrete prompt also needs the child's installed ceiling, which preparing the child installs.
    expect(fixture.decide('own-child', 'session/prompt', { request: {} }))
      .toEqual({ kind: 'deny', reason: 'fork-ceiling-uninstalled' })
    expect(fixture.decide('source', 'session/prompt')).toEqual({ kind: 'deny', reason: 'source-write-unavailable' })
  })

  it('recomputes the reader\u2019s snapshot from the registered policy when the Relay ends its admission', async () => {
    const fixture = await harness()
    await fixture.start()
    const reader = shareViewerPrincipal('share', actor)
    const resources = () => {
      const baseline = fixture.ctx.remoteAccess.snapshotFor(reader)
      return baseline.owner ? [] : baseline.grants.map(grant => grant.resource)
    }
    expect(resources()).toEqual([
      { kind: 'global' }, { kind: 'session', id: 'source' }, { kind: 'session', id: 'own-child' },
    ])
    const invalidate = vi.spyOn(fixture.ctx.remoteAccess, 'invalidate')
    worker.event?.({ type: 'share-access-state', registrationToken: randomUUID() as TunnelRegistrationToken,
      shareId: 'share', version: 2, accessMode: 'selected', allowedSubjectIds: [identityKeyOf(stranger)], sessionMode: 'write' })
    expect(invalidate).toHaveBeenCalled()
    expect(resources()).toEqual([])
    expect(fixture.decide('own-child', 'session/prompt')).toEqual({ kind: 'deny', reason: 'viewer-not-authorized' })
  })

  it('admits the reader’s own child, and refuses a source it cannot confine', async () => {
    // Both tiers drive the shared Session while its confined layer stands. This fixture installs none,
    // so the source is refused for the layer rather than for the tier, and the reader's own branch is
    // driven.
    const fixture = await harness(false, 'view')
    await fixture.start()
    expect(fixture.decide('own-child', 'session/prompt')).toEqual({ kind: 'allow' })
    expect(fixture.decide('source', 'session/prompt')).toEqual({ kind: 'deny', reason: 'source-write-unavailable' })
  })


  it('retains ordinary Owner pre-step when no reader input is recorded', async () => {
    const fixture = await harness(true)
    await fixture.start()
    const next = async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [] })
    expect(await fixture.ctx.waterfall('agent/pre-step', { modelSelection: { provider: 'mock', model: 'mock' }, agent: fixture.agent('private'), turn: 1, step: 1,
      messages: [], signal: new AbortController().signal }, next)).toEqual({ kind: 'enter', messages: [] })
  })

  it.each(['private', 'other-source', 'other-child', 'stranger-child'])(
    'rejects queued reader pre-step on %s independently of API admission', async (id) => {
      const fixture = await harness()
      await fixture.start()
      const message = createUserMessage({ content: [{ type: 'text', text: 'queued' }],
        source: { kind: 'user', rpcId: 'queued' as SessionRequestId, principal: shareViewerPrincipal('share', actor) } })
      const next = async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [message] })
      expect(await fixture.ctx.waterfall('agent/pre-step', { modelSelection: { provider: 'mock', model: 'mock' }, agent: fixture.agent(id), turn: 1, step: 1,
        messages: [message], signal: new AbortController().signal }, next)).toEqual({ kind: 'reject' })
    },
  )

  it('rejects a deleted share from recovered durable Inbox without process-local share history', async () => {
    const fixture = await harness(true)
    await mountAgentLoopTestDependencies(fixture.ctx)
    await fixture.ctx.plugin(JsonlSessionPersistence, { root: join(dirname(fixture.file), 'sessions'), compression: 'none' })
    await mountAgentLoopTestHarness(fixture.ctx)
    const reached = Promise.withResolvers<PreStepDecision>()
    fixture.ctx.on('agent/pre-step', async (_input, next) => {
      const decision = await next()
      reached.resolve(decision)
      // If admission regresses, stop before a real model call while retaining the observed verdict.
      return { kind: 'reject' }
    })
    await fixture.start()
    // The recovered message names its reader in its own durable source; no share-host state names it.
    const message = createUserMessage({ content: [{ type: 'text', text: 'revoked queued input' }],
      source: { kind: 'user', rpcId: 'recovered-input' as SessionRequestId,
        principal: shareViewerPrincipal('deleted-share', actor) } })
    // `prepare` only mints the header; a detached Session cannot append, so the event is written
    // through the persistence seam and the resumed Agent recovers it from the stored log.
    const stored = fixture.ctx.sessions.prepare(SessionId('source'))
    const writer = await fixture.ctx.sessionPersistence.create(stored.header)
    try {
      await writer.append([{
        type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
        data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] },
      }])
    } finally {
      await writer.close()
    }
    // The recovered turn reaches the pre-step waterfall only after a model route resolves.
    const handle = await fixture.ctx.agents.resume({
      resumeSessionId: stored.id,
      agentOptions: { provider: 'unused', model: 'unused' },
    })
    const agent = handle.agent
    expect(agent.inbox.nextTurn).toHaveLength(1)
    const formed = vi.fn()
    fixture.ctx.on('agent/request', formed)
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'resume' }], source: { kind: 'user' } }))
    expect(await reached.promise).toEqual({ kind: 'reject' })
    await agent.whenIdle()
    expect(formed).not.toHaveBeenCalled()
    expect(agent.session.snapshotEvents().some(event => event.type === 'step/start')).toBe(false)
  })
})
