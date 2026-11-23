/**
 * The host's half of the Owner login wire: what it publishes, and what it refuses.
 *
 * The Relay half is covered against a real Relay elsewhere; these cases pin the contract the Owner client
 * reads and the bindings it cannot loosen — the transaction's own origin and its single use. A request whose
 * shell names no origin is bound to the shell's own origin rather than refused.
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
  /** Answer one code collection; the default reports the code `a-code` as issued. */
  readonly pollAnswer?: () => Response | Promise<Response>
  /** Credential file to configure; the default sits in this case's temporary directory. */
  readonly credentialFile?: string
}

/** One host whose registered routes can be invoked, as the shipped Web host invokes them. */
async function host(script: RelayScript = {}, relay: string | null = RELAY) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-login-wire-')))
  /** Code collections the fixture Relay answered. */
  const polls: string[] = []
  closers.push(() => { rmSync(temporary, { recursive: true, force: true }) })
  // Only the configured endpoint is intercepted; the fixture never reaches an external Relay.
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url === `${RELAY}/__liveshare/owner-login-poll`) {
      polls.push(request.url)
      return Promise.resolve(script.pollAnswer?.() ?? Response.json({ status: 'issued', code: 'a-code' }))
    }
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
  /**
   * Begin one transaction from the owner page and read its state.
   * @returns The state the page carries.
   */
  const start = async (): Promise<string> =>
    (await (await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })).json() as { state: string }).state
  /**
   * Ask how one transaction stands, as a page with the given origin, or with none for `null`.
   * @returns The decoded answer.
   */
  const status = async (state: string, origin: string | null = OWNER_ORIGIN): Promise<unknown> =>
    await (await call('/api/liveshare.ownerLoginStatus', { state }, origin === null ? {} : { origin })).json()
  return { call, start, status, polls, routes, ctx, temporary }
}

describe('owner login wire', () => {
  const expired = { status: 'failed', error: 'owner-login-expired' }

  it('publishes the polled sign-in URL and the transaction deadline', async () => {
    const { call } = await host()
    const response = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['authorizeUrl', 'expiresAt', 'state'])
    const authorizeUrl = new URL(String(body.authorizeUrl))
    expect(authorizeUrl.origin + authorizeUrl.pathname)
      // The configured Relay address carries its public base path, and the authorization page is under it.
      .toBe('https://relay.example.test/liveshare/__liveshare/owner-authorize')
    expect(authorizeUrl.searchParams.get('state')).toBe(body.state)
    expect(authorizeUrl.searchParams.get('instance')).not.toBeNull()
    expect(authorizeUrl.searchParams.get('origin')).toBe(OWNER_ORIGIN)
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    // The Relay holds the code for this host, so any browser may finish the sign-in.
    expect(authorizeUrl.searchParams.get('mode')).toBe('poll')
    expect(Date.parse(String(body.expiresAt))).toBeGreaterThan(Date.now())
  })

  it('refuses every sign-in step while no address is saved', async () => {
    const { call, status } = await host({}, null)

    // There is no address to authorize at, so beginning says so; no transaction exists to read, and a
    // posted credential belongs to a configuration this host does not have.
    const started = await call('/api/liveshare.ownerLoginStart', {}, { origin: OWNER_ORIGIN })
    expect(started.status).toBe(409)
    expect(await started.json()).toEqual({ error: 'owner-login-unavailable', reason: 'relay-required' })

    await expect(status('state')).resolves.toEqual(expired)

    const stored = await call('/api/liveshare.ownerCredential', { credential: 'payload.signature' }, {})
    expect(stored.status).toBe(403)
    expect(await stored.json()).toEqual({ error: 'owner-login-mismatch' })
  })

  it('signs in a page whose shell forwards no origin, and keeps that transaction from every other page', async () => {
    // A shell serving this page from its own scheme admits the page itself and forwards no origin, so the
    // absence cannot mean the request is untrusted; the transaction is bound to the shell's own address.
    const { call, status, polls } = await host({ pollAnswer: () => Response.json({ status: 'pending' }) })
    const response = await call('/api/liveshare.ownerLoginStart', {}, {})
    expect(response.status).toBe(200)
    const { state, authorizeUrl } = await response.json() as { state: string; authorizeUrl: string }
    expect(new URL(authorizeUrl).searchParams.get('origin')).toBe('dsh-app://app')

    await expect(status(state, OWNER_ORIGIN)).resolves.toEqual(expired)
    expect(polls).toEqual([])
    await expect(status(state, null)).resolves.toEqual({ status: 'pending' })
    expect(polls).toHaveLength(1)
  })

  it('reads a transaction only for the page that began it', async () => {
    const { start, status, polls } = await host({ pollAnswer: () => Response.json({ status: 'pending' }) })
    const state = await start()

    // Another page holding the state learns nothing and advances nothing.
    await expect(status(state, 'https://attacker.example')).resolves.toEqual(expired)
    await expect(status('no-such-transaction')).resolves.toEqual(expired)
    expect(polls).toEqual([])
    await expect(status(state)).resolves.toEqual({ status: 'pending' })
  })

  it('consumes a transaction exactly once, and drops a cancelled one', async () => {
    const { call, start, status, polls } = await host()
    const state = await start()

    // The code is collected and the exchange fails at the unreachable Relay: the transaction is spent.
    await expect(status(state)).resolves.toEqual({ status: 'failed', error: 'owner-login-failed' })
    await expect(status(state)).resolves.toEqual({ status: 'failed', error: 'owner-login-failed' })
    expect(polls).toHaveLength(1)

    const cancelledState = await start()
    await expect((await call('/api/liveshare.ownerLoginCancel', { state: cancelledState }, { origin: OWNER_ORIGIN }))
      .json()).resolves.toMatchObject({ cancelled: true })
    // A cancelled attempt leaves no verifier, so a code minted for it can no longer be exchanged.
    await expect(status(cancelledState)).resolves.toEqual(expired)
    await expect((await call('/api/liveshare.ownerLoginCancel', { state: cancelledState }, { origin: OWNER_ORIGIN }))
      .json()).resolves.toMatchObject({ cancelled: false })
  })

  it('completes an authorization and stores the credential the Relay issued', async () => {
    const { start, status, temporary } = await host({
      credentialAnswer: () => Response.json({ credential: 'relay-token', displayName: 'Owner' }),
    })
    const state = await start()

    await expect(status(state)).resolves.toMatchObject({
      status: 'verified',
      identity: { state: 'verified', relay: RELAY, renewed: true },
    })
    // The credential the Relay issued is what this host now holds, persisted beside its owner state.
    const stored = JSON.parse(readFileSync(join(temporary, 'owner-credential.json'), 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({ relay: RELAY, credential: 'relay-token' })
  })

  it('refuses a status ask that names no transaction', async () => {
    const { call } = await host()
    for (const body of [{ state: 42 }, { state: '' }, {}]) {
      const invalid = await call('/api/liveshare.ownerLoginStatus', body, { origin: OWNER_ORIGIN })
      expect(invalid.status).toBe(400)
      await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid-status' })
    }
  })

  it('states the reason the Relay gave for refusing the code, and keeps no credential', async () => {
    for (const [answer, error] of [
      [{ error: 'code-replayed' }, 'owner-login-replayed'],
      [{ error: 'code-expired' }, 'owner-login-failed'],
      [{ error: 42 }, 'owner-login-failed'],
      [{}, 'owner-login-failed'],
      [{ credential: '' }, 'owner-login-failed'],
    ] as const) {
      const { start, status, temporary } = await host({ credentialAnswer: () => Response.json(answer) })
      await expect(status(await start())).resolves.toEqual({ status: 'failed', error })
      expect(() => readFileSync(join(temporary, 'owner-credential.json'))).toThrow()
    }
  })

  it('refuses the credential once the owner changed the Relay while the Relay was answering', async () => {
    const pending = Promise.withResolvers<Response>()
    const exchanging = Promise.withResolvers<undefined>()
    const { start, status, ctx } = await host({
      credentialAnswer: () => { exchanging.resolve(undefined); return pending.promise },
    })
    const state = await start()
    const settled = status(state)
    await exchanging.promise
    await ctx.liveshareShares.setRelay({ relayUrl: 'https://other.example.test' })
    pending.resolve(Response.json({ credential: 'relay-token' }))
    await expect(settled).resolves.toEqual({ status: 'failed', error: 'owner-login-mismatch' })
  })

  it('reports a credential it could not persist instead of claiming the sign-in', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-login-wire-')))
    closers.push(() => { rmSync(root, { recursive: true, force: true }) })
    const blocker = join(root, 'not-a-directory')
    writeFileSync(blocker, '')
    const { start, status } = await host({
      credentialAnswer: () => Response.json({ credential: 'relay-token' }),
      credentialFile: join(blocker, 'owner-credential.json'),
    })
    await expect(status(await start())).resolves.toEqual({ status: 'failed', error: 'owner-credential-unavailable' })
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
    const response = await call('/api/liveshare.ownerLoginStatus', 'not-an-object', { origin: OWNER_ORIGIN })
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
