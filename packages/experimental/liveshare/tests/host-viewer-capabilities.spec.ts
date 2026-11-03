/**
 * The owner's per-share viewer endpoint selection at the Host: the offer list the panel reads (the
 * platform catalog), the write that validates against it, and the same stored selection reaching the
 * `share-viewer` policy that decides each viewer call.
 */
import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import RemoteAccessService, { type RemoteAccessAction, type RemoteAccessGrant } from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { TunnelRegistrationToken, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { identityKeyOf } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { apply, type Config } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'
import { shareViewerPrincipal } from '../src/host/viewer-principal.ts'
import { endpointContribution } from './viewer-endpoint-fixture.ts'

const worker = vi.hoisted(() => ({ event: undefined as ((event: TunnelWorkerEvent) => void) | undefined }))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(callback: (event: TunnelWorkerEvent) => void) { worker.event = callback; return () => {} }
  send() {}
  stop() { worker.event = undefined; return Promise.resolve() }
} }))

const actor = { providerId: 'fixture', tenantId: 'tenant', subjectId: 'viewer' }
/** The catalog group this host can offer because the fixture registers both endpoints. */
const CATALOG = {
  plugin: 'mekGit',
  package: '@fixture/platform',
  endpoints: ['mekGit/getGraph', 'mekGit/graphMeta'],
}
const GLOBAL = { kind: 'global' } as const

type OwnerRoutes = Map<string, (request: Request) => Promise<Response>>

function connectionService(routes: OwnerRoutes) {
  return {
    fetch: {
      register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route.fetch)
        return Promise.resolve(async () => {})
      },
    },
  } as never
}

/** Answer every Relay request this host makes during a case: no owner credential, one admitted share. */
function stubRelay(): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url)
    return url.pathname.endsWith('/owner-credential')
      ? Response.json({ supported: false })
      : Response.json({ version: 1, accessMode: 'open', allowedSubjectIds: [identityKeyOf(actor)],
        sessionMode: 'write', requests: [] })
  })
  onTestFinished(() => { vi.unstubAllGlobals() })
}

/**
 * One mounted owner host with a single stored share and Typert registrations for the catalog
 * endpoints this case can select.
 * @returns The mounted host and the calls these cases make against it.
 */
async function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-capabilities-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const file = join(directory, 'owner.json')
  writeFileSync(file, JSON.stringify({ instanceId: 'owner', relayUrl: 'https://relay.test', shares: [{
    relay: 'https://relay.test', shareId: 'share', sessionId: 'source', sessionTitle: 'Source', accessMode: 'open',
    gatewayToken: 'token', allowedSubjectIds: [identityKeyOf(actor)], createdAt: '2026-10-08T00:00:00Z',
    sessionMode: 'write', allowsFork: true,
  }] }))
  const routes: OwnerRoutes = new Map()
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('connection', connectionService(routes))
  await ctx.plugin(TypertRegistry)
  ctx.typert.register(endpointContribution('@fixture/platform', [...CATALOG.endpoints]))
  await ctx.plugin(RemoteAccessService)
  stubRelay()
  const config: Config = { ownerStateFile: file }
  const stop = await apply(ctx, config)
  onTestFinished(stop)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  worker.event?.({ type: 'share-access-state', registrationToken: randomUUID() as TunnelRegistrationToken,
    shareId: 'share', version: 1, accessMode: 'open', allowedSubjectIds: [identityKeyOf(actor)], sessionMode: 'write' })
  const setCapabilities = async (viewerPlugins: unknown, viewerPluginAccess?: 'all' | 'none', shareId = 'share') =>
    await ctx.liveshareShares.setCapabilities({ shareId, viewerPlugins, viewerPluginAccess } as never)
  const storedShares = async () => (await ctx.liveshareShares.list()).shares
  const decide = (action: RemoteAccessAction, resource: { kind: 'global' } = GLOBAL) =>
    ctx.remoteAccess.decide({ principal: shareViewerPrincipal('share', actor), action, resources: [resource] })
  const grants = (): readonly RemoteAccessGrant[] => {
    const baseline = ctx.remoteAccess.snapshotFor(shareViewerPrincipal('share', actor))
    return baseline.owner ? [] : baseline.grants
  }
  const snapshotted = (action: string): boolean =>
    grants().some(grant => [...grant.actions].some(granted => granted === action))
  const persisted = (): Record<string, unknown> => {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { shares: readonly Record<string, unknown>[] }
    const share = parsed.shares.find(entry => entry.shareId === 'share')
    if (share === undefined) throw new Error('share missing from the owner state file')
    return share
  }
  return { ctx, setCapabilities, storedShares, decide, snapshotted, persisted }
}

describe('owner endpoint selection over the platform catalog', () => {
  it('offers the registered catalog endpoints and exposes one only after the owner selects it', async () => {
    const host = await harness()
    expect(host.ctx.liveshareShares.capabilities().capabilities).toEqual([CATALOG])
    expect(host.decide('mekGit/getGraph')).toEqual({ kind: 'deny', reason: 'liveshare/read-only' })
    const accepted = await host.setCapabilities([
      { plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/getGraph'] },
    ])
    expect(accepted).toEqual({ shareId: 'share', viewerPluginAccess: 'custom', viewerPlugins: [
      { plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/getGraph'] },
    ] })
    expect(host.decide('mekGit/getGraph')).toEqual({ kind: 'allow' })
    expect(host.snapshotted('mekGit/getGraph')).toBe(true)
    expect(host.decide('mekGit/graphMeta')).toEqual({ kind: 'deny', reason: 'liveshare/read-only' })
  })

  it('withdraws exposure at once when the owner clears the selection', async () => {
    const host = await harness()
    await host.setCapabilities([{ plugin: 'mekGit', mode: 'all' }])
    expect(host.decide('mekGit/getGraph')).toEqual({ kind: 'allow' })
    const cleared = await host.setCapabilities([])
    expect(cleared.viewerPlugins).toEqual([])
    expect(host.decide('mekGit/getGraph')).toEqual({ kind: 'deny', reason: 'liveshare/read-only' })
    expect(host.persisted()).not.toHaveProperty('viewerPlugins')
  })

  it('refuses an endpoint the catalog does not offer, naming it', async () => {
    const host = await harness()
    await expect(host.setCapabilities([
      { plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/unknown'] },
    ]))
      .rejects.toMatchObject({ code: 'liveshareShares/endpoint-not-offered' })
    expect(host.persisted()).not.toHaveProperty('viewerPlugins')
  })

  it('refuses a plugin the catalog does not name', async () => {
    const host = await harness()
    await expect(host.setCapabilities([{ plugin: 'gone', mode: 'all' }]))
      .rejects.toMatchObject({ code: 'liveshareShares/unknown-plugin' })
  })

  it('keeps the previous selection when a later submission is refused', async () => {
    const host = await harness()
    await host.setCapabilities([{ plugin: 'mekGit', mode: 'all' }])
    await expect(host.setCapabilities([
      { plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/unknown'] },
    ]))
      .rejects.toMatchObject({ code: 'liveshareShares/endpoint-not-offered' })
    expect(host.decide('mekGit/getGraph')).toEqual({ kind: 'allow' })
  })

  it('opens every offered method when the global switch is all', async () => {
    const host = await harness()
    const accepted = await host.setCapabilities([], 'all')
    expect(accepted.viewerPluginAccess).toBe('all')
    expect(host.decide('mekGit/getGraph')).toEqual({ kind: 'allow' })
    expect(host.decide('mekGit/graphMeta')).toEqual({ kind: 'allow' })
    expect(host.persisted()).toMatchObject({ viewerPluginAccess: 'all' })
  })

  it('refuses an unknown global switch', async () => {
    const host = await harness()
    await expect(host.setCapabilities([], 'maybe' as never))
      .rejects.toMatchObject({ code: 'liveshareShares/invalid-capabilities' })
  })

  it('refuses a share this host does not hold', async () => {
    const host = await harness()
    await expect(host.setCapabilities([], undefined, 'missing')).rejects.toMatchObject({ code: 'liveshareShares/share-not-found' })
  })
})
