/**
 * What a share this host already holds presents when it reconnects, and how it comes back.
 *
 * The owner's design is that a restart or a reconnect restores every link the host still holds,
 * whatever the state of the owner's sign-in, and that the sign-in decides only whether a *new* share
 * may be published. Two host decisions carry that: a restore registers on the share's own management
 * token and hands the Relay the credential this host stores for that address rather than withholding
 * it on the host's own expiry read, and a credential that becomes usable again registers the shares a
 * refusal left offline instead of waiting for a restart.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'

const SHARE_ID = 'restored-share'
const SESSION_ID = 'restored-session'
/** Management token the share's own record carries, which is what a reconnect is authorized by. */
const GATEWAY_TOKEN = 'restored-gateway-token'
/** Credential the host stores for the address; its own `expiresAt` read says it is past. */
const STORED_TOKEN = 'stored-payload.stored-signature'
/** Credential a completed verification stores, which is the one the Relay then accepts. */
const RENEWED_TOKEN = 'renewed-payload.renewed-signature'
const PAST = new Date(Date.parse('2026-01-01T00:00:00.000Z')).toISOString()

/** One gateway upgrade the stand-in received, with the headers the owner's worker sent. */
interface GatewayUpgrade {
  readonly shareId: string
  readonly authorization: string | undefined
  readonly credential: string | undefined
  readonly search: URLSearchParams
}

interface RelayStandIn {
  readonly origin: string
  readonly upgrades: GatewayUpgrade[]
  readonly close: () => Promise<void>
}

interface OwnerRoutes {
  readonly routes: Map<string, (request: Request) => Promise<Response>>
  readonly host: Context
}

/** Temporary state directories this spec created, removed once every host is stopped. */
const temporaryRoots: string[] = []
/** Owner hosts this spec started, stopped before their Relay so no socket outlives the fixture. */
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * One owner host whose Cordis service lookups are the test's own fakes.
 * @returns The registered owner routes and the host context.
 */
function ownerRoutes(): OwnerRoutes {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const host = Object.assign(new Context(), {
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

/** A temporary state directory holding the owner's state file and the credential beside it. */
function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-restore-credential-'))
  temporaryRoots.push(directory)
  return directory
}

/** One stored share record, with the management token a reconnect presents. */
function ownerStateFile(directory: string, relay: string): string {
  const file = join(directory, 'owner-shares.json')
  writeFileSync(file, JSON.stringify({
    instanceId: 'restore-credential-instance',
    relayUrl: relay,
    shares: [{
      relay,
      shareId: SHARE_ID,
      sessionId: SESSION_ID,
      sessionTitle: 'Restored session',
      accessMode: 'open',
      gatewayToken: GATEWAY_TOKEN,
      allowedSubjectIds: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      sessionMode: 'view',
    }],
  }))
  return file
}

/** One stored credential whose own signed expiry this host reads as past. */
function expiredCredentialFile(directory: string, relay: string): string {
  const file = join(directory, 'owner-credential.json')
  writeFileSync(file, JSON.stringify({ relay, credential: STORED_TOKEN, expiresAt: PAST, subjectId: 'owner' }))
  return file
}

/**
 * Start a Relay stand-in that speaks the two HTTP routes the host asks and one gateway upgrade.
 *
 * The upgrade is accepted only when `accepts` says so, and a refusal is answered with the HTTP status
 * the real Relay uses for a first publish it will not admit — the same answer the owner's gateway
 * worker treats as a decision about that registration rather than as a transient failure.
 * @param accepts Whether the credential one upgrade presented is admitted.
 * @returns The stand-in origin, every upgrade it saw, and its disposer.
 */
async function relayStandIn(accepts: (credential: string | undefined) => boolean): Promise<RelayStandIn> {
  const upgrades: GatewayUpgrade[] = []
  const wss = new WebSocketServer({ noServer: true })
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://relay.local').pathname
    if (path === '/__liveshare/share/claim') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ shareId: SHARE_ID, ownerVerified: true, claimed: true }))
      return
    }
    if (path === '/__liveshare/owner-credential') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ supported: true }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not-found"}')
  })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    const header = request.headers['x-liveshare-owner-credential']
    const credential = Array.isArray(header) ? header[0] : header
    upgrades.push({
      shareId: url.searchParams.get('shareId') ?? '',
      authorization: request.headers.authorization,
      credential,
      search: url.searchParams,
    })
    if (!accepts(credential)) {
      const body = 'owner credential required'
      socket.end([
        'HTTP/1.1 401 Unauthorized',
        'content-type: text/plain; charset=utf-8',
        `content-length: ${String(Buffer.byteLength(body))}`,
        'connection: close',
        '',
        body,
      ].join('\r\n'))
      return
    }
    wss.handleUpgrade(request, socket, head, (gateway) => { wss.emit('connection', gateway, request) })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    upgrades,
    close: async () => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/** The owner's own list of shares, as its management page reads it. */
async function listedShares(host: Context): Promise<readonly { shareId: string; online: boolean }[]> {
  return (await host.liveshareShares.list()).shares
}

/** The credential state this host reports for one Relay address. */
async function identityState(host: Context, relay: string): Promise<string> {
  return (await host.liveshareShares.identity({ relay })).state
}

describe('restoring a share with a credential this host reads as expired', () => {
  it('registers on the share management token, presents the stored credential, and comes online', async () => {
    const relay = await relayStandIn(() => true)
    const directory = stateDirectory()
    const { host } = ownerRoutes()
    const dispose = await apply(host, {
      ownerStateFile: ownerStateFile(directory, relay.origin),
      ownerCredentialFile: expiredCredentialFile(directory, relay.origin),
    } satisfies Config)
    disposers.push(async () => { await dispose(); await relay.close() })

    await expect.poll(() => relay.upgrades.length, { timeout: 20_000 }).toBe(1)
    expect(relay.upgrades[0]).toMatchObject({
      shareId: SHARE_ID,
      // The share's own management token is what authorizes this registration; the credential is
      // what the Relay judges the owner's sign-in by, and both travel together.
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      credential: STORED_TOKEN,
    })
    // The host's own read of the sign-in says it is past, which is what used to withhold the header.
    expect(await identityState(host, relay.origin)).toBe('expired')
    await expect.poll(async () => (await listedShares(host))[0]?.online, { timeout: 15_000 }).toBe(true)
  }, 30_000)

  it('keeps a refused share and registers it again once a credential arrives', async () => {
    const relay = await relayStandIn(credential => credential === RENEWED_TOKEN)
    const directory = stateDirectory()
    const stateFile = ownerStateFile(directory, relay.origin)
    const { routes, host } = ownerRoutes()
    const dispose = await apply(host, {
      ownerStateFile: stateFile,
      // No credential for this address yet: the first registration is one the Relay must refuse.
      ownerCredentialFile: join(directory, 'owner-credential.json'),
    } satisfies Config)
    disposers.push(async () => { await dispose(); await relay.close() })

    await expect.poll(() => relay.upgrades.length, { timeout: 20_000 }).toBe(1)
    expect(relay.upgrades[0]?.credential).toBeUndefined()
    // A refusal is a decision about this registration, so the worker does not retry it by itself:
    // the settle covers several of its reconnect delays, in which a retry would have appeared.
    await expect.poll(
      async () => (await listedShares(host))[0]?.online,
      { timeout: 15_000 },
    ).toBe(false)
    await new Promise((resolve) => { setTimeout(resolve, 1_500) })
    expect(relay.upgrades).toHaveLength(1)
    // The refused share is remembered: the owner still sees it, and its record is still on disk.
    expect((await listedShares(host)).map(share => share.shareId)).toEqual([SHARE_ID])
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as { shares: readonly { shareId: string }[] }
    expect(persisted.shares.map(share => share.shareId)).toEqual([SHARE_ID])

    // The owner verifies at this address. The host stores the credential and must register the share
    // it refused again, without the owner restarting anything.
    const imported = await routes.get('/api/liveshare.ownerCredential')?.(new Request(
      'http://owner.local/api/liveshare.ownerCredential',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: RENEWED_TOKEN }),
      },
    ))
    expect(imported?.status).toBe(200)

    await expect.poll(() => relay.upgrades.length, { timeout: 20_000 }).toBe(2)
    expect(relay.upgrades[1]).toMatchObject({
      shareId: SHARE_ID,
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      credential: RENEWED_TOKEN,
    })
    await expect.poll(async () => (await listedShares(host))[0]?.online, { timeout: 15_000 }).toBe(true)
  }, 40_000)
})
