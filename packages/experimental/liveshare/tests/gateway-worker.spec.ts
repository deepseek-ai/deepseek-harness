/**
 * In-process gateway worker lifecycle: owner IPC in, Relay socket out.
 *
 * The worker normally runs as a spawned child, so its process-bound handlers and socket
 * state machine are exercised here by calling the real `runGatewayWorker()` with a controllable
 * `ws` double and captured `process` IPC. The relay-side wire shape is the protocol package's.
 */

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TunnelRegistrationToken,
  TunnelShareSpec,
  TunnelWorkerCommand,
  TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { RELAY_TRANSIENT_ATTEMPT_LIMIT, RELAY_TRANSIENT_WINDOW_MS } from '../src/owner-gateway/relay-refusal.ts'
import { INITIAL_RETRY_BACKOFF, RETRY_BACKOFF_MAX_MS } from '../src/owner-gateway/retry-backoff.ts'
import { runGatewayWorker } from '../src/owner-gateway/worker.ts'
import { FakeWebSocket } from './gateway-worker-fake-ws.ts'

vi.mock('ws', async () => {
  const { FakeWebSocket: Fake } = await import('./gateway-worker-fake-ws.ts')
  return { WebSocket: Fake }
})

/** Thrown by the captured exit so the spec can observe a worker that terminates. */
class ExitSignal extends Error {}

interface WorkerHarness {
  readonly events: TunnelWorkerEvent[]
  readonly exits: number[]
  command(value: TunnelWorkerCommand | Record<string, unknown>): void
  disconnect(): void
  stop(): void
}

const sockets = (): readonly FakeWebSocket[] => FakeWebSocket.instances
const latest = (): FakeWebSocket => {
  const socket = FakeWebSocket.instances.at(-1)
  if (socket === undefined) throw new Error('worker did not open a gateway socket')
  return socket
}

function shareSpec(overrides: Partial<TunnelShareSpec> = {}): TunnelShareSpec {
  return {
    shareId: 'share',
    sessionId: 'session',
    sessionTitle: 'Session',
    accessMode: 'open',
    relay: 'http://relay.invalid',
    gatewayToken: 'gateway-token',
    ownerDisplayName: 'Owner',
    allowedSubjectIds: [],
    ...overrides,
  }
}

function startWorker(): WorkerHarness {
  const events: TunnelWorkerEvent[] = []
  const exits: number[] = []
  const messageBefore = new Set(process.listeners('message'))
  const disconnectBefore = new Set(process.listeners('disconnect'))
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')
  Object.defineProperty(process, 'send', {
    configurable: true,
    writable: true,
    value: (event: TunnelWorkerEvent): boolean => { events.push(event); return true },
  })
  const exit = (code?: string | number | null): never => {
    exits.push(Number(code ?? 0))
    throw new ExitSignal('worker exited')
  }
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(exit)
  runGatewayWorker()
  const message = process.listeners('message').find(listener => !messageBefore.has(listener)) as ((value: unknown) => void) | undefined
  const disconnect = process.listeners('disconnect').find(listener => !disconnectBefore.has(listener))
  if (message === undefined || disconnect === undefined) throw new Error('worker did not install its IPC handlers')
  const run = (value: unknown): void => {
    try {
      message(value)
    } catch (error) {
      if (!(error instanceof ExitSignal)) throw error
    }
  }
  return {
    events,
    exits,
    command: run,
    disconnect: () => {
      try {
        disconnect()
      } catch (error) {
        if (!(error instanceof ExitSignal)) throw error
      }
    },
    stop: () => {
      process.removeListener('message', message)
      process.removeListener('disconnect', disconnect)
      exitSpy.mockRestore()
      if (sendDescriptor === undefined) delete process.send
      else Object.defineProperty(process, 'send', sendDescriptor)
    },
  }
}

function frames(socket: FakeWebSocket): Record<string, unknown>[] {
  return socket.sent.map(text => JSON.parse(text) as Record<string, unknown>)
}

function eventsOf<T extends TunnelWorkerEvent['type']>(
  harness: WorkerHarness,
  type: T,
): Extract<TunnelWorkerEvent, { type: T }>[] {
  return harness.events.filter(event => event.type === type) as Extract<TunnelWorkerEvent, { type: T }>[]
}

const registrationToken = (): TunnelRegistrationToken => randomUUID() as TunnelRegistrationToken

let worker: WorkerHarness | undefined

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances.length = 0
  FakeWebSocket.deferClose = false
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  worker?.stop()
  worker = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  FakeWebSocket.instances.length = 0
  FakeWebSocket.deferClose = false
})

describe('Liveshare gateway worker IPC', () => {
  it('reports ready, registers a share with its handshake headers, and announces the connection', () => {
    worker = startWorker()
    expect(worker.events).toEqual([{ type: 'ready' }])

    const token = registrationToken()
    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec({ ownerCredential: 'owner-credential' }) })

    const socket = latest()
    expect(socket.url.searchParams.get('shareId')).toBe('share')
    expect(socket.url.searchParams.get('sessionId')).toBe('session')
    expect(socket.url.searchParams.get('sessionTitle')).toBe('Session')
    expect(socket.options.headers).toEqual({
      authorization: 'Bearer gateway-token',
      'x-liveshare-owner-credential': 'owner-credential',
    })
    expect(worker.events.filter(event => event.type === 'share-connected')).toEqual([])

    socket.open()
    expect(worker.events.at(-1)).toEqual({ type: 'share-connected', registrationToken: token, shareId: 'share' })
  })

  it('registers the platform this owner reports and nothing when it reports none', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec({ platform: 'linux' }) })
    expect(latest().url.searchParams.get('platform')).toBe('linux')

    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    expect(latest().url.searchParams.has('platform')).toBe(false)
  })

  it('omits an absent owner credential and treats an identical registration as a no-op', () => {
    worker = startWorker()
    const token = registrationToken()
    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec() })
    expect(latest().options.headers).toEqual({ authorization: 'Bearer gateway-token' })

    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec() })
    expect(sockets()).toHaveLength(1)
  })

  it('replaces a share published under a different registration and ignores unknown removals', () => {
    worker = startWorker()
    const first = registrationToken()
    worker.command({ type: 'add-share', registrationToken: first, share: shareSpec() })
    const firstSocket = latest()
    firstSocket.open()

    const second = registrationToken()
    worker.command({ type: 'add-share', registrationToken: second, share: shareSpec({ sessionTitle: 'Renamed' }) })
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(sockets()).toHaveLength(2)
    // The retired socket's close is not a live connection loss, so no share-closed is reported for it.
    expect(eventsOf(worker, 'share-closed')).toEqual([])
    // A late open from the retired socket does not announce the replacement either.
    firstSocket.open()
    expect(eventsOf(worker, 'share-connected')).toHaveLength(1)

    worker.command({ type: 'remove-share', shareId: 'absent' })
    worker.command({ type: 'remove-share', shareId: 'share' })
    expect(latest().readyState).toBe(FakeWebSocket.CLOSED)
    expect(eventsOf(worker, 'share-closed')).toEqual([])
  })

  it('refuses one malformed owner command without disturbing the running shares', () => {
    worker = startWorker()
    worker.command({ type: 'add-shre' })
    expect(console.warn).toHaveBeenCalledWith('[liveshare] worker refused one owner command')
    expect(sockets()).toEqual([])
  })

  it('reports shutdown and host disconnect by closing every share and exiting', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec({ shareId: 'other' }) })
    expect(sockets()).toHaveLength(2)

    worker.command({ type: 'shutdown' })
    expect(sockets().map(socket => socket.readyState)).toEqual([FakeWebSocket.CLOSED, FakeWebSocket.CLOSED])
    expect(worker.exits).toEqual([0])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('worker shutting down command=shutdown shares=2'))

    worker.command({ type: 'remove-share', shareId: 'share' })
    expect(sockets()).toHaveLength(2)
  })

  it('closes every share when the host connection disappears', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    worker.disconnect()
    expect(latest().readyState).toBe(FakeWebSocket.CLOSED)
    expect(worker.exits).toEqual([0])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('worker lost its host connection shares=1'))
  })

  it('runs without an IPC channel to report events to', () => {
    worker = startWorker()
    delete process.send
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    expect(() => { latest().open() }).not.toThrow()
    expect(worker.events).toEqual([{ type: 'ready' }])
  })
})

describe('Liveshare gateway worker request correlation', () => {
  it('routes a relay request to the owner and returns the answered body', () => {
    worker = startWorker()
    const token = registrationToken()
    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec() })
    const socket = latest()
    socket.open()

    socket.frame({ type: 'share-rpc', id: 5, body: { op: 'read', id: 9 }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' } })
    const received = eventsOf(worker, 'share-rpc-request')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ registrationToken: token, id: 5, shareId: 'share', body: { op: 'read', id: 9 } })
    expect(received[0]?.actor).toEqual({ providerId: 'p', tenantId: 't', subjectId: 'alice' })

    worker.command({
      type: 'share-rpc-response', registrationToken: token, token: received[0]!.token, id: 5, shareId: 'share',
      status: 200, body: { value: 'ok' },
    })
    expect(frames(socket).at(-1)).toEqual({ type: 'share-rpc-res', id: 5, status: 200, body: { value: 'ok' } })

    socket.frame({ type: 'share-rpc', id: 6, body: { op: 'read' }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' } })
    const second = eventsOf(worker, 'share-rpc-request').at(-1)!
    worker.command({ type: 'share-rpc-response', registrationToken: token, token: second.token, id: 6, shareId: 'share', status: 204 })
    expect(frames(socket).at(-1)).toEqual({ type: 'share-rpc-res', id: 6, status: 204 })
    expect(frames(socket).at(-1)).not.toHaveProperty('body')
  })

  it('cancels a replaced request, a relay cancel, and every request on a closed socket', () => {
    worker = startWorker()
    const token = registrationToken()
    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec() })
    const socket = latest()
    socket.open()

    socket.frame({ type: 'share-rpc', id: 5, body: { op: 'read' }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' } })
    const first = eventsOf(worker, 'share-rpc-request')[0]!
    socket.frame({ type: 'share-rpc', id: 5, body: { op: 'read' }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' } })
    expect(eventsOf(worker, 'share-rpc-request')).toHaveLength(2)
    expect(eventsOf(worker, 'share-rpc-cancel')[0]).toMatchObject({ token: first.token, id: 5, shareId: 'share' })

    socket.frame({ type: 'share-rpc-cancel', id: 99 })
    expect(eventsOf(worker, 'share-rpc-cancel')).toHaveLength(1)
    socket.frame({ type: 'share-rpc-cancel', id: 5 })
    expect(eventsOf(worker, 'share-rpc-cancel')).toHaveLength(2)

    socket.frame({ type: 'share-rpc', id: 7, body: { op: 'read' }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' } })
    socket.close(1000, 'done')
    expect(eventsOf(worker, 'share-rpc-cancel').at(-1)).toMatchObject({ id: 7, shareId: 'share' })
    expect(eventsOf(worker, 'share-closed')).toHaveLength(1)
  })

  it('drops answers with no live request, a wrong registration, or no gateway', () => {
    worker = startWorker()
    const token = registrationToken()
    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec() })
    const socket = latest()
    socket.open()

    worker.command({ type: 'share-rpc-response', registrationToken: token, token: 'unknown', id: 1, shareId: 'share', status: 200 })
    expect(console.warn).toHaveBeenCalledWith('[liveshare] worker dropped late read response relayId=1')
    worker.command({ type: 'share-rpc-response', registrationToken: token, token: 'unknown', id: 1, shareId: 'absent', status: 200 })

    socket.frame({ type: 'share-rpc', id: 8, body: { op: 'read' }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' } })
    const request = eventsOf(worker, 'share-rpc-request').at(-1)!
    worker.command({ type: 'share-rpc-response', registrationToken: registrationToken(), token: request.token, id: 8, shareId: 'share', status: 200 })
    expect(socket.sent).toEqual([])

    // A socket still in its closing handshake is not OPEN, so the owner's answer has nowhere to go.
    socket.readyState = FakeWebSocket.CLOSING
    worker.command({ type: 'share-rpc-response', registrationToken: token, token: request.token, id: 8, shareId: 'share', status: 200 })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('worker cannot deliver read response'))
    expect(socket.sent).toEqual([])
  })
})

describe('Liveshare gateway worker committed access state', () => {
  it('keeps the newest committed state and re-registers from it after reconnect', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec({ expiresAt: '2030-01-01T00:00:00Z' }) })
    const socket = latest()
    socket.open()

    const newest = {
      type: 'share-access-state', version: 2, accessMode: 'selected', allowedSubjectIds: ['bob'],
      sessionMode: 'view', allowsFork: true, expiresAt: '2030-02-01T00:00:00Z',
    }
    socket.frame(newest)
    expect(eventsOf(worker, 'share-access-state')[0]).toMatchObject({ ...newest, shareId: 'share' })

    socket.frame({ ...newest, version: 1, sessionMode: 'write' })
    socket.frame({ ...newest, version: 2, sessionMode: 'write' })
    expect(eventsOf(worker, 'share-access-state')).toHaveLength(1)

    socket.frame({
      type: 'share-access-state', version: 3, accessMode: 'open', allowedSubjectIds: ['carol'], sessionMode: 'write',
    })
    expect(eventsOf(worker, 'share-access-state')).toHaveLength(2)

    socket.close(1000, 'reconnect')
    vi.advanceTimersByTime(500)
    const reconnected = latest()
    expect(reconnected).not.toBe(socket)
    expect(reconnected.url.searchParams.get('accessMode')).toBe('open')
    expect(reconnected.url.searchParams.get('sessionMode')).toBe('write')
    expect(reconnected.url.searchParams.getAll('allowedSubjectId')).toEqual(['carol'])
    expect(reconnected.url.searchParams.has('allowsFork')).toBe(false)
    expect(reconnected.url.searchParams.has('expiresAt')).toBe(false)
  })
})

describe('Liveshare gateway worker Relay refusal and transport failures', () => {
  it('stops a share the Relay refused to register instead of reconnecting', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()
    socket.refuseHandshake(401)

    expect(socket.terminated).toBe(true)
    expect(console.warn).toHaveBeenCalledWith('[liveshare] worker stopped share=share relay refused registration status=401')
    expect(eventsOf(worker, 'share-closed')).toEqual([])
    vi.advanceTimersByTime(60_000)
    expect(sockets()).toHaveLength(1)
  })

  it('stops reconnecting a share once a transient status has repeated to the limit', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    // Every failure before the limit keeps the reconnect schedule: a Relay that is down may come back.
    for (let attempt = 1; attempt < RELAY_TRANSIENT_ATTEMPT_LIMIT; attempt += 1) {
      const socket = latest()
      socket.refuseHandshake(503)
      expect(socket.terminated).toBe(true)
      vi.advanceTimersByTime(RETRY_BACKOFF_MAX_MS)
      expect(sockets()).toHaveLength(attempt + 1)
    }
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('worker stopped share=share'))

    // The twentieth consecutive failure stops the share with the status the Relay kept answering, so
    // an owner republish is the way back in instead of a retry every three minutes until the window.
    const last = latest()
    last.refuseHandshake(503)
    expect(console.warn).toHaveBeenCalledWith('[liveshare] worker stopped share=share automatic reconnect attempts exhausted: relay answered registration status=503')
    // The Host hears the worker's verdict, not only the raw answer of the last attempt.
    expect(eventsOf(worker, 'share-error').at(-1)).toMatchObject({ message: 'automatic reconnect attempts exhausted: relay answered registration status=503', reconnectStopped: true })
    vi.advanceTimersByTime(3_600_000)
    expect(sockets()).toHaveLength(RELAY_TRANSIENT_ATTEMPT_LIMIT)

    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    expect(sockets()).toHaveLength(RELAY_TRANSIENT_ATTEMPT_LIMIT + 1)
  })

  it('ends a stalled handshake at the deadline without touching its replacement', () => {
    worker = startWorker()
    const token = registrationToken()
    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec() })
    const stalled = latest()
    vi.advanceTimersByTime(RELAY_TRANSIENT_WINDOW_MS - 1)
    expect(eventsOf(worker, 'share-error')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(stalled.readyState).toBe(FakeWebSocket.CLOSED)
    expect(eventsOf(worker, 'share-error')).toEqual([{ type: 'share-error', registrationToken: token,
      shareId: 'share', reconnectStopped: true, message: 'automatic reconnect deadline reached' }])
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    latest().open()
    stalled.reportClose()
    expect(eventsOf(worker, 'share-error')).toHaveLength(1)
    expect(eventsOf(worker, 'share-connected')).toHaveLength(1)
  })

  it('cancels the old deadline when replacing an unadmitted registration', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    vi.advanceTimersByTime(RELAY_TRANSIENT_WINDOW_MS - 1)
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    vi.advanceTimersByTime(1)
    expect(eventsOf(worker, 'share-error')).toEqual([])
    latest().open()
    expect(eventsOf(worker, 'share-connected')).toHaveLength(1)
  })

  it('caps the reconnect delay at the schedule ceiling once a transient status keeps repeating', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const firstCappedRetry = Math.ceil(Math.log2(RETRY_BACKOFF_MAX_MS / INITIAL_RETRY_BACKOFF.delayMs))
    for (let retry = 0; retry <= firstCappedRetry + 1; retry++) {
      const delay = Math.min(INITIAL_RETRY_BACKOFF.delayMs * 2 ** retry, RETRY_BACKOFF_MAX_MS)
      latest().refuseHandshake(503)
      vi.advanceTimersByTime(delay - 1)
      expect(sockets()).toHaveLength(retry + 1)
      vi.advanceTimersByTime(1)
      expect(sockets()).toHaveLength(retry + 2)
    }
  })

  it('counts a transient failure only until the Relay admits the share', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    for (let attempt = 1; attempt < RELAY_TRANSIENT_ATTEMPT_LIMIT; attempt += 1) {
      latest().refuseHandshake(503)
      vi.advanceTimersByTime(RETRY_BACKOFF_MAX_MS)
    }
    // A Relay that admits the share ends the failure sequence, so the next outage starts over.
    latest().open()
    expect(eventsOf(worker, 'share-connected')).toHaveLength(1)
    const admitted = latest()
    admitted.close(1006, 'reconnect')
    vi.advanceTimersByTime(RETRY_BACKOFF_MAX_MS)

    const socketsBefore = sockets().length
    const next = latest()
    next.refuseHandshake(503)
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('worker stopped share=share'))
    // The admitted connection ended before it was old enough to reset the delay, so the schedule
    // continues from where the failures left it rather than restarting at the first delay.
    vi.advanceTimersByTime(RETRY_BACKOFF_MAX_MS)
    expect(sockets()).toHaveLength(socketsBefore + 1)
  })

  it('retries a transient handshake failure and reports the socket error that carries the status', async () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()
    FakeWebSocket.deferClose = true
    socket.refuseHandshake(500)
    socket.fail(new Error('socket hang up'))
    expect(eventsOf(worker, 'share-error')[0]).toMatchObject({ shareId: 'share', message: 'relay answered registration status=500' })

    await Promise.resolve()
    expect(eventsOf(worker, 'share-closed')).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('gateway-error relay answered registration status=500'))
    vi.advanceTimersByTime(500)
    expect(sockets()).toHaveLength(2)
  })

  it('stops reconnecting a share whose socket never opened at the attempt limit', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    // A Relay that is unreachable or whose TLS handshake fails never answers with a status, so the
    // socket closes before it opens. Without counting that, this share would retry for as long as the
    // worker lives.
    for (let attempt = 1; attempt < RELAY_TRANSIENT_ATTEMPT_LIMIT; attempt += 1) {
      latest().fail(new Error('connect ECONNREFUSED 127.0.0.1:443'))
      vi.advanceTimersByTime(RETRY_BACKOFF_MAX_MS)
      expect(sockets()).toHaveLength(attempt + 1)
    }
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('worker stopped share=share'))

    // The failure at the limit stops the share, and its diagnostic names what the socket failed with
    // because the Relay never answered with a status.
    latest().fail(new Error('connect ECONNREFUSED 127.0.0.1:443'))
    expect(console.warn).toHaveBeenCalledWith(
      '[liveshare] worker stopped share=share automatic reconnect attempts exhausted: gateway-error connect ECONNREFUSED 127.0.0.1:443',
    )
    expect(eventsOf(worker, 'share-error').at(-1)).toMatchObject({
      shareId: 'share', reconnectStopped: true, message: 'automatic reconnect attempts exhausted: gateway-error connect ECONNREFUSED 127.0.0.1:443',
    })
    vi.advanceTimersByTime(3_600_000)
    expect(sockets()).toHaveLength(RELAY_TRANSIENT_ATTEMPT_LIMIT)
  })

  it('does not count the close of a connection that had opened', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    // Each connection is admitted and then drops on its own: normal use, not a failed registration,
    // so no sequence of failures accumulates and the share keeps reconnecting.
    const connections = RELAY_TRANSIENT_ATTEMPT_LIMIT * 2
    for (let attempt = 1; attempt <= connections; attempt += 1) {
      const socket = latest()
      socket.open()
      socket.close(1006, 'lost')
      vi.advanceTimersByTime(RETRY_BACKOFF_MAX_MS)
    }
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('worker stopped share=share'))
    expect(sockets()).toHaveLength(connections + 1)
  })

  it('reports a socket failure without a handshake status and reconnects with backoff', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()
    socket.fail(new Error('boom'))

    expect(eventsOf(worker, 'share-error')[0]).toMatchObject({ message: 'boom' })
    expect(eventsOf(worker, 'share-closed')).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retryMs=500'))
    vi.advanceTimersByTime(499)
    expect(sockets()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets()).toHaveLength(2)
  })

  it('reports a non-Error failure value and ignores failures from a retired connection', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const first = latest()
    first.open()
    const secondToken = registrationToken()
    worker.command({ type: 'add-share', registrationToken: secondToken, share: shareSpec() })
    first.fail('plain failure')
    expect(eventsOf(worker, 'share-error')).toEqual([])

    const second = latest()
    second.open()
    second.fail('plain failure')
    expect(eventsOf(worker, 'share-error')[0]).toMatchObject({ registrationToken: secondToken, message: 'plain failure' })
  })

  it('starts the retry schedule over after a connection stayed up long enough', () => {
    worker = startWorker()
    const token = registrationToken()
    worker.command({ type: 'add-share', registrationToken: token, share: shareSpec() })
    const first = latest()
    first.open()
    vi.advanceTimersByTime(30_000)
    first.close(1006, 'stable connection lost')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retryMs=500'))

    vi.advanceTimersByTime(500)
    const second = latest()
    second.open()
    // A close reported late for the retired socket is not a loss of the connection that replaced it.
    first.reportClose()
    expect(eventsOf(worker, 'share-closed')).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    second.close(1006, 'short connection lost')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retryMs=1000'))

    vi.advanceTimersByTime(999)
    expect(sockets()).toHaveLength(2)
    vi.advanceTimersByTime(1)
    const third = latest()
    third.open()
    vi.advanceTimersByTime(30_000)
    third.close(1006, 'stable again')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retryMs=500'))
  })
})

describe('Liveshare gateway worker heartbeats and frames it cannot serve', () => {
  it('warns once, then drops a socket whose pong never arrives', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()

    vi.advanceTimersByTime(25_000)
    expect(socket.pingCount).toBe(1)
    vi.advanceTimersByTime(25_000)
    expect(console.warn).toHaveBeenCalledWith('[liveshare] worker heartbeat missed share=share missedPongs=1')
    expect(socket.pingCount).toBe(1)

    vi.advanceTimersByTime(25_000)
    expect(socket.terminated).toBe(true)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('reason=heartbeat-timeout missedPongs=2'))
    expect(eventsOf(worker, 'share-closed')).toHaveLength(1)
  })

  it('clears a missed heartbeat on pong and on any other traffic', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()

    vi.advanceTimersByTime(25_000)
    socket.emit('pong')
    vi.advanceTimersByTime(25_000)
    expect(socket.pingCount).toBe(2)

    socket.frame({ type: 'share-access-state', version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view' })
    vi.advanceTimersByTime(25_000)
    expect(socket.pingCount).toBe(3)
    expect(eventsOf(worker, 'share-closed')).toEqual([])
  })

  it('does not ping a socket that is not open', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()
    socket.readyState = 0
    vi.advanceTimersByTime(25_000)
    expect(socket.pingCount).toBe(0)
  })

  it('answers frames this build cannot serve and drops unanswerable ones', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()

    socket.raw('{not json')
    socket.frame({ type: 'future-frame', id: 7 })
    socket.frame({ type: 'share-rpc', id: 8, body: {} })
    socket.frame({ type: 'share-rpc-res', id: 9, status: 200 })
    expect(frames(socket)).toEqual([
      { type: 'share-rpc-res', id: 7, status: 501, body: { error: 'unsupported-frame' } },
      { type: 'share-rpc-res', id: 8, status: 400, body: { error: 'invalid-request' } },
    ])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('frame=unanswerable'))
  })

  it('ignores frames from a socket the worker already replaced', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const first = latest()
    first.open()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    first.frame({ type: 'share-access-state', version: 1, accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view' })
    first.raw(JSON.stringify({ type: 'future-frame', id: 10 }))
    expect(eventsOf(worker, 'share-access-state')).toEqual([])
    expect(frames(first)).toEqual([])
  })

  it('drops the retry timer when the owner removes a share between attempts', () => {
    worker = startWorker()
    worker.command({ type: 'add-share', registrationToken: registrationToken(), share: shareSpec() })
    const socket = latest()
    socket.open()
    socket.close(1006, 'lost')
    expect(eventsOf(worker, 'share-closed')).toHaveLength(1)

    worker.command({ type: 'remove-share', shareId: 'share' })
    vi.advanceTimersByTime(60_000)
    expect(sockets()).toHaveLength(1)
  })
})
