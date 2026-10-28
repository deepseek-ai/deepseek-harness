/** Queued reader input is rechecked against Relay admission at the actual pre-step, from its own message source. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/host/share-host.ts'

vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent() { return () => {} }
  send() {}
  stop() { return Promise.resolve() }
} }))

it('rejects queued viewer input after Relay independently revoked it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-pre-step-'))
  const file = join(directory, 'owner.json')
  writeFileSync(file, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.test',
    shares: [{ relay: 'https://relay.test', shareId: 'share', sessionId: 'source',
      sessionTitle: 'Source', accessMode: 'selected', gatewayToken: 'token', allowedSubjectIds: ['viewer'],
      createdAt: '2026-10-08T00:00:00Z', sessionMode: 'write', allowsFork: true }] }))
  const ctx = new Context()
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  const actor = { providerId: 'provider', tenantId: 'tenant', subjectId: 'viewer' }
  const requestId = 'queued-input' as SessionRequestId
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
    expect(request.headers.get('authorization')).toBe('Bearer token')
    return Response.json({ version: 2, accessMode: 'selected', allowedSubjectIds: [], sessionMode: 'write', requests: [] })
  })
  const stop = await apply(ctx, { ownerStateFile: file })
  onTestFinished(async () => {
    await stop()
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  })
  // The message records the reader it came from; the turn it enters has decided no requester yet.
  const message = createUserMessage({ content: [{ type: 'text', text: 'queued' }],
    source: { kind: 'user', rpcId: requestId, principal: { kind: 'share-viewer', shareId: 'share', actor } } })
  const agent = { id: SessionId('source'), session: { id: SessionId('source') } } as Agent
  const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [message] }))
  expect(await ctx.waterfall('agent/pre-step', { modelSelection: { provider: 'mock', model: 'mock' }, agent, turn: 4, step: 1, messages: [message],
    signal: new AbortController().signal }, next)).toEqual({ kind: 'reject' })
  expect(next).toHaveBeenCalledOnce()
})

it('rejects a steer of a revoked reader when its step starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-steer-'))
  const file = join(directory, 'owner.json')
  writeFileSync(file, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.test',
    shares: [{ relay: 'https://relay.test', shareId: 'share', sessionId: 'source',
      sessionTitle: 'Source', accessMode: 'selected', gatewayToken: 'token', allowedSubjectIds: ['viewer'],
      createdAt: '2026-10-08T00:00:00Z', sessionMode: 'write', allowsFork: true }] }))
  const ctx = new Context()
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  const actor = { providerId: 'provider', tenantId: 'tenant', subjectId: 'viewer' }
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
    return Response.json({ version: 2, accessMode: 'selected', allowedSubjectIds: [], sessionMode: 'write', requests: [] })
  })
  const stop = await apply(ctx, { ownerStateFile: file })
  onTestFinished(async () => {
    await stop()
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  })
  const steered = createUserMessage({ content: [{ type: 'text', text: 'steer' }],
    source: { kind: 'user', rpcId: 'steer-1' as SessionRequestId, principal: { kind: 'share-viewer', shareId: 'share', actor } } })
  const agent = { id: SessionId('source'), session: { id: SessionId('source') } } as Agent
  const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [steered] }))
  expect(await ctx.waterfall('agent/pre-step', { modelSelection: { provider: 'mock', model: 'mock' }, agent, turn: 2, step: 2, messages: [steered],
    signal: new AbortController().signal }, next)).toEqual({ kind: 'reject' })
})

it('keeps a normal admitted viewer step entering the model', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-pre-step-ok-'))
  const file = join(directory, 'owner.json')
  const actor = { providerId: 'provider', tenantId: 'tenant', subjectId: 'viewer' }
  writeFileSync(file, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.test',
    shares: [{ relay: 'https://relay.test', shareId: 'share', sessionId: 'source',
      sessionTitle: 'Source', accessMode: 'selected', gatewayToken: 'token', allowedSubjectIds: [identityKeyOf(actor)],
      createdAt: '2026-10-08T00:00:00Z', sessionMode: 'write', allowsFork: true }] }))
  const ctx = new Context()
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url.endsWith('/owner-credential')) return Response.json({ supported: true })
    return Response.json({ version: 2, accessMode: 'selected', allowedSubjectIds: [identityKeyOf(actor)],
      sessionMode: 'write', requests: [] })
  })
  const stop = await apply(ctx, { ownerStateFile: file })
  onTestFinished(async () => {
    await stop()
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  })
  const message = createUserMessage({ content: [{ type: 'text', text: 'normal' }],
    source: { kind: 'user', rpcId: 'normal-1' as SessionRequestId, principal: { kind: 'share-viewer', shareId: 'share', actor } } })
  const agent = { id: SessionId('source'), session: { id: SessionId('source') } } as Agent
  const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'enter', messages: [message] }))
  expect(await ctx.waterfall('agent/pre-step', { modelSelection: { provider: 'mock', model: 'mock' }, agent, turn: 3, step: 1, messages: [message],
    signal: new AbortController().signal }, next)).toMatchObject({ kind: 'enter' })
})
