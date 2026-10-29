/**
 * Owner share management is owner-only even when it arrives over Typert Remote.
 *
 * The owner Peer reaches the one share-management implementation. A `share-viewer` Peer is
 * decided by the `share-viewer` policy before any method runs, so a refused call cannot create a
 * share, register one with the Relay, or change the selected address.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { apply } from '../src/host/share-host.ts'
import type { TunnelWorkerInput } from '../src/host/tunnel-worker.ts'
import { writeOwnerState } from './owner-identity-fixture.ts'

const worker = vi.hoisted(() => ({
  listener: undefined as ((event: TunnelWorkerEvent) => void) | undefined,
  sent: [] as TunnelWorkerInput[],
}))

vi.mock('../src/host/tunnel-worker.ts', () => ({
  TunnelWorker: class {
    start() {}
    onEvent(listener: (event: TunnelWorkerEvent) => void) { worker.listener = listener; return () => {} }
    send(command: TunnelWorkerInput) { worker.sent.push(command) }
    stop() { worker.listener = undefined; return Promise.resolve() }
  },
}))

const actor = { providerId: 'mock', tenantId: 'tenant', subjectId: 'viewer' }

interface Harness {
  readonly owner: Peer
  readonly viewer: Peer
  readonly invoke: (peer: Peer, method: string, args: Record<string, unknown>) => Promise<unknown>
  readonly stateFile: string
}

/**
 * Mount a real Gateway and remote access service over an owner host whose worker is a recorder.
 * @returns Peers and the direct Remote invocation used by both cases.
 */
async function harness(): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-share-remote-'))
  const stateFile = join(directory, 'owner-shares.json')
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  ctx.provide('connection', {
    fetch: {
      register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
        void route
        return () => {}
      },
    },
    rpc: { intercept: () => () => {} },
    createPeer: (options: ConstructorParameters<typeof Peer>[1]) => new Peer(ctx, options),
  } as never)
  await ctx.plugin(TypertGateway, {})
  // Startup probes the effective Relay for owner-credential support and, with no stored shares,
  // reaches no share route. A share's authority read would use the same address.
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith('/__liveshare/owner-credential')) return Response.json({ supported: true })
    if (url.pathname.endsWith('/__liveshare/requests')) {
      return Response.json({ version: 1, accessMode: 'open', allowedSubjectIds: [],
        sessionMode: 'view', allowsFork: false })
    }
    return new Response('', { status: 404 })
  }))
  worker.sent.length = 0
  const dispose = await apply(ctx, {
    ownerStateFile: writeOwnerState(stateFile, 'https://relay.test'),
  })
  // The Session resource kind's default resolver is registered by the Session Controller, the domain
  // that owns the kind, so these calls decide against that registration and not a stand-in.
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await createSessionTestController(ctx, {
    cwd: process.cwd(),
    defaultModelSelection: () => ({ provider: 'unused', model: 'unused' }),
  })
  onTestFinished(async () => {
    await dispose()
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
    rmSync(directory, { recursive: true, force: true })
  })
  expect(ctx.get('liveshareShares')).toBeDefined()
  const invoke = (peer: Peer, method: string, args: Record<string, unknown>): Promise<unknown> =>
    ctx.typertGateway.invoke({ peer, namespace: 'liveshareShares', method, args })
  return {
    owner: new Peer(ctx, { principal: { kind: 'owner' } }),
    viewer: new Peer(ctx, { principal: { kind: 'share-viewer', shareId: 'share-1', actor } }),
    invoke,
    stateFile,
  }
}

describe('liveshare owner share management over Remote', () => {
  it('serves the owner Peer\u2019s share list', async () => {
    const { invoke, owner } = await harness()
    await expect(invoke(owner, 'list', {})).resolves.toEqual({ shares: [] })
  })

  it('refuses every management method to a share viewer Peer without side effects', async () => {
    const { invoke, owner, viewer, stateFile } = await harness()
    const calls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['list', {}],
      ['create', { request: { sessionId: 'session-1' } }],
      ['stop', { request: { shareId: 'share-1' } }],
      ['setRelay', { request: { relayUrl: 'https://other-relay.test' } }],
    ]
    for (const [method, args] of calls) {
      await expect(invoke(viewer, method, args)).rejects.toMatchObject({
        code: 'remote-access/denied',
        details: { action: `liveshareShares/${method}` },
      })
    }
    // The refused create and stop left the owner's state and the worker channel untouched.
    await expect(invoke(owner, 'list', {})).resolves.toEqual({ shares: [] })
    await expect(invoke(owner, 'relay', {})).resolves.toEqual({
      override: 'https://relay.test',
      effective: 'https://relay.test',
    })
    expect(worker.sent).toEqual([])
    if (existsSync(stateFile)) {
      const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as { readonly shares?: readonly unknown[] }
      expect(persisted.shares ?? []).toEqual([])
    }
  })

  it('resolves create\u2019s request Session through the Session default resolver', async () => {
    const { invoke, viewer } = await harness()
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    onTestFinished(() => { decide.mockRestore() })
    await expect(invoke(viewer, 'create', { request: { sessionId: 'session-1' } })).rejects.toMatchObject({
      code: 'remote-access/denied',
      details: { action: 'liveshareShares/create' },
    })
    // The call names its Session through the one request object, so the identity the policy reads is
    // that Session and not the global resource.
    expect(decide).toHaveBeenCalledOnce()
    expect(decide.mock.calls[0]?.[0]).toMatchObject({
      action: 'liveshareShares/create',
      resources: [{ kind: 'session', id: 'session-1' }],
      args: { request: { sessionId: 'session-1' } },
    })
    expect(worker.sent).toEqual([])
  })

  it('serves create to the owner Peer without a Gateway resource decision', async () => {
    const { invoke, owner } = await harness()
    const decide = vi.spyOn(RemoteAccessService.prototype, 'decide')
    onTestFinished(() => { decide.mockRestore() })
    // The owner Peer reaches the operation, whose own credential gate refuses this host; no Gateway
    // access decision runs for an owner call.
    await expect(invoke(owner, 'create', { request: { sessionId: 'session-1' } })).rejects.toMatchObject({
      code: 'liveshareShares/owner-login-required',
    })
    expect(decide).not.toHaveBeenCalled()
    expect(worker.sent).toEqual([])
  })
})
