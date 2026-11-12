/**
 * The owner sign-in routes against the host state they share with the owner-state claim.
 *
 * A credential is this host's own sign-in and commits on every host. The passes that act for the
 * shares — the identity probe, the claim, and the offline re-registration — reach the holder's Relay
 * registrations, so a host that does not own the owner state runs none of them.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { OwnerAuthorizations } from '../src/host/owner-authorization.ts'
import { registerOwnerHttpRoutes } from '../src/host/owner-http-routes.ts'

const RELAY = 'https://relay.example.test/liveshare'
const CREDENTIAL = 'payload.signature'

/** One host's owner sign-in routes over stub worker passes. */
interface Harness {
  readonly call: (path: string, body: unknown) => Promise<Response>
  readonly tunnel: Record<keyof ReturnType<typeof stubTunnel>, ReturnType<typeof vi.fn>>
  readonly dispose: () => void
}

function stubTunnel(): {
  probeRelayCredentialSupport: (relay: string) => Promise<void>
  claimOwnedShares: (relay: string, credential: string | undefined) => Promise<{ claimed: number; skipped: number }>
  reregisterOfflineShares: (relay: string, credential: unknown) => void
  credentialForRelay: (relay: string, credential: unknown) => string | undefined
  ownerIdentityStatus: (relay: string, extra: object, credential: unknown) => object
  factsFor: (relay: string) => { supportsCredentials?: boolean; claim?: { claimed: number; skipped: number } }
} {
  return {
    probeRelayCredentialSupport: async () => {},
    claimOwnedShares: async () => ({ claimed: 1, skipped: 0 }),
    reregisterOfflineShares: () => {},
    credentialForRelay: () => CREDENTIAL,
    ownerIdentityStatus: (relay: string) => ({ state: 'verified', relay }),
    factsFor: () => ({}),
  }
}

/** Temporary directories this spec created, removed once every host is closed. */
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Build the routes over one stub worker.
 * @param ownerStateHeld Whether another running host owns the owner state.
 */
function harness(ownerStateHeld: boolean): Harness {
  const root = mkdtempSync(join(tmpdir(), 'liveshare-owner-http-'))
  roots.push(root)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const tunnel = Object.fromEntries(Object.entries(stubTunnel()).map(([name, value]) => [name, vi.fn(value)]))
  // These routes only register Fetch handlers, so the registry is the whole Connection this spec supplies.
  const ctx = new Context()
  ctx.provide('connection', {
    fetch: {
      register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route.fetch)
        return async () => {}
      },
    },
  })
  const connection = ctx.connection
  registerOwnerHttpRoutes({
    connection,
    tunnel: tunnel as never,
    captureOwnerOperation: () => ({
      relay: RELAY,
      relayRevision: 0,
      instanceKey: 'instance',
    }),
    ownerOperationCurrent: () => true,
    ownerAuthorizations: new OwnerAuthorizations(),
    ownerCredentialFile: join(root, 'owner-credential.json'),
    storedCredential: () => undefined,
    setStoredCredential: () => {},
    ownerStateHeld: () => ownerStateHeld,
    disposed: () => false,
  })
  return {
    tunnel: tunnel as Harness['tunnel'],
    dispose: () => {},
    call: (path, body) => routes.get(path)!(new Request(`http://owner.local${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })),
  }
}

describe('a credential imported by one host', () => {
  it('probes, claims, and re-registers when this host owns the owner state', async () => {
    const h = harness(false)
    const stored = await h.call('/api/liveshare.ownerCredential', { credential: CREDENTIAL })

    expect(stored.status).toBe(200)
    expect(h.tunnel.probeRelayCredentialSupport).toHaveBeenCalledWith(RELAY)
    expect(h.tunnel.claimOwnedShares).toHaveBeenCalledWith(RELAY, CREDENTIAL)
    expect(h.tunnel.reregisterOfflineShares).toHaveBeenCalledWith(RELAY, expect.objectContaining({ credential: CREDENTIAL }))
  })

  it('stores the credential without reaching the holder\'s Relay when another host owns the state', async () => {
    const h = harness(true)
    const stored = await h.call('/api/liveshare.ownerCredential', { credential: CREDENTIAL })

    // The sign-in is this host's own, so it commits and reports the identity it now holds.
    expect(stored.status).toBe(200)
    await expect(stored.json()).resolves.toMatchObject({ state: 'verified' })
    // Registering these shares would replace the registrations the holder is serving.
    expect(h.tunnel.probeRelayCredentialSupport).not.toHaveBeenCalled()
    expect(h.tunnel.claimOwnedShares).not.toHaveBeenCalled()
    expect(h.tunnel.reregisterOfflineShares).not.toHaveBeenCalled()
  })
})
