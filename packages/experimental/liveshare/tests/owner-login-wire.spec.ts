/**
 * The host's half of the Owner login wire: what it publishes, and what it refuses.
 *
 * The Relay half is covered against a real Relay elsewhere; these cases pin the contract the Owner client
 * reads and the bindings it cannot loosen — the transaction's own origin, its single use, and the fact that
 * a request that never named an origin cannot begin one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, type Config } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'
import { writeOwnerState } from './owner-identity-fixture.ts'

const RELAY = 'https://relay.example.test/liveshare'
const OWNER_ORIGIN = 'http://owner.test'
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  try {
    for (const close of closers.splice(0).reverse()) await close()
  } finally {
    vi.unstubAllGlobals()
  }
})

/** How this case's fixture Relay answers the owner-credential exchange, if it answers at all. */
interface RelayScript {
  /** What the probe reports about identity support; true unless the case says otherwise. */
  readonly supported?: boolean
  /** Answer one redemption POST; the default refuses it as an unreachable Relay does. */
  readonly credentialAnswer?: () => Response | Promise<Response>
  /** Credential file to configure; the default sits in this case's temporary directory. */
  readonly credentialFile?: string
}

/** One host whose registered routes can be invoked, as the shipped Web host invokes them. */
async function host(script: RelayScript = {}, relay: string | null = RELAY) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-login-wire-')))
  closers.push(() => { rmSync(temporary, { recursive: true, force: true }) })
  // Only the configured endpoint is intercepted; the fixture never reaches an external Relay.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url !== `${RELAY}/__liveshare/owner-credential`) {
      throw new Error(`unexpected fixture request ${request.url}`)
    }
    if (request.method === 'POST') {
      return script.credentialAnswer?.() ?? Promise.reject(new Error('fixture Relay unavailable'))
    }
    return Promise.resolve(Response.json({ supported: script.supported ?? true }))
  })
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  const ctx = Object.assign(new Context(), {
    connection: {
      authenticatedUrl: () => 'http://127.0.0.1:3092/?token=test',
      fetch: {
        register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
          routes.set(route.path, route.fetch)
          return Promise.resolve(async () => {})
        },
      },
    },
    webServer: { port: 3092 },
  })
  const statePath = join(temporary, 'owner-shares.json')
  const config: Config = {
    ownerStateFile: relay === null ? statePath : writeOwnerState(statePath, relay),
    ownerCredentialFile: script.credentialFile ?? join(temporary, 'owner-credential.json'),
  }
  closers.push(() => ctx.fiber.dispose())
  closers.push(await apply(ctx, config))
  const call = (path: string, body: unknown, headers: Record<string, string>): Promise<Response> => {
    const route = routes.get(path)
    if (route === undefined) throw new Error(`missing route ${path}`)
    return route(new Request(`http://127.0.0.1:3092${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }))
  }
  return { call, routes, ctx, temporary }
}

describe('owner login wire', () => {
  it('publishes the popup URL, the transaction deadline, and the Relay’s message origin', async () => {
    const { call } = await host()
    const response = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    // The two origins are distinct facts: the Relay posts from its own, the Owner page's is bound server-side.
    expect(body.messageOrigin).toBe('https://relay.example.test')
    expect(body.authorizationUrl).toBeUndefined()
    const authorizeUrl = new URL(String(body.authorizeUrl))
    expect(authorizeUrl.origin + authorizeUrl.pathname)
      // The configured Relay address carries its public base path, and the authorization page is under it.
      .toBe('https://relay.example.test/liveshare/__liveshare/owner-authorize')
    expect(authorizeUrl.searchParams.get('state')).toBe(body.state)
    expect(authorizeUrl.searchParams.get('instance')).not.toBeNull()
    expect(authorizeUrl.searchParams.get('origin')).toBe(OWNER_ORIGIN)
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(typeof body.expiresAt).toBe('string')
    expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now())
  })

  it('refuses every sign-in step while no address is saved', async () => {
    const { call } = await host({}, null)

    // There is no address to authorize at, so beginning says so; a completion or a posted credential
    // belongs to a configuration this host does not have and is refused as the mismatch it is.
    const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    expect(started.status).toBe(409)
    expect(await started.json()).toEqual({ error: 'owner-login-unavailable', reason: 'relay-required' })

    const redeemed = await call('/api/liveshare.ownerLoginRedeem', { state: 'state', code: 'code' }, { origin: OWNER_ORIGIN })
    expect(redeemed.status).toBe(403)
    expect(await redeemed.json()).toEqual({ error: 'owner-login-mismatch' })

    const stored = await call('/api/liveshare.ownerCredential', { credential: 'payload.signature' }, {})
    expect(stored.status).toBe(403)
    expect(await stored.json()).toEqual({ error: 'owner-login-mismatch' })
  })

  it('refuses to begin a transaction for a request that names no origin', async () => {
    const { call } = await host()
    const response = await call('/api/liveshare.ownerLoginStart', {}, {})

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'owner-login-unavailable',
      reason: 'origin-required',
    })
  })

  it('refuses a completion from another page, and one for a transaction it never began', async () => {
    const { call } = await host()
    const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    const { state } = await started.json() as { state: string }

    // Another page holding the state cannot complete it: the origin is bound when the transaction begins.
    const foreign = await call(
      '/api/liveshare.ownerLoginRedeem',
      { state, code: 'a-code' },
      { origin: 'https://attacker.example' },
    )
    expect(foreign.status).toBe(403)
    await expect(foreign.json()).resolves.toMatchObject({ error: 'owner-login-mismatch' })

    // The refusal did not consume the transaction, so the owner's own page may still finish it.
    const unknown = await call(
      '/api/liveshare.ownerLoginRedeem',
      { state: 'no-such-transaction', code: 'a-code' },
      { origin: OWNER_ORIGIN },
    )
    expect(unknown.status).toBe(403)
    await expect(unknown.json()).resolves.toMatchObject({ error: 'owner-login-expired' })
  })

  it('consumes a transaction exactly once, and drops a cancelled one', async () => {
    const { call } = await host()
    const first = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    const { state } = await first.json() as { state: string }

    // The transaction completes and then fails at the unreachable Relay: the completion is spent either way.
    const spent = await call(
      '/api/liveshare.ownerLoginRedeem',
      { state, code: 'a-code' },
      { origin: OWNER_ORIGIN },
    )
    expect(spent.status).toBe(502)
    await expect(spent.json()).resolves.toMatchObject({ error: 'owner-login-failed' })
    const retry = await call(
      '/api/liveshare.ownerLoginRedeem',
      { state, code: 'a-code' },
      { origin: OWNER_ORIGIN },
    )
    await expect(retry.json()).resolves.toMatchObject({ error: 'owner-login-expired' })

    const cancelled = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    const cancelledState = (await cancelled.json() as { state: string }).state
    await expect((await call('/api/liveshare.ownerLoginCancel', { state: cancelledState }, { origin: OWNER_ORIGIN }))
      .json()).resolves.toMatchObject({ cancelled: true })
    // A cancelled attempt leaves no verifier, so a code minted for it can no longer be exchanged.
    await expect((await call(
      '/api/liveshare.ownerLoginRedeem',
      { state: cancelledState, code: 'a-code' },
      { origin: OWNER_ORIGIN },
    )).json()).resolves.toMatchObject({ error: 'owner-login-expired' })
    await expect((await call('/api/liveshare.ownerLoginCancel', { state: cancelledState }, { origin: OWNER_ORIGIN }))
      .json()).resolves.toMatchObject({ cancelled: false })
  })

  it('refuses to begin at a Relay that cannot verify identities', async () => {
    const { call } = await host({ supported: false })
    const response = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: 'owner-login-unavailable',
      reason: 'relay-upgrade-required',
    })
  })

  it('completes an authorization and stores the credential the Relay issued', async () => {
    const { call, temporary } = await host({
      credentialAnswer: () => Response.json({ credential: 'relay-token', displayName: 'Owner' }),
    })
    const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    const { state } = await started.json() as { state: string }

    const redeemed = await call('/api/liveshare.ownerLoginRedeem', { state, code: 'a-code' }, { origin: OWNER_ORIGIN })
    expect(redeemed.status).toBe(200)
    await expect(redeemed.json()).resolves.toMatchObject({
      state: 'verified',
      relay: RELAY,
      renewed: true,
    })
    // The credential the Relay issued is what this host now holds, persisted beside its owner state.
    const stored = JSON.parse(readFileSync(join(temporary, 'owner-credential.json'), 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({ relay: RELAY, credential: 'relay-token' })
  })

  it('refuses a completion that names no origin, no state, or no code', async () => {
    const { call } = await host({ credentialAnswer: () => Response.json({ credential: 'relay-token' }) })
    const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    const { state } = await started.json() as { state: string }

    // The page's origin is part of the binding, so a request that names none cannot complete it.
    const originless = await call('/api/liveshare.ownerLoginRedeem', { state, code: 'a-code' }, {})
    expect(originless.status).toBe(403)
    await expect(originless.json()).resolves.toMatchObject({ error: 'owner-login-mismatch' })

    for (const body of [{ state: 42, code: 42 }, { state: '', code: '' }, {}, { state, code: 42 }]) {
      const invalid = await call('/api/liveshare.ownerLoginRedeem', body, { origin: OWNER_ORIGIN })
      expect(invalid.status).toBe(400)
      await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid-completion' })
    }
  })

  it('states the reason the Relay gave for refusing the code, and keeps no credential', async () => {
    for (const [answer, error, reason] of [
      [{ error: 'code-replayed' }, 'owner-login-replayed', 'code-replayed'],
      [{ error: 'code-expired' }, 'owner-login-failed', 'code-expired'],
      [{ error: 42 }, 'owner-login-failed', undefined],
      [{}, 'owner-login-failed', undefined],
      [{ credential: '' }, 'owner-login-failed', undefined],
    ] as const) {
      const { call } = await host({ credentialAnswer: () => Response.json(answer) })
      const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
      const { state } = await started.json() as { state: string }
      const redeemed = await call('/api/liveshare.ownerLoginRedeem', { state, code: 'a-code' }, { origin: OWNER_ORIGIN })
      expect(redeemed.status).toBe(502)
      const body = await redeemed.json() as Record<string, unknown>
      expect(body.error).toBe(error)
      expect(body.reason).toBe(reason)
    }
  })

  it('refuses the credential once the owner changed the Relay while the Relay was answering', async () => {
    const pending = Promise.withResolvers<Response>()
    const { call, ctx } = await host({ credentialAnswer: () => pending.promise })
    const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    const { state } = await started.json() as { state: string }
    const completion = call('/api/liveshare.ownerLoginRedeem', { state, code: 'a-code' }, { origin: OWNER_ORIGIN })
    await ctx.liveshareShares.setRelay({ relayUrl: 'https://other.example.test' })
    pending.resolve(Response.json({ credential: 'relay-token' }))
    const redeemed = await completion
    expect(redeemed.status).toBe(403)
    await expect(redeemed.json()).resolves.toMatchObject({ error: 'owner-login-mismatch' })
  })

  it('reports a credential it could not persist instead of claiming the sign-in', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-login-wire-')))
    closers.push(() => { rmSync(root, { recursive: true, force: true }) })
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, '')
    const { call } = await host({
      credentialAnswer: () => Response.json({ credential: 'relay-token' }),
      credentialFile: join(blocker, 'owner-credential.json'),
    })
    const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    const { state } = await started.json() as { state: string }

    const redeemed = await call('/api/liveshare.ownerLoginRedeem', { state, code: 'a-code' }, { origin: OWNER_ORIGIN })
    expect(redeemed.status).toBe(500)
    await expect(redeemed.json()).resolves.toMatchObject({ error: 'owner-credential-unavailable' })
  })

  it('refuses a cancel for a state that is not a transaction state', async () => {
    const { call } = await host()
    const invalid = await call('/api/liveshare.ownerLoginCancel', { state: 42 }, { origin: OWNER_ORIGIN })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid-cancel' })
    const missing = await call('/api/liveshare.ownerLoginCancel', {}, { origin: OWNER_ORIGIN })
    expect(missing.status).toBe(400)
  })

  it('refuses a login body that is not a JSON object', async () => {
    const { call } = await host()
    const response = await call('/api/liveshare.ownerLoginRedeem', 'not-an-object', { origin: OWNER_ORIGIN })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid-json' })
  })

  it('refuses a credential body with no credential, and reports one it cannot store', async () => {
    const { call } = await host()
    const invalid = await call('/api/liveshare.ownerCredential', { credential: 42 }, { origin: OWNER_ORIGIN })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid-credential' })

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-login-wire-')))
    closers.push(() => { rmSync(root, { recursive: true, force: true }) })
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, '')
    const blocked = await host({ credentialFile: join(blocker, 'owner-credential.json') })
    const stored = await blocked.call('/api/liveshare.ownerCredential', { credential: 'relay-token' }, {})
    expect(stored.status).toBe(500)
    await expect(stored.json()).resolves.toMatchObject({ error: 'owner-credential-unavailable' })
  })
})
