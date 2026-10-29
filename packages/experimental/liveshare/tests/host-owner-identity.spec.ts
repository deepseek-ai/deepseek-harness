/** Owner identity status is per Relay address: one address never reports another's facts. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'
import type { OwnerIdentityStatus as WireOwnerIdentityStatus } from '../src/share-api-types.ts'
import { identityRelayWith, writeOwnerState } from './owner-identity-fixture.ts'

interface OwnerRoutes {
  readonly routes: Map<string, (request: Request) => Promise<Response>>
  readonly host: Context
}

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

function ownerStateFile(relay: string): string {
  return writeOwnerState(join(mkdtempSync(join(tmpdir(), 'liveshare-identity-')), 'owner-shares.json'), relay)
}

async function identityOf(host: Context, relay: string): Promise<WireOwnerIdentityStatus> {
  return await host.liveshareShares.identity({ relay })
}

/** Credential payload fields the host decodes for display, in the Relay's own signed-payload shape. */
function credentialPayload(overrides: Record<string, unknown> = {}): string {
  const payload = {
    displayName: '许翰翔',
    subjectId: 'ou_owner',
    avatarUrl: 'https://cdn.example/owner.png',
    expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
    ...overrides,
  }
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.fixture-signature`
}

async function submitCredential(
  routes: OwnerRoutes['routes'],
  credential: string = credentialPayload(),
): Promise<void> {
  const route = routes.get('/api/liveshare.ownerCredential')
  expect(route).toBeDefined()
  const response = await route?.(new Request('http://owner.local/api/liveshare.ownerCredential', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  }))
  expect(response?.status).toBe(200)
}

describe('liveshare owner identity per relay', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close()
  })

  it('reports each address support on its own', async () => {
    const verified = await identityRelayWith()
    const otherRelay = await identityRelayWith()
    const unsupported = await identityRelayWith({ supported: false })
    closers.push(verified.close, otherRelay.close, unsupported.close)
    const { routes, host } = ownerRoutes()
    closers.push(await apply(host, {
      ownerStateFile: ownerStateFile(verified.relayUrl),
    } satisfies Config))

    await submitCredential(routes)
    const bound = await identityOf(host, verified.relayUrl)
    expect(bound).toMatchObject({ state: 'verified', relay: verified.relayUrl })
    expect(bound.claim).toEqual({ claimed: 0, skipped: 0 })
    // The avatar the credential carries reaches the page; a credential without one reports none.
    expect(bound.avatarUrl).toBe('https://cdn.example/owner.png')
    await submitCredential(routes, credentialPayload({ avatarUrl: undefined }))
    expect(await identityOf(host, verified.relayUrl)).not.toHaveProperty('avatarUrl')

    // Another address this host holds no credential for reports its own state, not the verified one.
    expect(await identityOf(host, otherRelay.relayUrl)).toMatchObject({
      state: 'unverified',
      relay: otherRelay.relayUrl,
    })

    // Support is per address too: one Relay that cannot bind identity does not mark the others.
    expect(await identityOf(host, unsupported.relayUrl)).toMatchObject({ state: 'relay-unsupported' })
    expect(await identityOf(host, verified.relayUrl)).toMatchObject({ state: 'verified' })
  })

  it('ignores a late probe answer from another address', async () => {
    const slowUnsupported = await identityRelayWith({ supported: false, probeDelayMs: 250 })
    const supported = await identityRelayWith()
    closers.push(slowUnsupported.close, supported.close)
    const { routes, host } = ownerRoutes()
    closers.push(await apply(host, {
      ownerStateFile: ownerStateFile(slowUnsupported.relayUrl),
    } satisfies Config))

    // The host is still waiting on the first address's answer while the second one answers its own.
    await submitCredential(routes)
    expect(await identityOf(host, supported.relayUrl)).toMatchObject({
      state: 'unverified',
      relay: supported.relayUrl,
    })
    await new Promise((resolve) => { setTimeout(resolve, 400) })
    // The late "unsupported" answer belongs to its own address and never reaches the other one.
    expect(await identityOf(host, supported.relayUrl)).not.toMatchObject({ state: 'relay-unsupported' })
    expect(await identityOf(host, slowUnsupported.relayUrl)).toMatchObject({ state: 'relay-unsupported' })
  })
})
