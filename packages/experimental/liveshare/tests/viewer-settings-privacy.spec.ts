/**
 * A shared reader never obtains the Owner's global configuration document.
 *
 * The reader's calls reach the Owner's Gateway as the reader's own Peer, and the Gateway admits a
 * non-owner Peer only to the actions this package's `share-viewer` policy binds, so the Owner's
 * configuration services never run for it.
 */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import { Peer, type ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService, type PeerScope, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createViewerAccessPolicy } from '../src/host/viewer-access-policy.ts'
import type { ForkShareState } from '../src/host/fork-policy.ts'
import { createViewerReadService } from '../src/host/viewer-read.ts'
import { readerConnection } from './viewer-read-peers.ts'

const actor = { providerId: 'oidc', tenantId: 'fixture-tenant', subjectId: 'reader' }
const privateValues = ['private-provider.invalid', 'SYNTHETIC_NOT_A_REAL_SECRET',
  '/fixture/private-root', 'fixture-private-tenant', 'provider-fixture']

type GatewayRpc = (endpoint: string, payload: unknown, signal: AbortSignal, peer: PeerScope) => Promise<ConnectionRpcResult<unknown>>

/** An Owner page read a share reader is allowed, recording whom each call spoke for. */
class CommandsFixture extends TypertRemoteService {
  readonly callers: Principal[] = []

  constructor(ctx: Context) {
    super(ctx, 'commandsFixture', { namespace: 'commands' })
  }

  @Remote
  list(): readonly string[] {
    const principal = this.ctx.invocation?.peer.principal
    if (principal !== undefined) this.callers.push(principal)
    return []
  }
}

async function harness(mode: 'view' | 'write' = 'view') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  let intercepted: GatewayRpc | undefined
  ctx.provide('connection', {
    rpc: { intercept: (_path: string, _claims: unknown, handler: GatewayRpc) => { intercepted = handler; return () => {} } },
  } as never)
  await ctx.plugin(TypertGateway, {})
  const rpc: GatewayRpc = (endpoint, payload, signal, peer) => {
    if (intercepted === undefined) throw new Error('Gateway interceptor was not registered')
    return intercepted(endpoint, payload, signal, peer)
  }
  const namespaces: SettingsDescriptor[] = [{
    ns: 'provider-fixture' as SettingsDescriptor['ns'],
    autoGenerate: false, schema: {}, applies: 'live', revision: 0,
    value: { providers: { fixture: { baseURL: 'https://private-provider.invalid',
      headers: { authorization: 'SYNTHETIC_NOT_A_REAL_SECRET' } } } },
    base: { privateDirectory: '/fixture/private-root' },
    user: { tenant: 'fixture-private-tenant' },
  }]
  const describeSettings = vi.fn(() => namespaces)
  ctx.provide('settings', { writable: true, describe: describeSettings } as never)
  await ctx.plugin(SettingsController)
  await ctx.plugin(CommandsFixture)
  const commands = ctx.get('commandsFixture') as CommandsFixture
  const share: ForkShareState = { shareId: 'share', sessionId: 'shared-source',
    sessionMode: mode, allowsFork: mode !== 'view', viewerAdmitted: true, stopped: false }
  ctx.remoteAccess.registerPolicy('share-viewer', createViewerAccessPolicy({
    share: shareId => shareId === share.shareId ? share : undefined,
    viewerAdmitted: () => true,
    sourceConfined: () => true,
    forks: {
      find: () => undefined,
      listForShare: () => [],
      allowsPrompt: () => ({ ok: false, code: 'fork-unknown-child', message: 'this Owner holds no forks' }),
    },
    workspaces: () => [],
    declaredCapabilities: () => [],
  }))
  // The Owner's shared `/api` handler: one Connection request decoded and handed to the Gateway as its Peer.
  const readers = readerConnection(async (request, peer) => {
    const envelope = await request.json() as { readonly rpcId: string; readonly method: string; readonly payload: unknown }
    return Response.json({
      type: 'server-response',
      rpcId: envelope.rpcId,
      result: await rpc(envelope.method, envelope.payload, request.signal, peer),
    })
  })
  const reader = createViewerReadService({
    sharedSessionId: () => share.sessionId,
    viewerStillAdmitted: () => true,
    forkStateOf: () => share,
    connection: readers.connection,
  })
  onTestFinished(async () => {
    reader.close()
    await readers.dispose()
  })
  const read = (method: string) => reader.answer('share', {
    op: 'call', path: `/api/${method}`,
    body: { type: 'client-request', rpcId: `${method}-read`, method, payload: { args: {} } },
  }, actor)
  return { ctx, rpc, read, describeSettings, commands }
}

describe('shared reader configuration privacy', () => {
  it.each(['view', 'write'] as const)('refuses global reads in %s without running the Owner\u2019s configuration services', async (mode) => {
    const { read, describeSettings } = await harness(mode)
    for (const method of ['settings/describe', 'credentials/describe']) {
      const answer = await read(method)
      expect(answer).toMatchObject({ status: 200, body: { result: {
        ok: false, error: { code: 'remote-access/denied', details: { action: method, reason: 'liveshare/read-only' } },
      } } })
      for (const value of privateValues) expect(JSON.stringify(answer)).not.toContain(value)
    }
    expect(describeSettings).not.toHaveBeenCalled()
  })

  it('keeps an allowed page read available to the same reader', async () => {
    const { read, commands } = await harness()
    expect(await read('commands/list')).toMatchObject({ status: 200, body: { result: { ok: true, value: [] } } })
    expect(commands.callers).toEqual([{ kind: 'share-viewer', shareId: 'share', actor }])
  })

  it('leaves the normal Owner settings endpoint unchanged', async () => {
    const { ctx, rpc } = await harness()
    const owner = new Peer(ctx, { principal: { kind: 'owner' } })
    expect(await rpc('settings/describe', { args: {} }, AbortSignal.timeout(10_000), owner)).toMatchObject({
      ok: true,
      value: { writable: true, hasDocument: true, namespaces: [{ ns: 'provider-fixture', value: { providers: { fixture: {
        baseURL: 'https://private-provider.invalid', headers: { authorization: 'SYNTHETIC_NOT_A_REAL_SECRET' },
      } } } }] },
    })
  })
})
