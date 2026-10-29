/**
 * The two Relay checks as the owner host answers them.
 *
 * Connectivity is asked without a credential, so a Relay that refuses an anonymous request is still
 * connected; the permission check registers a throwaway share with this host's own credential, so a
 * refusal there is an authorization failure the owner has to act on.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/host/share-host.ts'
import type {} from '../src/index.ts'
import { writeOwnerCredential, writeOwnerState } from './owner-identity-fixture.ts'

interface OwnerRoutes {
  readonly routes: Map<string, (request: Request) => Promise<Response>>
  readonly host: Context
}

async function ownerHost(configured: string | undefined, file: string): Promise<OwnerRoutes> {
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
  // Always anchor this host at the temporary state file: the default owner-state path belongs to the
  // developer's installation and may name an address, which would make this fixture depend on it.
  const config: Config = {
    ownerStateFile: configured === undefined ? file : writeOwnerState(file, configured),
  }
  const dispose = await apply(host, config)
  disposers.push(dispose, () => host.fiber.dispose())
  return { routes, host }
}

/** One Relay stand-in that answers every request, and every gateway handshake, with one status. */
async function relayAnswering(status: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status)
    response.end('answered')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

interface RelayCheckBody {
  readonly ok: boolean
  readonly blocking: boolean
  readonly httpReachable?: boolean
  readonly error?: string
}

async function testRelay(host: Context): Promise<RelayCheckBody> {
  return await host.liveshareShares.testRelay()
}

async function testPublish(host: Context): Promise<RelayCheckBody> {
  return await host.liveshareShares.testPublish({ sessionId: 'session-1' })
}

const temporaryRoots: string[] = []
function ownerStateFile(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'liveshare-relay-checks-')))
  temporaryRoots.push(root)
  return join(root, 'owner-shares.json')
}

const disposers: Array<() => unknown> = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  try {
    for (const close of closers.splice(0).reverse()) await close()
    for (const dispose of disposers.splice(0).reverse()) await dispose()
  } finally {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  }
})

describe('liveshare owner Relay checks', () => {
  it('treats a Relay that answers 401 as connected', async () => {
    const relay = await relayAnswering(401)
    closers.push(relay.close)
    const { host } = await ownerHost(relay.url, ownerStateFile())

    // The connectivity step presents no credential, so a refusal meant for a credential is still an
    // answer: the address is reachable, and nothing about authorization is read here.
    await expect(testRelay(host)).resolves.toEqual({
      ok: true,
      httpReachable: true,
      blocking: false,
    })
  })

  it('reports an address that does not answer with its transport cause and the relay prefix', async () => {
    const unreachable = 'http://relay.unreachable.example.test'
    const { host } = await ownerHost(unreachable, ownerStateFile())
    // The transport rejection a refused connection raises, substituted at the network boundary: this
    // environment reaches every address through a proxy, which answers for the far side instead.
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }),
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(refused)))
    try {
      const answer = await testRelay(host)
      expect(answer.ok).toBe(false)
      expect(answer.httpReachable).toBe(false)
      expect(answer.blocking).toBe(true)
      // The dialog prints this text unchanged, so it names the address and the transport cause.
      expect(answer.error).toBe(`${unreachable}: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:9`)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports a refused registration as a blocking permission failure about the credential', async () => {
    const relay = await relayAnswering(401)
    closers.push(relay.close)
    const file = ownerStateFile()
    writeOwnerCredential(file, relay.url)
    const { host } = await ownerHost(relay.url, file)

    const answer = await testPublish(host)
    expect(answer.ok).toBe(false)
    expect(answer.blocking).toBe(true)
    // A refusal is the Relay's decision about this host's credential, so the Host names it as an
    // authorization problem and keeps the Relay's own status beside it.
    expect(answer.error).toContain('owner credential')
    expect(answer.error).toContain('relay refused registration status=401')
    expect(answer.error?.startsWith(`${relay.url}: `)).toBe(true)
  })

  it('states the missing address instead of asking any Relay', async () => {
    const { host } = await ownerHost(undefined, ownerStateFile())

    // Nothing is in force to ask about, so both checks name the missing address and contact nothing.
    await expect(testRelay(host)).resolves.toEqual({
      ok: false,
      httpReachable: false,
      blocking: true,
      error: 'no Liveshare server address is saved',
    })
    await expect(testPublish(host)).resolves.toEqual({
      ok: false,
      blocking: true,
      error: 'no Liveshare server address is saved',
    })
  })

  it('refuses the permission step when no credential is stored for the address', async () => {
    const relay = await relayAnswering(401)
    closers.push(relay.close)
    const { host } = await ownerHost(relay.url, ownerStateFile())

    const answer = await testPublish(host)
    expect(answer).toMatchObject({ ok: false, blocking: true })
    expect(answer.error).toContain('no verified owner credential')
  })
})
