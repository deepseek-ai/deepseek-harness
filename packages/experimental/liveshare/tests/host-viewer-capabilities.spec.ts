/**
 * The owner's per-share plugin endpoint selection at the Host: the offer list the panel reads, the
 * write that validates against it, the record the share list echoes back, and the same stored selection
 * reaching the `share-viewer` policy that decides each viewer call. The last case covers boot order: the
 * surface exists before the share host's connection, so a plugin that loads first still offers.
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
import * as Bundle from '../src/index.ts'
import * as ViewerDeclarationsEntry from '../src/viewer-declarations.ts'
import { ViewerDeclarations, viewerDeclarationsOf } from '../src/host/viewer-declarations.ts'
import { shareViewerPrincipal } from '../src/host/viewer-principal.ts'
import { endpointContribution, mountDeclaringPlugin } from './viewer-endpoint-fixture.ts'

const worker = vi.hoisted(() => ({ event: undefined as ((event: TunnelWorkerEvent) => void) | undefined }))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(callback: (event: TunnelWorkerEvent) => void) { worker.event = callback; return () => {} }
  send() {}
  stop() { worker.event = undefined; return Promise.resolve() }
} }))

const actor = { providerId: 'fixture', tenantId: 'tenant', subjectId: 'viewer' }
/**
 * The mounted plugin's package, which is also the offer's attribution: a declaration is accepted only from the
 * package that owns the endpoint.
 */
const PLUGIN = '@fixture/mek-git'
const DECLARER = 'mekGit'
const READABLE = 'mekGit/getGraph'
const WRITABLE = 'mekGit/commit'
const GLOBAL = { kind: 'global' } as const

type OwnerRoutes = Map<string, (request: Request) => Promise<Response>>

/**
 * The connection service an owner host registers its same-origin API routes through.
 * @param routes - Collects each registered path with its handler.
 * @returns The minimal `connection` service these cases provide.
 */
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
 * One mounted owner host with a single stored share, the plugin that offers the endpoints, and the
 * Relay's admission for the one viewer these cases act as.
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
  ctx.typert.register(endpointContribution(PLUGIN, [READABLE, WRITABLE]))
  await ctx.plugin(RemoteAccessService)
  stubRelay()
  const config: Config = { ownerStateFile: file }
  const stop = await apply(ctx, config)
  onTestFinished(stop)
  // The declarations bind to the declaring plugin's own fiber; this fixture mounts the plugin after the
  // host that provides the surface. The boot-order cases below mount the plugin first.
  await mountDeclaringPlugin(ctx, DECLARER, PLUGIN, (pluginCtx) => {
    viewerDeclarationsOf(pluginCtx)?.registerViewerReadable([READABLE])
    viewerDeclarationsOf(pluginCtx)?.registerViewerWritable([WRITABLE])
  })
  // The policy registers once the remote-access service is injected, which settles after this tick.
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  worker.event?.({ type: 'share-access-state', registrationToken: randomUUID() as TunnelRegistrationToken,
    shareId: 'share', version: 1, accessMode: 'open', allowedSubjectIds: [identityKeyOf(actor)], sessionMode: 'write' })
  // Invalid submissions are what these cases exercise, so the helper hands the operation the raw
  // value a decoded wire body would carry.
  const setCapabilities = async (capabilities: unknown, shareId = 'share') =>
    await ctx.liveshareShares.setCapabilities({ shareId, capabilities } as never)
  const storedShares = async () => (await ctx.liveshareShares.list()).shares
  const decide = (action: RemoteAccessAction, resource: { kind: 'global' } = GLOBAL) =>
    ctx.remoteAccess.decide({ principal: shareViewerPrincipal('share', actor), action, resources: [resource] })
  /** The grants the policy publishes to this reader right now. */
  const grants = (): readonly RemoteAccessGrant[] => {
    const baseline = ctx.remoteAccess.snapshotFor(shareViewerPrincipal('share', actor))
    return baseline.owner ? [] : baseline.grants
  }
  const snapshotted = (action: string): boolean =>
    grants().some(grant => [...grant.actions].some(granted => granted === action))
  /** The persisted record for this share, as the owner state file holds it. */
  const persisted = (): Record<string, unknown> => {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { shares: readonly Record<string, unknown>[] }
    const share = parsed.shares.find(entry => entry.shareId === 'share')
    if (share === undefined) throw new Error('share missing from the owner state file')
    return share
  }
  return { ctx, setCapabilities, storedShares, decide, snapshotted, persisted }
}

describe('owner endpoint selection over the owner API', () => {
  it('offers what the plugins declare and nothing else', async () => {
    const host = await harness()
    expect(host.ctx.liveshareShares.capabilities()).toEqual({
      capabilities: [{ plugin: PLUGIN, readable: [READABLE], writable: [WRITABLE] }],
    })
  })

  it('stores a selection, echoes it, and reaches the reader policy at once', async () => {
    const host = await harness()
    const invalidate = vi.spyOn(host.ctx.remoteAccess, 'invalidate')
    // Nothing is exposed before the owner selects anything, whatever the plugins offer.
    expect(host.decide(READABLE)).toEqual({ kind: 'deny', reason: 'liveshare/read-only' })
    expect(host.snapshotted(READABLE)).toBe(false)

    const accepted = await host.setCapabilities([{ plugin: PLUGIN, readable: [READABLE], writable: [] }])
    expect(accepted).toEqual({ shareId: 'share', viewerCapabilities: [
      { plugin: PLUGIN, readable: [READABLE], writable: [] },
    ] })
    expect(invalidate).toHaveBeenCalledTimes(1)
    // The policy reads the record and the offers per decision, so the very next call is allowed.
    expect(host.decide(READABLE)).toEqual({ kind: 'allow' })
    expect(host.snapshotted(READABLE)).toBe(true)
    expect(host.persisted().viewerCapabilities).toEqual([{ plugin: PLUGIN, readable: [READABLE], writable: [] }])
    expect((await host.storedShares())[0]?.viewerCapabilities)
      .toEqual([{ plugin: PLUGIN, readable: [READABLE], writable: [] }])
  })

  it('withdraws exposure at once when the owner clears the selection', async () => {
    const host = await harness()
    await host.setCapabilities([{ plugin: PLUGIN, readable: [READABLE], writable: [WRITABLE] }])
    expect(host.decide(READABLE)).toEqual({ kind: 'allow' })

    const cleared = await host.setCapabilities([])
    expect(cleared.viewerCapabilities).toEqual([])
    expect(host.decide(READABLE)).toEqual({ kind: 'deny', reason: 'liveshare/read-only' })
    expect(host.snapshotted(READABLE)).toBe(false)
    // An empty selection is the record's absent field, which is what an upgraded share reads as none.
    expect(host.persisted()).not.toHaveProperty('viewerCapabilities')
    expect((await host.storedShares())[0]?.viewerCapabilities).toEqual([])
  })

  it('exposes a writable endpoint only where the share already allows writing', async () => {
    const host = await harness()
    await host.setCapabilities([{ plugin: PLUGIN, readable: [], writable: [WRITABLE] }])
    // The share allows writing but has no confined source layer here, so the policy refuses the write
    // with the same code its own write role uses rather than treating the selection as permission.
    expect(host.decide(WRITABLE)).toEqual({ kind: 'deny', reason: 'source-write-unavailable' })
    expect(host.snapshotted(WRITABLE)).toBe(false)
  })

  it('refuses an endpoint the plugin does not currently offer, naming it', async () => {
    const host = await harness()
    await expect(host.setCapabilities([{ plugin: PLUGIN, readable: ['mekGit/unknown'], writable: [] }]))
      .rejects.toMatchObject({
        code: 'liveshareShares/endpoint-not-offered',
        details: { plugin: PLUGIN, kind: 'readable', endpoint: 'mekGit/unknown' },
      })
    expect(host.decide(READABLE)).toEqual({ kind: 'deny', reason: 'liveshare/read-only' })
    expect(host.persisted()).not.toHaveProperty('viewerCapabilities')
  })

  it('refuses the other kind of the same endpoint, naming the kind it was submitted as', async () => {
    const host = await harness()
    await expect(host.setCapabilities([{ plugin: PLUGIN, readable: [WRITABLE], writable: [] }]))
      .rejects.toMatchObject({
        code: 'liveshareShares/endpoint-not-offered',
        details: { plugin: PLUGIN, kind: 'readable', endpoint: WRITABLE },
      })
    await expect(host.setCapabilities([{ plugin: PLUGIN, readable: [], writable: [READABLE] }]))
      .rejects.toMatchObject({
        code: 'liveshareShares/endpoint-not-offered',
        details: { plugin: PLUGIN, kind: 'writable', endpoint: READABLE },
      })
  })

  it('refuses a plugin the live offers do not name', async () => {
    const host = await harness()
    await expect(host.setCapabilities([{ plugin: 'ghost', readable: [READABLE], writable: [] }]))
      .rejects.toMatchObject({ code: 'liveshareShares/unknown-plugin', details: { plugin: 'ghost' } })
  })

  it.each([
    ['a value that is not an array', 'mekGit'],
    ['an entry that is not an object', ['mekGit']],
    ['a missing readable list', [{ plugin: PLUGIN, writable: [] }]],
    ['a non-string endpoint', [{ plugin: PLUGIN, readable: [7], writable: [] }]],
  ])('refuses %s without writing anything', async (_label, capabilities) => {
    const host = await harness()
    await expect(host.setCapabilities(capabilities))
      .rejects.toMatchObject({ code: 'liveshareShares/invalid-capabilities' })
    expect(host.persisted()).not.toHaveProperty('viewerCapabilities')
  })

  it('keeps the previous selection when a later submission is refused', async () => {
    const host = await harness()
    await host.setCapabilities([{ plugin: PLUGIN, readable: [READABLE], writable: [] }])
    await expect(host.setCapabilities([{ plugin: PLUGIN, readable: [READABLE, 'mekGit/unknown'], writable: [] }]))
      .rejects.toMatchObject({ code: 'liveshareShares/endpoint-not-offered' })
    expect(host.decide(READABLE)).toEqual({ kind: 'allow' })
    expect(host.persisted().viewerCapabilities).toEqual([{ plugin: PLUGIN, readable: [READABLE], writable: [] }])
  })

  it('refuses a share this host does not hold, and a request that names none', async () => {
    const host = await harness()
    await expect(host.setCapabilities([], 'missing'))
      .rejects.toMatchObject({ code: 'liveshareShares/share-not-found' })
    await expect(host.setCapabilities([]))
      .resolves.toEqual({ shareId: 'share', viewerCapabilities: [] })
    await expect(host.ctx.liveshareShares.setCapabilities({ shareId: '', capabilities: [] }))
      .rejects.toMatchObject({ code: 'liveshareShares/missing-share-id' })
  })
})

describe('viewer capability offers at boot', () => {
  it('offers what a plugin declares when it loads before the surface and before the share host', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'liveshare-boot-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'owner.json')
    writeFileSync(file, JSON.stringify({ instanceId: 'owner', shares: [] }))
    const routes: OwnerRoutes = new Map()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(TypertRegistry)
    ctx.typert.register(endpointContribution(PLUGIN, [READABLE, WRITABLE]))
    await ctx.plugin(RemoteAccessService)
    stubRelay()
    // The declaring plugin's own dependencies are already satisfied at boot, which is what lets it
    // apply before the share host's `connection` arrives.
    ctx.provide('llm', {} as never)

    // The declaring plugin mounts first, exactly as a profile whose bundle order puts it before the
    // liveshare bundle does, and it registers only once the surface exists.
    const plugin = mountDeclaringPlugin(ctx, DECLARER, PLUGIN, (pluginCtx) => {
      pluginCtx.inject(['liveshareViewerDeclarations'], (scope) => {
        viewerDeclarationsOf(scope)?.registerViewerReadable([READABLE])
        viewerDeclarationsOf(scope)?.registerViewerWritable([WRITABLE])
      })
    }, ['llm'])
    // The bundle's declaration entry needs nothing and provides the surface in its own load phase; the
    // share host entry next to it waits for `connection`.
    const provision = ctx.plugin(ViewerDeclarationsEntry)
    const host = ctx.plugin(Bundle, { ownerStateFile: file })
    await Promise.all([plugin, provision, host])
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // The surface exists while the share host's fiber is still pending on `connection`, and the offer
    // registered through it is already counted.
    expect(viewerDeclarationsOf(ctx)).toBeInstanceOf(ViewerDeclarations)
    expect(viewerDeclarationsOf(ctx)?.declaredCapabilities())
      .toEqual([{ plugin: PLUGIN, readable: [READABLE], writable: [WRITABLE] }])

    // The share host settles on its own schedule and serves the same offers through the owner API.
    ctx.provide('connection', connectionService(routes))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(ctx.liveshareShares.capabilities()).toEqual({
      capabilities: [{ plugin: PLUGIN, readable: [READABLE], writable: [WRITABLE] }],
    })
  })
})
