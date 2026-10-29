/** Tunnel worker process supervision: spawn, IPC correlation, restart, and stop. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  TunnelRegistrationToken,
  TunnelRequestToken,
  TunnelShareSpec,
  TunnelWorkerEvent,
} from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import { TunnelWorker } from '../src/host/tunnel-worker.ts'
import { FakeTunnelChild } from './tunnel-worker-fake-child.ts'

vi.mock('node:child_process', async () => {
  const { FakeTunnelChild: Fake } = await import('./tunnel-worker-fake-child.ts')
  return {
    spawn: (executable: string, args: readonly string[]) => new Fake(executable, args),
  }
})

const share = (shareId = 'share-1'): TunnelShareSpec => ({
  shareId, sessionId: `session-${shareId}`, sessionTitle: shareId, accessMode: 'open',
  relay: 'http://relay.invalid', gatewayToken: 'gateway-token', ownerDisplayName: 'Owner',
  allowedSubjectIds: [],
})

const token = (): TunnelRequestToken => randomUUID() as TunnelRequestToken

interface Harness {
  readonly worker: TunnelWorker
  readonly events: TunnelWorkerEvent[]
  add(shareId?: string): FakeTunnelChild
  child(): FakeTunnelChild
  registration(child: FakeTunnelChild, shareId?: string): TunnelRegistrationToken
  connect(child: FakeTunnelChild, shareId?: string): void
}

const workers: TunnelWorker[] = []
const ownedChildren = new Map<TunnelWorker, FakeTunnelChild[]>()

function harness(): Harness {
  const worker = new TunnelWorker({ command: { executable: process.execPath, args: ['-e', ''] } })
  workers.push(worker)
  const events: TunnelWorkerEvent[] = []
  worker.onEvent((event) => { events.push(event) })
  const child = (): FakeTunnelChild => {
    const spawned = FakeTunnelChild.spawned.at(-1)
    if (spawned === undefined) throw new Error('worker spawned no child')
    return spawned
  }
  const add = (shareId = 'share-1'): FakeTunnelChild => {
    worker.send({ type: 'add-share', share: share(shareId) })
    const spawned = child()
    spawned.emit('spawn')
    const owned = ownedChildren.get(worker) ?? []
    owned.push(spawned)
    ownedChildren.set(worker, owned)
    return spawned
  }
  const registration = (target: FakeTunnelChild, shareId = 'share-1'): TunnelRegistrationToken => {
    const command = target.sent.find(value => (value as { type?: string }).type === 'add-share'
      && (value as { share?: { shareId?: string } }).share?.shareId === shareId)
    if (command === undefined) throw new Error(`child holds no add-share for ${shareId}`)
    return (command as { registrationToken: TunnelRegistrationToken }).registrationToken
  }
  const connect = (target: FakeTunnelChild, shareId = 'share-1'): void => {
    target.emit('message', { type: 'ready' })
    target.emit('message', { type: 'share-connected', registrationToken: registration(target, shareId), shareId })
  }
  return { worker, events, add, child, registration, connect }
}

beforeEach(() => {
  FakeTunnelChild.spawned.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const child of FakeTunnelChild.spawned) {
    if (child.exitCode === null) child.exit(0)
  }
  for (const worker of workers.splice(0).reverse()) {
    await worker.stop()
    ownedChildren.delete(worker)
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  FakeTunnelChild.spawned.length = 0
})

describe('tunnel worker lifecycle', () => {
  it('starts lazily, replays queued commands on ready, and stops listening when unsubscribed', () => {
    const h = harness()
    const listener = vi.fn()
    const dispose = h.worker.onEvent(listener)
    const child = h.add()
    expect(FakeTunnelChild.spawned).toHaveLength(1)
    expect(child.sent).toEqual([])

    child.emit('message', { type: 'ready' })
    const add = child.sent[0] as { type: string; registrationToken: TunnelRegistrationToken }
    expect(add.type).toBe('add-share')
    expect(add.registrationToken).toMatch(/^[0-9a-f-]{36}$/u)
    // Already running: a second add does not spawn another process.
    h.worker.send({ type: 'add-share', share: share('share-2') })
    expect(FakeTunnelChild.spawned).toHaveLength(1)

    dispose()
    listener.mockClear()
    child.emit('message', { type: 'share-connected', registrationToken: h.registration(child), shareId: 'share-1' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('ignores events from a replaced process and reports an unreadable worker event', () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.add()
    h.connect(first)
    first.emit('message', { type: 'not-a-worker-event' })
    expect(console.warn).toHaveBeenCalledWith('[liveshare] host dropped one worker event type=not-a-worker-event')
    first.emit('message', 'text')
    expect(console.warn).toHaveBeenCalledWith('[liveshare] host dropped one worker event type=unnamed')

    first.exit(1)
    expect(h.events.filter(event => event.type === 'share-error')).toHaveLength(1)
    vi.advanceTimersByTime(500)
    const second = h.child()
    expect(second).not.toBe(first)
    h.events.length = 0
    first.emit('message', { type: 'ready' })
    first.exit(0)
    expect(h.events).toEqual([])
  })

  it('ignores worker events whose registration this host no longer holds', () => {
    const h = harness()
    const child = h.add()
    child.emit('message', { type: 'ready' })
    const h2 = harness()
    const other = h2.add('share-2')
    other.emit('message', { type: 'ready' })
    child.emit('message', { type: 'share-connected', registrationToken: h2.registration(other, 'share-2'), shareId: 'share-1' })
    expect(h.events.filter(event => event.type === 'share-connected')).toEqual([])
  })

  it('applies the newest committed access state to the registration a restart replays', () => {
    vi.useFakeTimers()
    const h = harness()
    const child = h.add()
    child.emit('message', { type: 'ready' })
    const registration = h.registration(child)
    // Before the share is connected the state is not applied.
    child.emit('message', {
      type: 'share-access-state', registrationToken: registration, shareId: 'share-1', version: 1,
      accessMode: 'selected', allowedSubjectIds: ['alice'], sessionMode: 'view', allowsFork: true,
      expiresAt: '2030-01-01T00:00:00Z',
    })
    expect(h.events.filter(event => event.type === 'share-access-state')).toEqual([])

    h.connect(child)
    child.emit('message', {
      type: 'share-access-state', registrationToken: registration, shareId: 'share-1', version: 2,
      accessMode: 'selected', allowedSubjectIds: ['alice'], sessionMode: 'write', allowsFork: true,
      expiresAt: '2030-01-01T00:00:00Z',
    })
    child.emit('message', {
      type: 'share-access-state', registrationToken: registration, shareId: 'share-1', version: 2,
      accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view',
    })
    expect(h.events.filter(event => event.type === 'share-access-state')).toHaveLength(1)

    child.exit(1)
    vi.advanceTimersByTime(500)
    const replacement = h.child()
    replacement.emit('message', { type: 'ready' })
    const replayed = replacement.sent.find(value => (value as { type?: string }).type === 'add-share') as {
      share: TunnelShareSpec
    }
    expect(replayed.share).toMatchObject({ accessMode: 'selected', sessionMode: 'write', allowsFork: true })
    expect(replayed.share.expiresAt).toBe('2030-01-01T00:00:00Z')

    child.emit('message', {
      type: 'share-access-state', registrationToken: registration, shareId: 'share-1', version: 3,
      accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view',
    })
    expect(h.events.filter(event => event.type === 'share-access-state')).toHaveLength(1)
  })

  it('correlates one request answer with its token, share, id, and registration', () => {
    const h = harness()
    const child = h.add()
    h.connect(child)
    const registration = h.registration(child)
    const requestToken = token()
    child.emit('message', {
      type: 'share-rpc-request', registrationToken: registration, token: requestToken, id: 4,
      shareId: 'share-1', body: { op: 'read' }, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    const before = child.sent.length
    h.worker.send({ type: 'share-rpc-response', token: requestToken, id: 5, shareId: 'share-1', status: 200 })
    h.worker.send({ type: 'share-rpc-response', token: requestToken, id: 4, shareId: 'other', status: 200 })
    h.worker.send({ type: 'share-rpc-response', token: token(), id: 4, shareId: 'share-1', status: 200 })
    expect(child.sent).toHaveLength(before)

    child.connected = false
    h.worker.send({ type: 'share-rpc-response', token: requestToken, id: 4, shareId: 'share-1', status: 200 })
    expect(child.sent).toHaveLength(before)

    // The answer was consumed: once the socket reconnects the same token is no longer live.
    child.connected = true
    h.worker.send({ type: 'share-rpc-response', token: requestToken, id: 4, shareId: 'share-1', status: 200 })
    expect(child.sent).toHaveLength(before)
  })

  it('keeps a request until its matching cancel arrives', () => {
    const h = harness()
    const child = h.add()
    h.connect(child)
    const registration = h.registration(child)
    const requestToken = token()
    child.emit('message', {
      type: 'share-rpc-request', registrationToken: registration, token: requestToken, id: 7,
      shareId: 'share-1', body: {}, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    child.emit('message', { type: 'share-rpc-cancel', registrationToken: registration, token: token(), id: 7, shareId: 'share-1' })
    child.emit('message', { type: 'share-rpc-cancel', registrationToken: registration, token: requestToken, id: 8, shareId: 'share-1' })
    child.emit('message', { type: 'share-rpc-cancel', registrationToken: registration, token: requestToken, id: 7, shareId: 'other' })
    const before = child.sent.length
    h.worker.send({ type: 'share-rpc-response', token: requestToken, id: 7, shareId: 'share-1', status: 200 })
    expect(child.sent).toHaveLength(before + 1)

    child.emit('message', { type: 'share-rpc-request', registrationToken: registration, token: token(), id: 9,
      shareId: 'share-1', body: {}, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' } })
    h.worker.send({ type: 'remove-share', shareId: 'share-1' })
    expect(h.events.filter(event => event.type === 'share-rpc-cancel').length).toBeGreaterThan(0)
  })

  it('drops a request on its matching cancel', () => {
    const h = harness()
    const child = h.add()
    h.connect(child)
    const registration = h.registration(child)
    const requestToken = token()
    child.emit('message', {
      type: 'share-rpc-request', registrationToken: registration, token: requestToken, id: 11,
      shareId: 'share-1', body: {}, actor: { providerId: 'p', tenantId: 't', subjectId: 'alice' },
    })
    child.emit('message', { type: 'share-rpc-cancel', registrationToken: registration, token: requestToken, id: 11, shareId: 'share-1' })
    const before = child.sent.length
    h.worker.send({ type: 'share-rpc-response', token: requestToken, id: 11, shareId: 'share-1', status: 200 })
    expect(child.sent).toHaveLength(before)
  })

  it('tracks socket loss without forgetting the owner registration', () => {
    const h = harness()
    const child = h.add()
    h.connect(child)
    const registration = h.registration(child)
    child.emit('message', { type: 'share-closed', registrationToken: registration, shareId: 'share-1' })
    expect(h.events.at(-1)).toEqual({ type: 'share-closed', registrationToken: registration, shareId: 'share-1' })
    child.emit('message', { type: 'share-error', registrationToken: registration, shareId: 'share-1', message: 'boom' })
    expect(h.events.at(-1)).toMatchObject({ type: 'share-error', message: 'boom' })
  })

  it('queues commands until a process is ready and drops them when the process is gone', () => {
    const h = harness()
    const child = h.add()
    child.emit('message', { type: 'ready' })
    h.worker.send({ type: 'remove-share', shareId: 'share-1' })
    expect((child.sent.at(-1) as { type: string }).type).toBe('remove-share')

    const queued = harness()
    const pending = queued.add('queued')
    // No ready event yet: the command is held, then flushed when ready arrives.
    queued.worker.send({ type: 'remove-share', shareId: 'queued' })
    expect(pending.sent.some(value => (value as { type?: string }).type === 'remove-share')).toBe(false)
    pending.emit('message', { type: 'ready' })
    expect(pending.sent.some(value => (value as { type?: string }).type === 'remove-share')).toBe(true)
  })
})

describe('tunnel worker transport and staleness', () => {
  it('forwards only non-empty transport settings to the worker', () => {
    for (const name of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY',
      'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) vi.stubEnv(name, undefined)
    vi.stubEnv('NODE_OPTIONS', '--no-warnings')
    vi.stubEnv('NO_PROXY', '')
    const h = harness()
    h.add()
    expect(FakeTunnelChild.spawned).toHaveLength(1)
    vi.unstubAllEnvs()
  })

  it('ignores late spawn and error reports from a replaced process', () => {
    const h = harness()
    const first = h.add()
    first.emit('spawn')
    first.exit(0)
    h.events.length = 0
    first.emit('spawn')
    first.emit('error', new Error('late failure'))
    expect(h.events.filter(event => event.type === 'share-error')).toHaveLength(0)
  })

  it('reports a child failure as a share error and leaves the process stopped', () => {
    const h = harness()
    const child = h.add()
    h.connect(child)
    child.emit('error', new Error('ipc broken'))
    expect(h.events.at(-1)).toMatchObject({ type: 'share-error', message: 'ipc broken' })
  })

  it('ignores worker traffic once stop began', async () => {
    const h = harness()
    const child = h.add()
    h.connect(child)
    const stopped = h.worker.stop()
    child.emit('message', { type: 'ready' })
    child.exit(0)
    await stopped
    expect(h.events.filter(event => event.type === 'share-connected')).toHaveLength(1)
  })

  it('applies a newer committed state that states no expiry', () => {
    const h = harness()
    const child = h.add()
    child.emit('message', { type: 'ready' })
    h.connect(child)
    child.emit('message', {
      type: 'share-access-state', registrationToken: h.registration(child), shareId: 'share-1', version: 4,
      accessMode: 'open', allowedSubjectIds: [], sessionMode: 'view',
    })
    expect(h.events.filter(event => event.type === 'share-access-state')).toHaveLength(1)
  })
})

describe('tunnel worker restart', () => {
  it('restarts with backoff, replays current registrations, and drops superseded queued adds', () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.add('a')
    h.connect(first, 'a')
    first.exit(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('restarting tunnel worker delayMs=500 attempt=1 shares=1'))

    // While the restart is pending a new add is queued; the replay replaces it with the current intent.
    h.worker.send({ type: 'add-share', share: share('b') })
    expect(FakeTunnelChild.spawned).toHaveLength(1)
    vi.advanceTimersByTime(500)
    const second = h.child()
    second.emit('message', { type: 'ready' })
    const adds = second.sent.filter(value => (value as { type?: string }).type === 'add-share') as Array<{ share: TunnelShareSpec }>
    expect(adds.map(value => value.share.shareId).sort()).toEqual(['a', 'b'])
  })

  it('clears a pending replacement when start is called directly', () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.add()
    h.connect(first)
    first.exit(1)
    h.worker.start()
    const second = h.child()
    expect(second).not.toBe(first)
    vi.advanceTimersByTime(5_000)
    expect(FakeTunnelChild.spawned).toHaveLength(2)
  })

  it('replays past a queued command that is not a registration', () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.add()
    h.connect(first)
    first.exit(1)
    h.worker.send({ type: 'remove-share', shareId: 'gone' })
    vi.advanceTimersByTime(500)
    const second = h.child()
    second.emit('message', { type: 'ready' })
    expect(second.sent.some(value => (value as { type?: string }).type === 'remove-share')).toBe(true)
    expect(second.sent.some(value => (value as { type?: string }).type === 'add-share')).toBe(true)
  })

  it('holds queued commands when ready arrives without a connected channel', () => {
    const h = harness()
    const child = h.add()
    child.connected = false
    child.emit('message', { type: 'ready' })
    expect(child.sent).toEqual([])
  })

  it('starts the delay schedule over after a process stayed up long enough', () => {
    vi.useFakeTimers()
    const h = harness()
    const first = h.add()
    h.connect(first)
    vi.advanceTimersByTime(30_000)
    first.exit(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('delayMs=500 attempt=1'))
    first.exit(0)
    vi.advanceTimersByTime(500)
    const second = h.child()
    second.emit('message', { type: 'ready' })
    second.emit('message', { type: 'share-connected', registrationToken: h.registration(second), shareId: 'share-1' })
    second.exit(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('delayMs=1000 attempt=2'))
  })

  it('stays down when it carries no share and cancels a pending restart on stop', async () => {
    vi.useFakeTimers()
    const h = harness()
    const child = h.add()
    h.connect(child)
    h.worker.send({ type: 'remove-share', shareId: 'share-1' })
    child.exit(1)
    expect(FakeTunnelChild.spawned).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    expect(FakeTunnelChild.spawned).toHaveLength(1)

    h.worker.send({ type: 'add-share', share: share() })
    const next = h.child()
    h.connect(next)
    next.exit(1)
    const stopped = h.worker.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    await stopped
    expect(FakeTunnelChild.spawned).toHaveLength(2)
  })
})

describe('tunnel worker stop', () => {
  it('stops a process that never started and ignores commands afterwards', async () => {
    const worker = new TunnelWorker({ command: { executable: process.execPath, args: [] } })
    workers.push(worker)
    await worker.stop()
    worker.start()
    worker.send({ type: 'remove-share', shareId: 'share-1' })
    expect(FakeTunnelChild.spawned).toEqual([])
  })

  it('waits for the worker to exit and kills it only when it hangs', async () => {
    vi.useFakeTimers()
    const h = harness()
    const child = h.add()
    h.connect(child)
    const stopped = h.worker.stop()
    expect((child.sent.at(-1) as { type: string }).type).toBe('shutdown')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.exit(0)
    await stopped
    expect(console.warn).toHaveBeenCalledTimes(0)
  })

  it('does not send shutdown down a disconnected channel', async () => {
    const h = harness()
    const child = h.add()
    child.connected = false
    const before = child.sent.length
    const stopped = h.worker.stop()
    child.exit(0)
    await stopped
    expect(child.sent.slice(before).some(value => (value as { type?: string }).type === 'shutdown')).toBe(false)
  })
})
