/** Owner operations keep their captured Relay across asynchronous network and worker completions. */
import { Context } from '@deepseek-ai/cordis'
import type { TunnelRegistrationToken, TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { randomUUID } from 'node:crypto'
import type { TunnelWorkerInput } from '../src/host/tunnel-worker.ts'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'

const worker = vi.hoisted(() => ({
  commands: [] as TunnelWorkerInput[],
  listener: undefined as ((event: TunnelWorkerEvent) => void) | undefined,
  sent: undefined as ((command: TunnelWorkerInput) => void) | undefined,
}))
vi.mock('../src/host/tunnel-worker.ts', () => ({ TunnelWorker: class {
  start() {}
  onEvent(listener: (event: TunnelWorkerEvent) => void) { worker.listener = listener; return () => {} }
  send(command: TunnelWorkerInput) { worker.commands.push(command); worker.sent?.(command) }
  stop() { worker.listener = undefined; return Promise.resolve() }
} }))

const RELAY_A = 'https://relay-a.test/prefix'
const RELAY_B = 'https://relay-b.test/other'
const ORIGIN = 'http://owner.test'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function credential(subjectId: string): string {
  return `${Buffer.from(JSON.stringify({ subjectId, displayName: subjectId })).toString('base64url')}.signature`
}

function response(body: unknown): Response {
  return Response.json(body)
}

interface CapturedFetch {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  readonly body: unknown
}

function relayFetch(handle: (call: CapturedFetch) => Promise<Response> | Response) {
  const calls: CapturedFetch[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    const body: unknown = init?.body === undefined ? undefined : await request.json()
    const call = { url: new URL(request.url), method: request.method, headers: request.headers, body }
    calls.push(call)
    if (![RELAY_A, RELAY_B].some(relay => request.url.startsWith(`${relay}/__liveshare/`))) {
      throw new Error(`unexpected fixture request ${request.url}`)
    }
    return handle(call)
  })
  return calls
}

const closers: Array<() => Promise<void> | void> = []
const stoppers: Array<() => Promise<void>> = []
const releases: Array<() => void> = []
const requests = new Set<Promise<Response>>()
afterEach(async () => {
  try {
    for (const release of releases.splice(0)) release()
    for (const stop of stoppers.splice(0).reverse()) await stop()
    await Promise.allSettled(requests)
    requests.clear()
    for (const close of closers.splice(0).reverse()) await close()
  } finally {
    vi.unstubAllGlobals()
    worker.commands.length = 0
    worker.listener = undefined
    worker.sent = undefined
  }
})

async function host(options: { readonly shares?: readonly { shareId: string; relay: string }[]
  readonly stored?: { relay: string; credential: string } } = {}) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-relay-transaction-')))
  closers.push(() => { rmSync(temporary, { recursive: true, force: true }) })
  const ownerStateFile = join(temporary, 'owner-shares.json')
  const ownerCredentialFile = join(temporary, 'owner-credential.json')
  writeFileSync(ownerStateFile, JSON.stringify({ instanceId: 'instance-1', relayUrl: RELAY_A,
    shares: (options.shares ?? []).map(share => ({
      ...share, sessionId: 'session', sessionTitle: 'Session', accessMode: 'open', gatewayToken: `token-${share.shareId}`,
      allowedSubjectIds: [], createdAt: '2026-10-08T00:00:00Z', sessionMode: 'view',
    })) }))
  if (options.stored !== undefined) writeFileSync(ownerCredentialFile, JSON.stringify({
    ...options.stored, subjectId: 'owner-a', displayName: 'owner-a',
  }))
  const ctx = new Context()
  closers.push(() => ctx.fiber.dispose())
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  Object.assign(ctx, { connection: { fetch: { register: (route: {
    path: string
    fetch: (request: Request) => Promise<Response>
  }) => { routes.set(route.path, route.fetch); return async () => { routes.delete(route.path) } } } } })
  const dispose = await apply(ctx, { ownerStateFile, ownerCredentialFile })
  stoppers.push(dispose)
  const call = (path: string, body?: unknown): Promise<Response> => {
    const route = routes.get(`/api/liveshare.${path.split('?')[0]}`)
    if (route === undefined) throw new Error(`missing route ${path}`)
    const pending = route(body instanceof Request ? body : new Request(`${ORIGIN}/api/liveshare.${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    requests.add(pending)
    return pending
  }
  return { call, ctx, ownerStateFile, ownerCredentialFile, dispose }
}

async function switchRelay(ctx: Context, relayUrl = RELAY_B): Promise<void> {
  expect(await ctx.liveshareShares.setRelay({ relayUrl })).toMatchObject({ effective: relayUrl })
}

describe('Relay operation transactions', () => {
  it.each(['switch', 'switch-back', 'dispose'])('consumes redemption and refuses a late credential after %s', async (change) => {
    const exchanging = deferred<undefined>()
    const exchanged = deferred<Response>()
    releases.push(() => { exchanged.resolve(response({ credential: credential('owner-a') })) })
    const calls = relayFetch((call) => {
      if (call.method === 'POST' && call.url.pathname.endsWith('/owner-credential')) {
        exchanging.resolve(undefined)
        return exchanged.promise
      }
      return response({ supported: true, claimed: true })
    })
    const fixture = await host({ shares: [{ shareId: 'share-b', relay: RELAY_B }] })
    const { state } = await (await fixture.call('ownerLoginStart', {})).json() as { state: string }
    const redeeming = fixture.call('ownerLoginRedeem', { state, code: 'code-a' })
    await exchanging.promise
    if (change === 'dispose') await fixture.dispose()
    else {
      await switchRelay(fixture.ctx)
      if (change === 'switch-back') await switchRelay(fixture.ctx, RELAY_A)
    }
    exchanged.resolve(response({ credential: credential('owner-a') }))
    const redeemed = await redeeming
    expect(redeemed.status).toBe(403)
    expect(await redeemed.json()).toEqual({ error: 'owner-login-mismatch' })
    expect(existsSync(fixture.ownerCredentialFile)).toBe(false)
    expect(calls.filter(call => call.url.pathname.endsWith('/claim'))).toEqual([])
    const exchange = calls.find(call => call.method === 'POST')
    expect(exchange?.url.href).toBe(`${RELAY_A}/__liveshare/owner-credential`)
    expect(exchange?.body).toMatchObject({ code: 'code-a', instanceKey: 'instance-1' })
    const payload = exchange?.body as { readonly code_verifier?: string }
    expect(payload.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const replayed = await fixture.call('ownerLoginRedeem', { state, code: 'code-a' })
    expect(await replayed.json()).toEqual({ error: 'owner-login-expired' })
  })

  it('refuses a credential upload when the Relay changes while its request body is buffered', async () => {
    relayFetch(() => response({ supported: true }))
    const fixture = await host()
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>()
    const request = new Request(`${ORIGIN}/api/liveshare.ownerCredential`, {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({ start(controller) { body.resolve(controller) } }),
      // Node requires duplex for a streamed Request; the host route still performs ordinary JSON buffering.
      ...{ duplex: 'half' },
    })
    const storing = fixture.call('ownerCredential', request)
    const controller = await body.promise
    let closed = false
    releases.push(() => { if (!closed) controller.close() })
    await switchRelay(fixture.ctx)
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ credential: credential('owner-a') })))
    controller.close()
    closed = true
    const stored = await storing
    expect(stored.status).toBe(403)
    expect(await stored.json()).toEqual({ error: 'owner-login-mismatch' })
    expect(existsSync(fixture.ownerCredentialFile)).toBe(false)
  })

  it('does not inherit a changed Relay when a committed credential waits for its probe', async () => {
    const probing = deferred<undefined>()
    const probed = deferred<Response>()
    releases.push(() => { probed.resolve(response({ supported: true })) })
    let blockProbe = false
    const calls = relayFetch((call) => {
      if (blockProbe && call.method === 'GET' && call.url.pathname.endsWith('/owner-credential')) {
        probing.resolve(undefined)
        return probed.promise
      }
      return response({ supported: true, claimed: true })
    })
    const fixture = await host({ shares: [{ shareId: 'share-a', relay: RELAY_A }, { shareId: 'share-b', relay: RELAY_B }] })
    await fixture.ctx.liveshareShares.identity({})
    blockProbe = true
    const storing = fixture.call('ownerCredential', { credential: credential('owner-a') })
    await probing.promise
    await switchRelay(fixture.ctx)
    probed.resolve(response({ supported: true }))
    const stored = await storing
    expect(stored.status).toBe(200)
    expect(await stored.json()).toMatchObject({ state: 'verified', relay: RELAY_A, subjectId: 'owner-a', claim: { claimed: 1, skipped: 0 } })
    expect(JSON.parse(readFileSync(fixture.ownerCredentialFile, 'utf8'))).toMatchObject({ relay: RELAY_A, credential: credential('owner-a') })
    const claims = calls.filter(call => call.url.pathname.endsWith('/claim'))
    expect(claims.map(call => call.url.href)).toEqual([`${RELAY_A}/__liveshare/share/claim?shareId=share-a`])
    expect(claims[0]?.headers.get('x-liveshare-owner-credential')).toBe(credential('owner-a'))
  })

  it('returns the committed credential identity even if another credential commits while its claim waits', async () => {
    const claiming = deferred<undefined>()
    const claimed = deferred<Response>()
    releases.push(() => { claimed.resolve(response({ claimed: true })) })
    const calls = relayFetch((call) => {
      if (call.url.pathname.endsWith('/claim') && call.headers.get('x-liveshare-owner-credential') === credential('first')) {
        claiming.resolve(undefined)
        return claimed.promise
      }
      return response({ supported: true, claimed: true })
    })
    const fixture = await host({ shares: [{ shareId: 'share-a', relay: RELAY_A }, { shareId: 'share-a2', relay: RELAY_A }] })
    const first = fixture.call('ownerCredential', { credential: credential('first') })
    await claiming.promise
    const second = await fixture.call('ownerCredential', { credential: credential('second') })
    expect(await second.json()).toMatchObject({ subjectId: 'second' })
    claimed.resolve(response({ claimed: true }))
    expect(await (await first).json()).toMatchObject({ state: 'verified', relay: RELAY_A, subjectId: 'first' })
    expect(JSON.parse(readFileSync(fixture.ownerCredentialFile, 'utf8'))).toMatchObject({ credential: credential('second') })
    const firstClaims = calls.filter(call => call.url.pathname.endsWith('/claim')
      && call.headers.get('x-liveshare-owner-credential') === credential('first'))
    expect(firstClaims.map(call => call.url.searchParams.get('shareId'))).toEqual(['share-a', 'share-a2'])
  })

  it('attributes a startup claim to the Relay it asked even if the owner switches during its response', async () => {
    const claiming = deferred<undefined>()
    const claimed = deferred<Response>()
    releases.push(() => { claimed.resolve(response({ claimed: true })) })
    relayFetch((call) => {
      if (call.url.pathname.endsWith('/claim')) { claiming.resolve(undefined); return claimed.promise }
      return response({ supported: true })
    })
    const fixture = await host({ stored: { relay: RELAY_A, credential: credential('owner-a') }, shares: [{ shareId: 'share-a', relay: RELAY_A }] })
    await claiming.promise
    await switchRelay(fixture.ctx)
    claimed.resolve(response({ claimed: true }))
    // The identity route waits on its own probe, after the released claim's queued continuation.
    const identityB = await fixture.ctx.liveshareShares.identity({ relay: RELAY_B })
    expect(identityB).not.toHaveProperty('claim')
    const identityA = await fixture.ctx.liveshareShares.identity({ relay: RELAY_A })
    expect(identityA).toMatchObject({ claim: { claimed: 1, skipped: 0 } })
  })

  it('refuses a login start whose support probe finishes after its selected Relay changes', async () => {
    const probing = deferred<undefined>()
    const probed = deferred<Response>()
    releases.push(() => { probed.resolve(response({ supported: true })) })
    relayFetch(() => { probing.resolve(undefined); return probed.promise })
    const fixture = await host()
    const starting = fixture.call('ownerLoginStart', {})
    await probing.promise
    await switchRelay(fixture.ctx)
    probed.resolve(response({ supported: true }))
    const started = await starting
    expect(started.status).toBe(403)
    expect(await started.json()).toEqual({ error: 'owner-login-mismatch' })
  })

  it('keeps an in-flight share registration, persisted Relay, link and reconnect on the captured address', async () => {
    relayFetch(() => response({ supported: true, requests: [] }))
    const fixture = await host({ stored: { relay: RELAY_A, credential: credential('owner-a') } })
    const registering = deferred<Extract<TunnelWorkerInput, { type: 'add-share' }>>()
    worker.sent = (command) => { if (command.type === 'add-share') registering.resolve(command) }
    const creating = fixture.ctx.liveshareShares.create({ sessionId: 'session', sessionTitle: 'Session' })
    const registration = await registering.promise
    expect(registration.share.relay).toBe(RELAY_A)
    expect(registration.share.ownerCredential).toBe(credential('owner-a'))
    await switchRelay(fixture.ctx)
    const registrationToken = randomUUID() as TunnelRegistrationToken
    worker.listener?.({ type: 'share-connected', registrationToken, shareId: registration.share.shareId })
    const created = await creating
    const expectedLink = `${RELAY_A}/?shareId=${registration.share.shareId}`
    expect(created).toMatchObject({ link: expectedLink })
    expect(JSON.parse(readFileSync(fixture.ownerStateFile, 'utf8'))).toMatchObject({ relayUrl: RELAY_B,
      shares: [{ relay: RELAY_A, shareId: registration.share.shareId }] })
    expect(await fixture.ctx.liveshareShares.list()).toMatchObject({ shares: [{ link: expectedLink }] })
    // A mode update uses the same registration builder as a host restart, without creating a second host.
    await expect(fixture.ctx.liveshareShares.updatePermissions({
      shareId: registration.share.shareId, sessionMode: 'view',
    })).resolves.toMatchObject({ sessionMode: 'view' })
    const reconnect = worker.commands.filter(command => command.type === 'add-share').at(-1)
    expect(reconnect).toMatchObject({ share: { relay: RELAY_A, ownerCredential: credential('owner-a'), ownerDisplayName: 'owner-a' } })
  })
})
