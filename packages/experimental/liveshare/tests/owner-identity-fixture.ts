/** Owner-host fixtures: a Relay stand-in that binds owner identity, plus a stored credential. */

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'

/** One Relay stand-in with its recorded gateway upgrades. */
export interface IdentityRelayFixture {
  readonly relayUrl: string
  readonly upgrades: URLSearchParams[]
  readonly close: () => Promise<void>
}

/**
 * Start a Relay stand-in that answers the owner-credential capability probe and records upgrades.
 *
 * Other Relay routes answer 404, which keeps the owner host's best-effort passes honest without
 * pretending a claim succeeded.
 * @returns Fixture origin, recorded upgrades, and its disposer.
 */
export async function identityRelay(): Promise<IdentityRelayFixture> {
  return identityRelayWith({})
}

/**
 * Start a Relay stand-in with an explicit identity-binding answer.
 * @param options Whether the Relay supports owner credentials, and how long its probe takes to
 * answer, which is what makes a late answer observable.
 * @returns Fixture origin, recorded upgrades, and its disposer.
 */
export async function identityRelayWith(options: {
  readonly supported?: boolean
  readonly probeDelayMs?: number
} = {}): Promise<IdentityRelayFixture> {
  const upgrades: URLSearchParams[] = []
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/__liveshare/owner-credential') === true) {
      const answer = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ supported: options.supported ?? true }))
      }
      if (options.probeDelayMs === undefined) answer()
      else setTimeout(answer, options.probeDelayMs)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not-found"}')
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (_socket, request) => {
    upgrades.push(new URL(request.url ?? '/', 'http://relay.local').searchParams)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    relayUrl: `http://127.0.0.1:${String(port)}`,
    upgrades,
    close: async () => {
      for (const client of sockets.clients) client.terminate()
      await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * Write an owner state file that already has a saved Relay address, and optionally stored shares.
 *
 * The saved address is the only one this build has, so a spec that used to pass one in the host
 * configuration writes what the Share dialog would have persisted instead.
 * @param file Owner state file path.
 * @param relayUrl Saved Relay base URL.
 * @param shares Stored share records, each read against the saved address.
 * @returns The same file path.
 */
export function writeOwnerState(
  file: string,
  relayUrl: string,
  shares: readonly Record<string, unknown>[] = [],
): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    relayUrl,
    shares: shares.map(share => ({ relay: relayUrl, ...share })),
  }, null, 2), { mode: 0o600 })
  return file
}

/**
 * Write one stored owner credential beside an owner state file.
 * @param ownerStateFile Owner state file the host configuration points at.
 * @param relay Relay base URL the credential is bound to.
 * @returns Credential file path the host loads by default.
 */
export function writeOwnerCredential(ownerStateFile: string, relay: string): string {
  const file = join(dirname(ownerStateFile), 'owner-credential.json')
  writeFileSync(file, JSON.stringify({
    relay,
    credential: 'fixture-payload.fixture-signature',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    subjectId: 'owner',
  }, null, 2), { mode: 0o600 })
  return file
}
