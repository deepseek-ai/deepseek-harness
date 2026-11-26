/**
 * What one gateway worker does when the Relay answers its handshake instead of upgrading it.
 *
 * Each case runs a real Relay stand-in and a real worker process over IPC, so the assertions are
 * about the events the owner host receives and the handshakes the Relay actually saw. The bounded
 * cases run the worker on fake timers, so neither an hour of the transient window nor a three-minute
 * backoff is waited for.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseTunnelWorkerEvent,
  type TunnelShareSpec,
  type TunnelRegistrationToken,
  type TunnelWorkerCommand,
  type TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import {
  RELAY_TRANSIENT_ATTEMPT_LIMIT,
  RELAY_TRANSIENT_WINDOW_MS,
  relayRefusal,
} from '../src/owner-gateway/relay-refusal.ts'
import { RETRY_BACKOFF_MAX_MS } from '../src/owner-gateway/retry-backoff.ts'

const workerEntry = fileURLToPath(new URL('../src/owner-gateway/cli.ts', import.meta.url))

/**
 * Write the entry the bounded cases run: the worker with its timers and clock replaced.
 *
 * `mock.timers.tick` runs the delays the worker armed and leaves `setImmediate` alone, so an advance
 * runs the delay the last failure armed. The spec reaches this clock through the `inspect` field of
 * a command the worker rejects as owner input.
 * @returns The entry to run and the directory that holds it.
 */
async function fakeClockEntry(): Promise<{ readonly entry: string; readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'liveshare-fake-clock-'))
  const entry = join(root, 'entry.ts')
  // The entry outside the package is ESM only through this manifest.
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(entry, [
    'import { mock } from \'node:test\'',
    'mock.timers.enable({ apis: [\'setTimeout\', \'setInterval\', \'Date\'] })',
    // A command names a number here; the worker rejects the rest of it as owner input.
    'process.prependListener(\'message\', (value: unknown) => {',
    '  const inspect = (value as { readonly inspect?: unknown } | undefined)?.inspect',
    '  if (typeof inspect === \'string\') mock.timers.tick(Number(inspect))',
    '})',
    `await import(${JSON.stringify(pathToFileURL(workerEntry).href)})`,
    '',
  ].join('\n'))
  return { entry, root }
}

interface RelayStandIn {
  /** Address the worker registers against; every handshake here is answered with the status. */
  readonly url: string
  /** URLs of the registrations this stand-in answered, in arrival order. */
  readonly handshakes: () => readonly URL[]
  /** Whether the client closed the unanswered handshake. */
  readonly heldClosed: () => boolean
  readonly close: () => Promise<void>
}

/**
 * One Relay that answers every gateway handshake with the same HTTP status.
 * @param status - HTTP status every handshake is answered with.
 * @returns The stand-in's address, the handshakes it received, and its close operation.
 */
async function relayAnswering(
  status: number,
  options: { readonly holdSecond?: true } = {},
): Promise<RelayStandIn> {
  const handshakes: URL[] = []
  let heldClosed = false
  const server = createServer((request, response) => {
    handshakes.push(new URL(request.url ?? '/', 'http://relay.invalid'))
    if (options.holdSecond && handshakes.length === 2) {
      response.once('close', () => { heldClosed = true })
      return
    }
    response.writeHead(status)
    response.end('answered')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Relay stand-in has no port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    handshakes: () => handshakes,
    heldClosed: () => heldClosed,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

interface GatewayProcess {
  readonly events: TunnelWorkerEvent[]
  readonly send: (command: TunnelWorkerCommand) => void
  /** Move the fake clock forward, which carries out the delays the worker armed. */
  readonly advance: (ms: number) => void
  readonly stop: () => Promise<void>
}

/**
 * Start one gateway worker the way the owner host starts it: a child process with an IPC channel.
 * @param entry - Worker entry to run, which the bounded cases replace with one on a fake clock.
 * @returns The process, the events it reported, and its teardown.
 */
function startGateway(entry = workerEntry): GatewayProcess {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx/esm', entry], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  const events: TunnelWorkerEvent[] = []
  child.on('message', (value) => {
    const event = parseTunnelWorkerEvent(value)
    if (event !== undefined) events.push(event)
  })
  return {
    events,
    send: (command) => { child.send(command) },
    advance: (ms) => {
      child.send({ type: 'remove-share', shareId: 'clock', inspect: String(ms) })
    },
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      child.kill('SIGTERM')
      await closed
    },
  }
}

function shareSpec(relay: string): TunnelShareSpec {
  return {
    shareId: 'share-1',
    sessionId: 'session-1',
    sessionTitle: 'session-1',
    accessMode: 'open',
    relay,
    gatewayToken: 'gateway-token',
    ownerDisplayName: 'owner',
    allowedSubjectIds: [],
  }
}

function failureMessages(worker: GatewayProcess): string[] {
  return worker.events.filter(event => event.type === 'share-error')
    .map(event => (event.type === 'share-error' ? event.message : ''))
}

function stoppedMessages(worker: GatewayProcess): string[] {
  return worker.events.flatMap(event => event.type === 'share-error' && event.reconnectStopped === true ? [event.message] : [])
}

describe('Relay handshake refusals', () => {
  it('treats only a decision about the registration as final', () => {
    expect(relayRefusal(401)).toBe('relay refused registration status=401')
    expect(relayRefusal(403)).toBe('relay refused registration status=403')
    expect(relayRefusal(410)).toBe('relay refused registration status=410')
    expect(relayRefusal(426)).toBe('relay refused registration status=426')
    // A Relay that does not serve the share at all answers the same on every attempt.
    expect(relayRefusal(404)).toBe('relay refused registration status=404')
    // A Relay that is down, rate limiting, or reached over a broken socket is worth another attempt,
    // up to the attempt limit the worker enforces.
    expect(relayRefusal(500)).toBeUndefined()
    expect(relayRefusal(429)).toBeUndefined()
    expect(relayRefusal(undefined)).toBeUndefined()
  })

  it.each([403, 404, 426])('stops registering a share refused with %s and keeps the status', async (status) => {
    const relay = await relayAnswering(status)
    const worker = startGateway()
    try {
      await expect.poll(() => worker.events.some(event => event.type === 'ready'), { timeout: 20_000 })
        .toBe(true)
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })

      await expect.poll(() => failureMessages(worker)).toContain(`relay refused registration status=${String(status)}`)
      // A refused registration is not retried: the same token reaches the same answer.
      await new Promise((resolve) => { setTimeout(resolve, 1_200) })
      expect(relay.handshakes()).toHaveLength(1)

      // Registering the share again asks the Relay once more, which is how an owner republish recovers.
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })
      await expect.poll(() => relay.handshakes()).toHaveLength(2)
    } finally {
      await worker.stop()
      await relay.close()
    }
  })

  it('retries a Relay that failed without deciding', async () => {
    const relay = await relayAnswering(500)
    const worker = startGateway()
    try {
      await expect.poll(() => worker.events.some(event => event.type === 'ready'), { timeout: 20_000 })
        .toBe(true)
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })

      await expect.poll(() => failureMessages(worker)).toContain('relay answered registration status=500')
      // The status stays diagnosable and the socket comes back on the reconnect schedule.
      await expect.poll(() => relay.handshakes().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    } finally {
      await worker.stop()
      await relay.close()
    }
  })

  it('stops asking after the attempt limit and reports the last transient status', async () => {
    const { entry, root } = await fakeClockEntry()
    const relay = await relayAnswering(503)
    const worker = startGateway(entry)
    try {
      await expect.poll(() => worker.events.some(event => event.type === 'ready'), { timeout: 20_000 }).toBe(true)
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })

      // The worker emits share-closed after it has armed the next delay.
      for (let attempt = 1; attempt < RELAY_TRANSIENT_ATTEMPT_LIMIT; attempt += 1) {
        await expect.poll(() => worker.events.filter(event => event.type === 'share-closed').length, { timeout: 20_000 }).toBe(attempt)
        worker.advance(RETRY_BACKOFF_MAX_MS)
      }
      await expect.poll(() => stoppedMessages(worker), { timeout: 20_000 })
        .toEqual(['automatic reconnect attempts exhausted: relay answered registration status=503'])
      expect(relay.handshakes()).toHaveLength(RELAY_TRANSIENT_ATTEMPT_LIMIT)
    } finally {
      await worker.stop()
      await relay.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('aborts an unanswered second handshake at the original deadline', async () => {
    const { entry, root } = await fakeClockEntry()
    const relay = await relayAnswering(503, { holdSecond: true })
    const worker = startGateway(entry)
    try {
      await expect.poll(() => worker.events.some(event => event.type === 'ready'), { timeout: 20_000 }).toBe(true)
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })

      await expect.poll(() => worker.events.some(event => event.type === 'share-closed'), { timeout: 20_000 }).toBe(true)
      worker.advance(RETRY_BACKOFF_MAX_MS)
      await expect.poll(() => relay.handshakes().length, { timeout: 20_000 }).toBe(2)
      worker.advance(RELAY_TRANSIENT_WINDOW_MS - RETRY_BACKOFF_MAX_MS)
      await expect.poll(() => stoppedMessages(worker), { timeout: 20_000 }).toEqual(['automatic reconnect deadline reached'])
      await expect.poll(relay.heldClosed).toBe(true)
      expect(relay.handshakes()).toHaveLength(2)
    } finally {
      await worker.stop()
      await relay.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
