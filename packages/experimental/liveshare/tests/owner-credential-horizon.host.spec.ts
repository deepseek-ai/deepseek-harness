/**
 * The owner host follows the Relay's live horizon for its published credential.
 *
 * A credential carries the expiry the Relay signed into it. The login behind that credential can be
 * renewed past that instant, and the owner host is the only party that cannot tell on its own, so a
 * Relay answer carrying the horizon that applies is what keeps the status page and the publish path
 * from reporting a usable credential as expired. An answer without one changes nothing.
 */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import type {} from '../src/index.ts'
import { apply } from '../src/host/share-host.ts'

const START = Date.parse('2026-10-15T00:00:00.000Z')
const PAST = new Date(START).toISOString()
const LIVE = new Date(START + 30 * 24 * 60 * 60_000).toISOString()
const STORED_TOKEN = 'stored-payload.stored-signature'

/**
 * Read the horizon a stored owner credential file records.
 * @param file - Credential file the fixture wrote.
 * @returns The `expiresAt` the file carries, or undefined when it names none.
 */
function storedHorizon(file: string): unknown {
  return (JSON.parse(readFileSync(file, 'utf8')) as { expiresAt?: unknown }).expiresAt
}

/** One route's fixed answer: a status to refuse with, or a JSON body to answer with. */
type Answer = { readonly status: number } | { readonly body: Record<string, unknown> }

interface RelayStandIn {
  readonly relayUrl: string
  readonly claims: Array<{ readonly url: URL; readonly credential: string | undefined }>
  readonly close: () => Promise<void>
}

function answer(res: import('node:http').ServerResponse, reply: Answer): void {
  if ('status' in reply) {
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end('{"error":"owner-credential-required"}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(reply.body))
}

/**
 * Start a Relay stand-in answering one share's claim and the capability probe.
 * @param options Claim answer, and probe answer when it differs from a plain support report.
 * @returns Fixture origin, recorded claims, and its disposer.
 */
async function relayStandIn(options: {
  readonly claim: Answer
  readonly probe?: Answer
}): Promise<RelayStandIn> {
  const claims: RelayStandIn['claims'] = []
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/__liveshare/share/claim') === true) {
      claims.push({
        url: new URL(req.url, 'http://relay.local'),
        credential: req.headers['x-liveshare-owner-credential'] as string | undefined,
      })
      answer(res, options.claim)
      return
    }
    if (req.url?.startsWith('/__liveshare/owner-credential') === true) {
      answer(res, options.probe ?? { body: { supported: true } })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not-found"}')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    relayUrl: `http://127.0.0.1:${String(port)}`,
    claims,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
  }
}

interface HostFixture {
  readonly ownerCredentialFile: string
  readonly identity: () => Promise<{ readonly state: string; readonly expiresAt?: string }>
  readonly stop: () => Promise<void>
}

async function host(options: {
  readonly relayUrl: string
  readonly expiresAt: string
  readonly shares: boolean
}): Promise<HostFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'liveshare-owner-horizon-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const ownerStateFile = join(directory, 'owner-shares.json')
  const ownerCredentialFile = join(directory, 'owner-credential.json')
  writeFileSync(ownerStateFile, JSON.stringify({
    instanceId: 'instance-1',
    relayUrl: options.relayUrl,
    shares: options.shares
      ? [{
        shareId: 'share-1',
        relay: options.relayUrl,
        sessionId: 'session',
        sessionTitle: 'Session',
        accessMode: 'open',
        gatewayToken: 'claim-token',
        allowedSubjectIds: [],
        createdAt: '2026-10-08T00:00:00Z',
        sessionMode: 'view',
      }]
      : [],
  }))
  writeFileSync(ownerCredentialFile, JSON.stringify({
    relay: options.relayUrl,
    credential: STORED_TOKEN,
    expiresAt: options.expiresAt,
    subjectId: 'owner',
  }, null, 2))
  const ctx = new Context()
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  Object.assign(ctx, {
    connection: {
      fetch: {
        register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
          routes.set(route.path, route.fetch)
          return async () => { routes.delete(route.path) }
        },
      },
    },
  })
  const stop = await apply(ctx, { ownerStateFile, ownerCredentialFile })
  onTestFinished(async () => { await stop(); await ctx.fiber.dispose() })
  return {
    ownerCredentialFile,
    identity: async () => {
      const status = await ctx.liveshareShares.identity({})
      return status
    },
    stop,
  }
}

describe('owner host credential horizon', () => {
  it('adopts the horizon the Relay reports for a claim past the signed expiry', async () => {
    const relay = await relayStandIn({ claim: { body: { claimed: true, ownerCredentialExpiresAt: LIVE } } })
    onTestFinished(relay.close)
    const fixture = await host({ relayUrl: relay.relayUrl, expiresAt: PAST, shares: true })

    await expect.poll(async () => (await fixture.identity()).state).toBe('verified')
    expect(await fixture.identity()).toMatchObject({ state: 'verified', expiresAt: LIVE })
    // The host presented the token it held even though its own expiry read had passed: the Relay is
    // the only party that can say whether the login behind it is still renewed.
    expect(relay.claims[0]?.credential).toBe(STORED_TOKEN)
    expect(JSON.parse(readFileSync(fixture.ownerCredentialFile, 'utf8'))).toEqual({
      relay: relay.relayUrl,
      credential: STORED_TOKEN,
      expiresAt: LIVE,
      subjectId: 'owner',
    })
  })

  it('adopts the horizon the capability probe reports when no share reaches a claim', async () => {
    const relay = await relayStandIn({
      claim: { body: { claimed: true } },
      probe: { body: { supported: true, ownerCredentialExpiresAt: LIVE } },
    })
    onTestFinished(relay.close)
    const fixture = await host({ relayUrl: relay.relayUrl, expiresAt: PAST, shares: false })

    await expect.poll(async () => (await fixture.identity()).state).toBe('verified')
    expect(relay.claims).toEqual([])
    expect(storedHorizon(fixture.ownerCredentialFile)).toBe(LIVE)
  })

  it('leaves the signed expiry in place when the Relay reports no horizon', async () => {
    const relay = await relayStandIn({ claim: { body: { claimed: true } } })
    onTestFinished(relay.close)
    const fixture = await host({ relayUrl: relay.relayUrl, expiresAt: PAST, shares: true })
    await expect.poll(() => relay.claims.length).toBe(1)
    await fixture.stop()

    expect(await fixture.identity()).toMatchObject({ state: 'expired', expiresAt: PAST })
    expect(storedHorizon(fixture.ownerCredentialFile)).toBe(PAST)
  })

  it('keeps a credential the Relay refuses expired', async () => {
    const relay = await relayStandIn({ claim: { status: 401 } })
    onTestFinished(relay.close)
    const fixture = await host({ relayUrl: relay.relayUrl, expiresAt: PAST, shares: true })
    await expect.poll(() => relay.claims.length).toBe(1)
    await fixture.stop()

    expect(await fixture.identity()).toMatchObject({ state: 'expired', expiresAt: PAST })
    expect(storedHorizon(fixture.ownerCredentialFile)).toBe(PAST)
  })

  it('adopts a shorter horizon, so a Relay that stopped renewing is not reported as usable', async () => {
    const relay = await relayStandIn({ claim: { body: { claimed: true, ownerCredentialExpiresAt: PAST } } })
    onTestFinished(relay.close)
    const fixture = await host({ relayUrl: relay.relayUrl, expiresAt: LIVE, shares: true })

    await expect.poll(async () => (await fixture.identity()).state).toBe('expired')
    expect(storedHorizon(fixture.ownerCredentialFile)).toBe(PAST)
  })
})
