import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'
import { identityRelay, writeOwnerCredential } from './owner-identity-fixture.ts'

interface OwnerRoutes {
  readonly routes: Map<string, (request: Request) => Promise<Response>>
  readonly host: Context
}

interface RelayStateBody {
  readonly override?: string
  readonly effective?: string
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

const temporaryRoots: string[] = []
function ownerStateFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-relay-override-')))
  temporaryRoots.push(root)
  return join(root, 'owner-shares.json')
}

const fakeRelay = identityRelay

async function readRelayState(host: Context): Promise<RelayStateBody> {
  return host.liveshareShares.relay()
}

async function writeRelayState(host: Context, relayUrl: string | null): Promise<RelayStateBody> {
  return await host.liveshareShares.setRelay({ relayUrl })
}

async function createShare(host: Context): Promise<string> {
  const created = await host.liveshareShares.create({
    sessionId: 'session-1',
    sessionTitle: 'Session',
    accessMode: 'open',
  })
  expect(typeof created.link).toBe('string')
  return created.link
}

describe('liveshare owner relay address', () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    try {
      for (const close of closers.splice(0).reverse()) await close()
    } finally {
      for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
    }
  })

  async function start(file: string): Promise<OwnerRoutes> {
    const { routes, host } = ownerRoutes()
    closers.push(() => host.fiber.dispose())
    const dispose = await apply(host, { ownerStateFile: file })
    closers.push(dispose)
    return { routes, host }
  }

  /**
   * Hand the host a credential for the Relay it will publish to next.
   *
   * The host binds a stored credential to the address in force and refuses creation without one, so a
   * case that publishes at a new address models that exchange.
   */
  async function verify(routes: OwnerRoutes['routes'], relayUrl: string): Promise<void> {
    const route = routes.get('/api/liveshare.ownerCredential')
    expect(route).toBeDefined()
    const response = await route?.(new Request('http://owner.local/api/liveshare.ownerCredential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'fixture-payload.fixture-signature' }),
    }))
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ state: 'verified', relay: relayUrl })
  }

  it('starts with no address and reports that none is saved', async () => {
    const { host } = await start(ownerStateFile())

    await expect(readRelayState(host)).resolves.toEqual({})
    // Creating is the operation the missing address blocks, and the refusal names it.
    await expect(host.liveshareShares.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-url-required' })
    await expect(host.liveshareShares.testRelay()).resolves.toMatchObject({
      ok: false, httpReachable: false, blocking: true, error: 'no Liveshare server address is saved',
    })
    await expect(host.liveshareShares.testPublish({ sessionId: 'session-1' })).resolves.toMatchObject({
      ok: false, blocking: true, error: 'no Liveshare server address is saved',
    })
  })

  it('saves an address, persists it, and publishes new shares to it', async () => {
    const relay = await fakeRelay()
    closers.push(relay.close)
    const file = ownerStateFile()
    const { routes, host } = await start(file)

    await expect(writeRelayState(host, relay.relayUrl)).resolves.toEqual({
      override: relay.relayUrl,
      effective: relay.relayUrl,
    })
    await verify(routes, relay.relayUrl)
    expect(await createShare(host)).toContain(relay.relayUrl)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ relayUrl: relay.relayUrl })
  })

  it('restores the saved address after a restart', async () => {
    const relay = await fakeRelay()
    closers.push(relay.close)
    const file = ownerStateFile()
    const first = await start(file)
    writeOwnerCredential(file, relay.relayUrl)
    await writeRelayState(first.host, relay.relayUrl)
    await verify(first.routes, relay.relayUrl)
    await first.host.fiber.dispose()

    // The address is the owner's saved value, so a later host reads the same one from the state file.
    const { host } = await start(file)
    await expect(readRelayState(host)).resolves.toEqual({
      override: relay.relayUrl,
      effective: relay.relayUrl,
    })
    expect(await createShare(host)).toContain(relay.relayUrl)
  })

  it('clears the saved address and returns to no address', async () => {
    const relay = await fakeRelay()
    closers.push(relay.close)
    const file = ownerStateFile()
    const { host } = await start(file)
    writeOwnerCredential(file, relay.relayUrl)
    await writeRelayState(host, relay.relayUrl)

    await expect(writeRelayState(host, null)).resolves.toEqual({})
    await expect(host.liveshareShares.create({ sessionId: 'session-1' }))
      .rejects.toMatchObject({ code: 'liveshareShares/relay-url-required' })
    // Nothing is stored as in force: the state file carries no address any more.
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('relayUrl')
  })

  it('rejects an invalid relay URL without changing state', async () => {
    const relay = await fakeRelay()
    closers.push(relay.close)
    const { host } = await start(ownerStateFile())
    await writeRelayState(host, relay.relayUrl)

    await expect(host.liveshareShares.setRelay({ relayUrl: 'not-a-url' }))
      .rejects.toMatchObject({ code: 'liveshareShares/invalid-relay-url' })
    expect(await readRelayState(host)).toEqual({ override: relay.relayUrl, effective: relay.relayUrl })
  })

  it('keeps an existing share on the relay it was published to', async () => {
    const first = await fakeRelay()
    const second = await fakeRelay()
    closers.push(first.close, second.close)
    const file = ownerStateFile()
    const { routes, host } = await start(file)

    await writeRelayState(host, first.relayUrl)
    writeOwnerCredential(file, first.relayUrl)
    await verify(routes, first.relayUrl)
    const firstLink = await createShare(host)
    expect(firstLink).toContain(first.relayUrl)
    await writeRelayState(host, second.relayUrl)
    writeOwnerCredential(file, second.relayUrl)
    await verify(routes, second.relayUrl)
    const secondLink = await createShare(host)
    expect(secondLink).toContain(second.relayUrl)

    const persisted = JSON.parse(readFileSync(file, 'utf8')) as {
      shares: Array<{ shareId: string; relay?: string }>
    }
    const firstShareId = new URL(firstLink).searchParams.get('shareId')
    const stored = persisted.shares.find(share => share.shareId === firstShareId)
    expect(stored?.relay).toBe(first.relayUrl)
  })
})
