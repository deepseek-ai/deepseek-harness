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
  readonly call: (path: string, body: unknown, origin?: string) => Promise<Response>
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

/**
 * Read the address a stubbed Relay fetch was asked for.
 * @param input - The fetch input the routes passed.
 * @returns The absolute address as a string.
 */
function relayRequestUrl(input: URL | Request | undefined): string {
  if (input instanceof URL) return input.href
  return input === undefined ? '' : input.url
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
function harness(ownerStateHeld: boolean, options: {
  readonly facts?: { supportsCredentials?: boolean }
  readonly relayFetch?: (input: URL | Request, init?: RequestInit) => Promise<Response>
  /** Whether the operation captured at the start of a request is still current when it is re-checked. */
  readonly ownerOperationCurrent?: () => boolean
  /** Host instance each captured operation names. */
  readonly instanceKey?: () => string
  /** Relay address each captured operation names; the default is the one saved address. */
  readonly relay?: () => string | undefined
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'liveshare-owner-http-'))
  roots.push(root)
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const tunnel = Object.fromEntries(Object.entries(stubTunnel()).map(([name, value]) => [name, vi.fn(value)]))
  tunnel.factsFor = vi.fn(() => options.facts ?? {})
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
    ...(options.relayFetch === undefined ? {} : { relayFetch: options.relayFetch as never }),
    tunnel: tunnel as never,
    captureOwnerOperation: () => ({
      relay: options.relay === undefined ? RELAY : options.relay(),
      relayRevision: 0,
      instanceKey: options.instanceKey?.() ?? 'instance',
    }),
    ownerOperationCurrent: options.ownerOperationCurrent ?? (() => true),
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
    call: (path, body, origin) => routes.get(path)!(new Request(`http://owner.local${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin === undefined ? {} : { origin }),
      },
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

describe('a sign-in the Relay holds for this host', () => {
  const PAGE = 'https://dsh.example.test'
  /** The start route's answer fields this group reads. */
  type Started = { readonly state: string; readonly authorizeUrl: string }
  const start = async (h: Harness, origin?: string): Promise<Started> =>
    await (await h.call('/api/liveshare.ownerLoginStart', {}, origin)).json() as Started
  const status = async (h: Harness, state: string, origin?: string): Promise<unknown> =>
    await (await h.call('/api/liveshare.ownerLoginStatus', { state }, origin)).json()
  const verified = { status: 'verified', identity: { state: 'verified', relay: RELAY } }

  it('collects the code from the Relay once it is issued and exchanges it', async () => {
    const relayFetch = vi.fn<(input: URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ status: 'pending' }))
      .mockResolvedValueOnce(Response.json({ status: 'issued', code: 'one-time-code' }))
      .mockResolvedValueOnce(Response.json({ credential: CREDENTIAL }, { status: 200 }))
    const h = harness(false, { relayFetch })
    const started = await start(h, PAGE)
    expect(new URL(started.authorizeUrl).searchParams.get('mode')).toBe('poll')

    await expect(status(h, started.state, PAGE)).resolves.toEqual({ status: 'pending' })
    await expect(status(h, started.state, PAGE)).resolves.toEqual(verified)
    const [pollUrl, pollInit] = relayFetch.mock.calls[1] ?? []
    expect(relayRequestUrl(pollUrl)).toBe(`${RELAY}/__liveshare/owner-login-poll`)
    expect(JSON.parse(await new Response(pollInit?.body).text())).toEqual({ state: started.state, instanceKey: 'instance' })
    const [exchangeUrl, exchangeInit] = relayFetch.mock.calls[2] ?? []
    expect(relayRequestUrl(exchangeUrl)).toBe(`${RELAY}/__liveshare/owner-credential`)
    expect(JSON.parse(await new Response(exchangeInit?.body).text())).toMatchObject({ code: 'one-time-code' })
    // A settled transaction is not collected again.
    await expect(status(h, started.state, PAGE)).resolves.toEqual(verified)
    expect(relayFetch).toHaveBeenCalledTimes(3)
  })

  it('shares one collection between asks that overlap a slow exchange', async () => {
    // The Relay answers the same issued code to every collection, so an ask arriving while the first
    // exchange is still in flight must not reach the transaction that exchange already completed.
    let finishExchange: ((response: Response) => void) | undefined
    const relayFetch = vi.fn((input: URL | Request) => relayRequestUrl(input).endsWith('/owner-login-poll')
      ? Promise.resolve(Response.json({ status: 'issued', code: 'one-time-code' }))
      : new Promise<Response>((resolve) => { finishExchange = resolve }))
    const h = harness(false, { relayFetch })
    const started = await start(h, PAGE)

    const first = status(h, started.state, PAGE)
    const second = status(h, started.state, PAGE)
    await vi.waitFor(() => { expect(finishExchange).toBeDefined() })
    finishExchange?.(Response.json({ credential: CREDENTIAL }))
    await expect(first).resolves.toEqual(verified)
    await expect(second).resolves.toEqual(verified)
    expect(relayFetch.mock.calls.filter(([input]) => relayRequestUrl(input).endsWith('/owner-login-poll'))).toHaveLength(1)
  })

  it('keeps a transaction waiting while the Relay cannot answer, and settles a final answer', async () => {
    const answers: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('offline')),
      async () => new Response('busy', { status: 503 }),
      async () => new Response('not json', { status: 200 }),
    ]
    const relayFetch = vi.fn(() => answers.shift()!())
    const h = harness(false, { relayFetch })
    const started = await start(h, PAGE)
    for (let ask = 0; ask < 3; ask += 1) {
      await expect(status(h, started.state, PAGE)).resolves.toEqual({ status: 'pending' })
    }

    // Each final Relay answer ends the transaction with the reason the page states.
    for (const [answer, error] of [
      [Response.json(null), 'owner-login-failed'],
      [Response.json({ status: 'unrecognised' }), 'owner-login-failed'],
      [Response.json({ status: 'issued', code: '' }), 'owner-login-failed'],
      [Response.json({ error: 'owner-login-denied' }, { status: 403 }), 'owner-login-failed'],
    ] as const) {
      const final = harness(false, { relayFetch: async () => answer })
      const minted = await start(final, PAGE)
      await expect(status(final, minted.state, PAGE)).resolves.toEqual({ status: 'failed', error })
    }
  })

  it('keeps a copied link usable when the first poll precedes browser registration', async () => {
    const relayFetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: 'expired' }))
      .mockResolvedValueOnce(Response.json({ status: 'issued', code: 'c' }))
      .mockResolvedValueOnce(Response.json({ credential: CREDENTIAL }))
    const h = harness(false, { relayFetch })
    const { state } = await start(h, PAGE)
    await expect(status(h, state, PAGE)).resolves.toEqual({ status: 'pending' })
    await expect(status(h, state, PAGE)).resolves.toEqual(verified)
  })

  it('settles an issued code this host can no longer redeem as final', async () => {
    // The instance the transaction was minted for is gone, so the issued code completes nothing.
    let instance = 'instance'
    const relayFetch = vi.fn(async () => Response.json({ status: 'issued', code: 'one-time-code' }))
    const h = harness(false, { relayFetch, instanceKey: () => instance })
    const started = await start(h, PAGE)
    instance = 'replaced'
    await expect(status(h, started.state, PAGE)).resolves.toEqual({ status: 'failed', error: 'owner-login-mismatch' })
    await expect(status(h, started.state, PAGE)).resolves.toEqual({ status: 'failed', error: 'owner-login-mismatch' })
    expect(relayFetch).toHaveBeenCalledTimes(1)
  })

  it('settles an issued code as a mismatch once the owner cleared the address', async () => {
    let relay: string | undefined = RELAY
    const h = harness(false, { relayFetch: async () => Response.json({ status: 'issued', code: 'c' }), relay: () => relay })
    const started = await start(h, PAGE)
    relay = undefined
    await expect(status(h, started.state, PAGE)).resolves.toEqual({ status: 'failed', error: 'owner-login-mismatch' })
  })

  it('reads a transaction cancelled while its code was being collected as expired', async () => {
    const polled = Promise.withResolvers<Response>()
    const h = harness(false, { relayFetch: () => polled.promise })
    const started = await start(h, PAGE)
    const asked = status(h, started.state, PAGE)
    await h.call('/api/liveshare.ownerLoginCancel', { state: started.state }, PAGE)
    polled.resolve(Response.json({ status: 'issued', code: 'c' }))
    await expect(asked).resolves.toEqual({ status: 'failed', error: 'owner-login-expired' })
  })

  it('refuses a status ask that names no transaction', async () => {
    const h = harness(false)
    const missing = await h.call('/api/liveshare.ownerLoginStatus', {}, PAGE)
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toEqual({ error: 'invalid-status' })
  })
})
