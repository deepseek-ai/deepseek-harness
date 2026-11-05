/**
 * What one gateway worker does when the Relay answers its handshake instead of upgrading it.
 *
 * Each case runs a real Relay stand-in and a real worker process over IPC, so the assertions are
 * about the events the owner host receives and the handshakes the Relay actually saw.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseTunnelWorkerEvent,
  type TunnelShareSpec,
  type TunnelRegistrationToken,
  type TunnelWorkerCommand,
  type TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { relayRefusal, relayRefusalStatus } from '../src/owner-gateway/relay-refusal.ts'

const workerEntry = fileURLToPath(new URL('../src/owner-gateway/cli.ts', import.meta.url))

interface RelayStandIn {
  readonly url: string
  /** Handshakes the Relay answered. */
  readonly attempts: () => number
  readonly close: () => Promise<void>
}

/** One Relay that answers every gateway handshake with the same HTTP status. */
async function relayAnswering(status: number): Promise<RelayStandIn> {
  let attempts = 0
  const server: Server = createServer((_request, response) => {
    attempts += 1
    response.writeHead(status)
    response.end('answered')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Relay stand-in has no port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    attempts: () => attempts,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

interface GatewayProcess {
  readonly events: TunnelWorkerEvent[]
  readonly send: (command: TunnelWorkerCommand) => void
  readonly stop: () => Promise<void>
}

/** Start one gateway worker the way the owner host starts it: a child process with an IPC channel. */
function startGateway(): GatewayProcess {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx/esm', workerEntry], {
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

describe('Relay handshake refusals', () => {
  it('treats only a decision about the registration as final', () => {
    expect(relayRefusal(401)).toBe('relay refused registration status=401')
    expect(relayRefusal(403)).toBe('relay refused registration status=403')
    expect(relayRefusal(410)).toBe('relay refused registration status=410')
    expect(relayRefusal(426)).toBe('relay refused registration status=426')
    // A Relay that is down, rate limiting, or reached over a broken socket is worth another attempt.
    expect(relayRefusal(500)).toBeUndefined()
    expect(relayRefusal(429)).toBeUndefined()
    expect(relayRefusal(undefined)).toBeUndefined()
  })

  it('reads back the refusing status only from the message this build composes', () => {
    expect(relayRefusalStatus('relay refused registration status=401')).toBe(401)
    expect(relayRefusalStatus('relay refused registration status=410')).toBe(410)
    // A failure the gateway reported any other way keeps the ordinary reconnect schedule.
    expect(relayRefusalStatus('tunnel worker exited code=1 signal=null')).toBeUndefined()
    expect(relayRefusalStatus('relay answered registration status=200')).toBeUndefined()
    // The message carries a status, but not one this build treats as final.
    expect(relayRefusalStatus('relay refused registration status=500')).toBeUndefined()
  })

  it.each([403, 426])('stops registering a share refused with %s and keeps the status', async (status) => {
    const relay = await relayAnswering(status)
    const worker = startGateway()
    try {
      await expect.poll(() => worker.events.some(event => event.type === 'ready'), { timeout: 20_000 })
        .toBe(true)
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })

      await expect.poll(() => failureMessages(worker)).toContain(`relay refused registration status=${String(status)}`)
      // A refused registration is not retried: the same token reaches the same answer.
      await new Promise((resolve) => { setTimeout(resolve, 1_200) })
      expect(relay.attempts()).toBe(1)

      // Registering the share again asks the Relay once more, which is how an owner republish recovers.
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })
      await expect.poll(() => relay.attempts()).toBe(2)
    } finally {
      await worker.stop()
      await relay.close()
    }
  })

  it('keeps retrying a Relay that failed without deciding', async () => {
    const relay = await relayAnswering(500)
    const worker = startGateway()
    try {
      await expect.poll(() => worker.events.some(event => event.type === 'ready'), { timeout: 20_000 })
        .toBe(true)
      worker.send({ type: 'add-share', registrationToken: randomUUID() as TunnelRegistrationToken, share: shareSpec(relay.url) })

      await expect.poll(() => failureMessages(worker)).toContain('relay answered registration status=500')
      // The status stays diagnosable and the socket comes back on the reconnect schedule.
      await expect.poll(() => relay.attempts(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    } finally {
      await worker.stop()
      await relay.close()
    }
  })
})
