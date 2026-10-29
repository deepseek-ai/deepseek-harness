import { createServer, type AddressInfo } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import { apply, type Config } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'

interface GatewayUpgrade {
  readonly shareId: string
  readonly authorization: string | undefined
  readonly search: URLSearchParams
}

interface OwnerRoutes {
  readonly routes: Map<string, (request: Request) => Promise<Response>>
  readonly host: Context
}

/**
 * One owner host whose Cordis service lookups are the test's own fakes.
 * @param services - Services the host reads through `ctx.get`, keyed by service name.
 * @returns The registered routes and the host context.
 */
function ownerRoutes(services: Record<string, unknown> = {}): OwnerRoutes {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const context = new Context()
  // Provide the fakes on the real Context: the host reads them through `ctx.get` and registers its
  // projections with `ctx.inject`, both of which read this service store.
  for (const [name, service] of Object.entries(services)) context.provide(name, service as never)
  const host = Object.assign(context, {
    connection: {
      fetch: {
        register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
          routes.set(route.path, route.fetch)
          return Promise.resolve(async () => {})
        },
      },
    },
  })
  return { routes, host }
}

/** Temporary state directories this spec created, removed once every host is stopped. */
const temporaryRoots: string[] = []

function ownerStateFile(relayUrl: string, shares: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'liveshare-restore-'))
  temporaryRoots.push(dir)
  const file = join(dir, 'owner-shares.json')
  writeFileSync(file, JSON.stringify({
    relayUrl,
    shares: shares.map(share => ({ relay: relayUrl, ...(share as Record<string, unknown>) })),
  }))
  return file
}

/** One stored record; the fields under test are the ones a build may or may not have written. */
function storedRecord(shareId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    shareId,
    sessionId: `session-${shareId}`,
    sessionTitle: shareId,
    accessMode: 'open',
    gatewayToken: `token-${shareId}`,
    allowedSubjectIds: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  }
}

/**
 * One live agent for a running Session, shaped the way the host reads it.
 *
 * The Session carries the header every real one has, because the host reads the working directory out of
 * it while installing a layer: a live agent whose Session had no header would fail there rather than
 * reach the decision under test.
 * @param sessionId - Session the agent drives.
 * @param cancel - Cancellation the host is expected to request.
 * @returns The agent as the `agents` service hands it out.
 */
function liveAgent(sessionId: string, cancel: (cause: unknown, options?: unknown) => void): Record<string, unknown> {
  return {
    status: 'running',
    session: { id: sessionId, header: { cwd: '/tmp' } },
    cancel,
  }
}

async function closedPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
  return port
}

describe('liveshare owner host', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    // Stop the owner host before the fake Relay: closing the server waits for open gateway sockets.
    for (const close of closers.splice(0).reverse()) await close()
    // Then remove only the state directories this spec made, once nothing it started is still writing.
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('loads a record with its own tier and fork switch', async () => {
    const upgrades: GatewayUpgrade[] = []
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => { relay.once('listening', resolve) })
    relay.on('connection', (_socket, request) => {
      const url = new URL(request.url ?? '/', 'http://relay.local')
      upgrades.push({
        shareId: url.searchParams.get('shareId') ?? '',
        authorization: request.headers.authorization,
        search: url.searchParams,
      })
    })
    closers.push(async () => {
      await new Promise<void>((resolve) => { relay.close(() => { resolve() }) })
    })
    const port = (relay.address() as AddressInfo).port

    const { host } = ownerRoutes()
    const dispose = await apply(host, {      ownerStateFile: ownerStateFile(`http://127.0.0.1:${String(port)}`, [
      // Records a build before tiers wrote: the stored switch is the record's own fork decision.
      storedRecord('legacy-fork', { allowsFork: true }),
      storedRecord('legacy-view', { allowsFork: false }),
      storedRecord('legacy-none', {}),

      storedRecord('explicit-write', { sessionMode: 'write', allowsFork: true }),
      // A record that states a tier and a switch that disagree about forking is not contradictory any
      // more: the tier says nothing about forking, so both facts stand.
      storedRecord('view-with-fork', { sessionMode: 'view', allowsFork: true }),
    ]),
    } satisfies Config)
    closers.push(dispose)

    await expect.poll(() => upgrades.length, { timeout: 15_000 }).toBe(5)
    const modeOf = (shareId: string): string | null | undefined =>
      upgrades.find(upgrade => upgrade.shareId === shareId)?.search.get('sessionMode')
    // The tunnel serializes the flag as a query parameter, so "no flag" and a false flag read the same.
    const forkOf = (shareId: string): boolean => {
      const value = upgrades.find(upgrade => upgrade.shareId === shareId)?.search.get('allowsFork')
      return value === '1' || value === 'true'
    }

    expect(modeOf('legacy-fork')).toBe('view')
    expect(forkOf('legacy-fork')).toBe(true)
    expect(modeOf('legacy-view')).toBe('view')
    expect(forkOf('legacy-view')).toBe(false)
    expect(modeOf('legacy-none')).toBe('view')
    expect(forkOf('legacy-none')).toBe(false)
    expect(modeOf('explicit-write')).toBe('write')
    expect(forkOf('explicit-write')).toBe(true)
    expect(modeOf('view-with-fork')).toBe('view')
    expect(forkOf('view-with-fork')).toBe(true)
  }, 20_000)

  it('ignores an attachment-upload switch left in an older owner state file', async () => {
    const upgrades: GatewayUpgrade[] = []
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => { relay.once('listening', resolve) })
    relay.on('connection', (_socket, request) => {
      upgrades.push({
        shareId: new URL(request.url ?? '/', 'http://relay.local').searchParams.get('shareId') ?? '',
        authorization: request.headers.authorization,
        search: new URL(request.url ?? '/', 'http://relay.local').searchParams,
      })
    })
    closers.push(async () => {
      await new Promise<void>((resolve) => { relay.close(() => { resolve() }) })
    })
    const port = (relay.address() as AddressInfo).port
    const { host } = ownerRoutes()
    closers.push(await apply(host, {      ownerStateFile: ownerStateFile(`http://127.0.0.1:${String(port)}`, [
      // A build before the switch retired wrote the field; a value no build wrote must not fail the load.
      storedRecord('legacy-upload', { allowsFileUpload: true }),
      storedRecord('malformed-upload', { allowsFileUpload: 'yes' }),
    ]),
    } satisfies Config))

    await expect.poll(() => upgrades.length, { timeout: 15_000 }).toBe(2)
    // The retired switch is not read back: both records load and no registration states it.
    for (const shareId of ['legacy-upload', 'malformed-upload']) {
      const upgrade = upgrades.find(candidate => candidate.shareId === shareId)
      expect(upgrade?.search.get('allowsFileUpload'), shareId).toBeNull()
      expect(upgrade?.search.get('sessionMode'), shareId).toBe('view')
    }
  }, 20_000)

  it('keeps every combination of a tier and a fork switch, and rejects only a tier it cannot read', async () => {
    // The tier says nothing about forking and the switch nothing about the tier, so every combination is
    // a record the owner could have meant. A tier no build ever wrote is still refused, and the whole
    // file is rejected rather than partially loaded, so a later save cannot drop the record.
    const file = ownerStateFile('http://127.0.0.1:1', [
      storedRecord('view-with-fork', { sessionMode: 'view', allowsFork: true }),
      storedRecord('write-without-fork', { sessionMode: 'write', allowsFork: false }),
      storedRecord('future', { sessionMode: 'admin', allowsFork: true }),
    ])
    const before = readFileSync(file, 'utf8')
    const { host } = ownerRoutes()

    await expect(apply(host, {
      ownerStateFile: file,
    } satisfies Config)).rejects.toThrow(/invalid owner state file/u)

    // Every record is still on disk, byte for byte, and a later save never had a host to run from.
    expect(readFileSync(file, 'utf8')).toBe(before)
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { shares: readonly unknown[] }
    expect(persisted.shares).toHaveLength(3)
  })

  it('restores persisted shares with their expiry and token', async () => {
    const upgrades: GatewayUpgrade[] = []
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => { relay.once('listening', resolve) })
    relay.on('connection', (_socket, request) => {
      const url = new URL(request.url ?? '/', 'http://relay.local')
      upgrades.push({
        shareId: url.searchParams.get('shareId') ?? '',
        authorization: request.headers.authorization,
        search: url.searchParams,
      })
    })
    closers.push(async () => {
      await new Promise<void>((resolve) => { relay.close(() => { resolve() }) })
    })
    const port = (relay.address() as AddressInfo).port

    const { host } = ownerRoutes()
    const dispose = await apply(host, {      ownerStateFile: ownerStateFile(`http://127.0.0.1:${String(port)}`, [
      {
        shareId: 'share-expiring',
        sessionId: 'session-expiring',
        sessionTitle: 'Expiring',
        accessMode: 'open',
        gatewayToken: 'token-expiring',
        allowedSubjectIds: [],
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-09-10T00:00:00.000Z',
      },
      {
        shareId: 'share-permanent',
        sessionId: 'session-permanent',
        sessionTitle: 'Permanent',
        accessMode: 'open',
        gatewayToken: 'token-permanent',
        allowedSubjectIds: [],
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]),
    } satisfies Config)
    closers.push(dispose)

    await expect.poll(() => upgrades.length, { timeout: 15_000 }).toBe(2)
    const expiring = upgrades.find(upgrade => upgrade.shareId === 'share-expiring')
    const permanent = upgrades.find(upgrade => upgrade.shareId === 'share-permanent')
    expect(expiring?.search.get('expiresAt')).toBe('2026-09-10T00:00:00.000Z')
    expect(expiring?.authorization).toBe('Bearer token-expiring')
    expect(permanent?.search.get('expiresAt')).toBe(null)
    expect(permanent?.authorization).toBe('Bearer token-permanent')
  }, 20_000)

  it('cancels the running source turn of a share whose deadline passes', async () => {
    const cancel = vi.fn()
    // What a running source Session looks like to the host: a live agent the deadline stops.
    const { host } = ownerRoutes({
      agents: { get: () => liveAgent('session-expiring', cancel) },
    })
    const dispose = await apply(host, {      ownerStateFile: ownerStateFile(`http://127.0.0.1:${String(await closedPort())}`, [
      // The share is one a viewer could already be driving: a stored write share, not the view a record
      // without a mode loads as. Its deadline is what ends that grant.
      storedRecord('expiring', {
        sessionMode: 'write',
        allowsFork: true,
        expiresAt: new Date(Date.now() + 150).toISOString(),
      }),
    ]),
    } satisfies Config)
    closers.push(dispose)

    // The deadline the record carried is what the host waits for: the turn is stopped with the owner's own
    // cancellation, not left to reach its end by itself.
    await expect.poll(() => cancel.mock.calls.length, { timeout: 5_000 }).toBe(1)
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  }, 20_000)

  it('stops the running turn when the Relay stops admitting a viewer', async () => {
    const cancel = vi.fn()
    // A Relay whose committed snapshot the owner host re-reads through the management route. The first
    // answer admits the viewer; the second narrows the share so that viewer is no longer admitted.
    let authority: Record<string, unknown> = {
      version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'write',
    }
    const relay = createHttpServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(request.url?.includes('owner-credential') === true
        ? { supported: true }
        : authority))
    })
    await new Promise<void>((resolve) => { relay.listen(0, '127.0.0.1', resolve) })
    closers.push(async () => { await new Promise<void>((resolve) => { relay.close(() => { resolve() }) }) })
    const port = (relay.address() as AddressInfo).port
    const { host } = ownerRoutes({
      agents: { get: () => liveAgent('session-1', cancel) },
    })
    const dispose = await apply(host, {
      ownerIdentity: { providerId: 'mock', tenantId: 'tenant-a', subjectId: 'owner', displayName: 'Owner' },
      ownerStateFile: ownerStateFile(`http://127.0.0.1:${String(port)}`,
        [storedRecord('share-1', { sessionMode: 'write', allowsFork: true })]),
    } satisfies Config)
    closers.push(dispose)

    await expect(host.liveshareShares.list()).resolves.toMatchObject({
      shares: [expect.objectContaining({ shareId: 'share-1' })],
    })
    // The first snapshot states access this host already held, so nothing is cancelled.
    expect(cancel).not.toHaveBeenCalled()

    // The Relay narrows the share to a stored allowlist that does not name this viewer: the host cannot
    // attribute the running turn, so it stops the turn the Session is running now.
    authority = { version: 2, accessMode: 'selected', allowedSubjectIds: [], sessionMode: 'write' }
    await host.liveshareShares.list()
    await expect.poll(() => cancel.mock.calls.length, { timeout: 5_000 }).toBe(1)
    expect(cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
  }, 20_000)

  it('registers no route for the retired approval flow', async () => {
    const { routes, host } = ownerRoutes()
    const dispose = await apply(host, {      ownerStateFile: ownerStateFile(`http://127.0.0.1:${String(await closedPort())}`, []),
    } satisfies Config)
    closers.push(dispose)

    for (const gone of ['/api/liveshare.requests', '/api/liveshare.grantView', '/api/liveshare.revokeView']) {
      expect(routes.get(gone), gone).toBeUndefined()
    }
  }, 20_000)

  it('keeps what an unreachable Relay could not take, and refuses what only the Relay can', async () => {
    const { host } = ownerRoutes()
    const nativeFetch = globalThis.fetch
    let reachable = false
    const deletions: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (!new URL(request.url).hostname.startsWith('127.0.0.1')) return nativeFetch(input, init)
      if (!reachable) throw new Error('fixture Relay unavailable')
      deletions.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`)
      return Response.json({})
    })
    closers.push(async () => { vi.unstubAllGlobals() })
    const port = await closedPort()
    const stateFile = ownerStateFile(`http://127.0.0.1:${String(port)}`, [{
      shareId: 'share-1',
      sessionId: 'session-1',
      sessionTitle: 'Session',
      accessMode: 'open',
      gatewayToken: 'token-1',
      allowedSubjectIds: [],
      createdAt: '2026-09-01T00:00:00.000Z',
    }])
    const dispose = await apply(host, {
      ownerStateFile: stateFile,
    } satisfies Config)
    closers.push(dispose)

    // The Remote carries the request as a value, so there is no body to parse: an empty id names a
    // share this host does not hold.
    await expect(host.liveshareShares.stop({ shareId: '' }))
      .rejects.toMatchObject({ code: 'liveshareShares/share-not-found' })

    // Stopping a share is the owner's own decision, so an unreachable Relay cannot hold it open: the
    // host drops the share here and reports the Relay row it could not delete.
    await expect(host.liveshareShares.stop({ shareId: 'share-1' }))
      .resolves.toEqual({ ok: true, relay: 'unreachable' })
    await expect(host.liveshareShares.stop({ shareId: 'share-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/share-not-found' })

    // The row the Relay never deleted is kept with the token that deletes it, so the owner's stop is
    // not lost with the connection that could not deliver it.
    const pending = (): unknown => (JSON.parse(readFileSync(stateFile, 'utf8')) as { pendingRemovals?: unknown }).pendingRemovals
    expect(pending()).toEqual([{
      relay: `http://127.0.0.1:${String(port)}`,
      shareId: 'share-1',
      gatewayToken: 'token-1',
    }])

    // The Relay comes back on that address: the next owner request delivers the deletion it owes and
    // drops the record, so the Relay learns of the stop without waiting for the row to expire.
    reachable = true

    await host.liveshareShares.list()
    await vi.waitFor(() => {
      expect(deletions).toContain('DELETE /__liveshare/share?shareId=share-1')
    })
    await vi.waitFor(() => { expect(pending()).toBeUndefined() })
  })

  it('re-registers a share stored with the withdrawn mode as selected', async () => {
    const upgrades: GatewayUpgrade[] = []
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => { relay.once('listening', resolve) })
    relay.on('connection', (_socket, request) => {
      const url = new URL(request.url ?? '/', 'http://relay.local')
      upgrades.push({
        shareId: url.searchParams.get('shareId') ?? '',
        authorization: request.headers.authorization,
        search: url.searchParams,
      })
    })
    closers.push(async () => {
      await new Promise<void>((resolve) => { relay.close(() => { resolve() }) })
    })
    const port = (relay.address() as AddressInfo).port

    const { host } = ownerRoutes()
    const dispose = await apply(host, {      ownerStateFile: ownerStateFile(`http://127.0.0.1:${String(port)}`, [{
      shareId: 'share-withdrawn',
      sessionId: 'session-withdrawn',
      sessionTitle: 'Withdrawn',
      accessMode: 'selected',
      gatewayToken: 'token-withdrawn',
      allowedSubjectIds: ['mock:acceptance-tenant:viewer'],
      createdAt: '2026-09-01T00:00:00.000Z',
    }]),
    } satisfies Config)
    closers.push(dispose)

    await expect.poll(() => upgrades.length, { timeout: 15_000 }).toBe(1)
    const upgrade = upgrades[0]
    expect(upgrade?.search.get('accessMode')).toBe('selected')
    // The stored ACL travels with the revived registration, so the mode change never widens it.
    expect(upgrade?.search.getAll('allowedSubjectId')).toEqual(['mock:acceptance-tenant:viewer'])
  }, 20_000)
})
