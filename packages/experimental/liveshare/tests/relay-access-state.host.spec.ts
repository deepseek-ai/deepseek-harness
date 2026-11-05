/** Relay grants apply without owner UI polling; stale snapshots cannot revive denied readers. */
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ShareAccessStateFrame, TunnelRegistrationToken, TunnelWorkerEvent, TunnelRequestToken } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { TunnelWorkerInput } from '../src/host/tunnel-worker.ts'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { apply } from '../src/host/share-host.ts'

const worker = vi.hoisted(() => ({ event: undefined as ((event: TunnelWorkerEvent) => void) | undefined,
  sent: [] as TunnelWorkerInput[] }))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(callback: (event: TunnelWorkerEvent) => void) { worker.event = callback; return () => {} }
  send(command: TunnelWorkerInput) { worker.sent.push(command) }
  stop() { worker.event = undefined; return Promise.resolve() }
} }))
const alice = { providerId: 'provider', tenantId: 'tenant', subjectId: 'alice' }
const bob = { ...alice, subjectId: 'bob' }

async function host() {
  worker.sent.length = 0
  const registrationToken = randomUUID() as TunnelRegistrationToken
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-authority-'))
  const stateFile = join(directory, 'owner.json')
  writeFileSync(stateFile, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.test',
    shares: [{ relay: 'https://relay.test', shareId: 'share', sessionId: 'source',
      sessionTitle: 'Source', accessMode: 'selected', gatewayToken: 'token', allowedSubjectIds: [],
      createdAt: '2026-10-08T00:00:00Z', sessionMode: 'view' }] }))
  const ctx = new Context()
  const dispatched: string[] = []
  const entered = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>()
  const released = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>()
  let block = false
  const connection = {
    fetch: { register: () => () => {} },
    createPeer: (options: ConstructorParameters<typeof Peer>[1]) => new Peer(ctx, options),
    createSharedFetchHandler: () => ({
      fetch: async (request: Request) => {
        const body = await request.json() as { rpcId: string }
        entered.get(body.rpcId)?.resolve(undefined)
        if (block) await released.get(body.rpcId)?.promise
        request.signal.throwIfAborted()
        dispatched.push(body.rpcId)
        return Response.json({ rpcId: body.rpcId, result: { ok: true, value: {} } })
      },
    }),
  }
  ctx.provide('connection', connection as never)
  let authority: ShareAccessStateFrame = { type: 'share-access-state', version: 1, accessMode: 'selected',
    allowedSubjectIds: [identityKeyOf(alice), identityKeyOf(bob)], sessionMode: 'view' }
  const snapshotEntered = Promise.withResolvers<undefined>()
  const snapshotRelease = Promise.withResolvers<undefined>()
  let holdSnapshot = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.origin).toBe('https://relay.test')
    if (url.pathname.endsWith('/owner-credential')) return Response.json({ supported: true })
    expect(url.pathname).toBe('/__liveshare/requests')
    expect(request.headers.get('authorization')).toBe('Bearer token')
    const captured = authority
    snapshotEntered.resolve(undefined)
    if (holdSnapshot) await snapshotRelease.promise
    return Response.json({ ...captured, requests: [] })
  })
  const stop = await apply(ctx, { ownerStateFile: stateFile })
  onTestFinished(async () => {
    snapshotRelease.resolve(undefined)
    for (const release of released.values()) release.resolve(undefined)
    await stop()
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  })
  const call = async (rpcId: string, actor = alice) => {
    const token = rpcId as TunnelRequestToken
    const answered = Promise.withResolvers<TunnelWorkerInput>()
    const wait = vi.waitFor(() => {
      const response = worker.sent.find(frame => frame.type === 'share-rpc-response' && frame.token === token)
      if (response === undefined) throw new Error('pending response')
      answered.resolve(response)
    })
    worker.event?.({ type: 'share-rpc-request', registrationToken, token, id: worker.sent.length + 1, shareId: 'share', actor,
      body: { op: 'call', path: '/api/commands/list', body: { type: 'client-request', rpcId,
        method: 'commands/list', payload: { args: {} } } } })
    await wait
    return answered.promise
  }
  const start = (rpcId: string, actor = alice) => {
    entered.set(rpcId, Promise.withResolvers<undefined>())
    released.set(rpcId, Promise.withResolvers<undefined>())
    worker.event?.({ type: 'share-rpc-request', registrationToken, token: rpcId as TunnelRequestToken,
      id: worker.sent.length + 1, shareId: 'share', actor,
      body: { op: 'call', path: '/api/commands/list', body: { type: 'client-request', rpcId,
        method: 'commands/list', payload: { args: {} } } } })
    const enteredPromise = entered.get(rpcId)
    if (enteredPromise === undefined) throw new Error('request was not registered')
    return enteredPromise.promise
  }
  return { call, start, stop, dispatched, entered, released, snapshotEntered, snapshotRelease, registrationToken,
    block: () => { block = true }, holdSnapshot: () => { holdSnapshot = true },
    setAuthority: (next: ShareAccessStateFrame) => { authority = next },
    get authority() { return authority } }
}

describe('Relay access state at the Host', () => {
  it('admits an independently approved viewer without reading the owner UI', async () => {
    const fixture = await host()
    expect(await fixture.call('approved')).toMatchObject({ type: 'share-rpc-response', status: 200 })
    expect(fixture.dispatched).toEqual(['approved'])
  })
  it('ends revoked in-flight calls, preserves another actor, and ignores an older grant frame', async () => {
    const fixture = await host()
    await fixture.call('baseline')
    fixture.block()
    await fixture.start('alice-waiting')
    await fixture.start('bob-waiting', bob)
    const revoked = { ...fixture.authority, version: 2, allowedSubjectIds: [identityKeyOf(bob)] }
    fixture.setAuthority(revoked)
    worker.event?.({ ...revoked, registrationToken: fixture.registrationToken, shareId: 'share' })
    worker.event?.({ ...fixture.authority, registrationToken: fixture.registrationToken,
      version: 1, allowedSubjectIds: [identityKeyOf(alice)], shareId: 'share' })
    fixture.released.get('alice-waiting')?.resolve(undefined)
    fixture.released.get('bob-waiting')?.resolve(undefined)
    await vi.waitFor(() => { expect(fixture.dispatched).toContain('bob-waiting') })
    expect(fixture.dispatched).not.toContain('alice-waiting')
    expect(await fixture.call('revoked')).toMatchObject({ status: 403 })
  })
  it('refuses a delayed snapshot from a lost socket generation', async () => {
    const fixture = await host()
    fixture.holdSnapshot()
    void fixture.start('old-generation')
    await fixture.snapshotEntered.promise
    worker.event?.({ type: 'share-closed', registrationToken: fixture.registrationToken, shareId: 'share' })
    fixture.snapshotRelease.resolve(undefined)
    await fixture.stop()
    expect(worker.sent.some(frame => frame.type === 'share-rpc-response' && frame.token === 'old-generation')).toBe(false)
    expect(fixture.dispatched).toEqual([])
  })
})
