/**
 * Newest-first streams, readiness, frame release, and channel event subscriptions without a GPU.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FrameChannelState, FrameConnectionId, FrameForwardingViewport, FrameRxId, FrameViewportResult } from '../src/types.ts'
import { FrameRx } from '../src/client/rx.ts'
import { FrameDiscardedError, FrameFailureError } from '../src/client/errors.ts'
import type { FrameForwardingBridge, FrameForwardingFrameLease, FrameRxEvent } from '../src/client/api.ts'

const rx = brandString<FrameRxId>('rx')
const channels = new Set<FrameRx>()
const viewport = (version: number) => ({ version, width: 2, height: 2, deviceScaleFactor: 1, visible: true })
const connected = (connectionId: number, viewportVersion?: number): FrameChannelState => ({
  state: 'connected', connectionId: connectionId as FrameConnectionId, ...viewportVersion === undefined ? {} : { viewportVersion },
})
/** @param initial - State the bridge already knows when the channel connects; null for none. */
function fixture(initial: FrameChannelState | null = connected(1)) {
  let arrive: (lease: FrameForwardingFrameLease) => void = () => {}
  let report: (event: FrameRxEvent) => void = () => {}
  const detach = vi.fn()
  const bridge = {
    attach(_rx, { onFrame, onEvent }) {
      arrive = onFrame
      report = onEvent
      if (initial !== null) report({ kind: 'state', channel: initial })
      return detach
    },
    setViewport: vi.fn(async (_rx: FrameRxId, _viewport: FrameForwardingViewport): Promise<FrameViewportResult> =>
      ({ applied: true, connectionId: 1 as FrameConnectionId })),
    apply: vi.fn(),
    fail: vi.fn(),
    dispose: vi.fn(),
  } satisfies FrameForwardingBridge
  const channel = new FrameRx(rx, bridge)
  channels.add(channel)
  const lease = (requestId: string, options: { generation?: number; connectionId?: number } = {}) => ({
    metadata: {
      rx, connectionId: (options.connectionId ?? 1) as FrameConnectionId, requestId, generation: options.generation ?? 0,
      revision: 1, frameId: 1, width: 2, height: 2,
    },
    frame: {} as VideoFrame,
    release: vi.fn(),
  })
  return {
    channel,
    bridge, detach,
    lease,
    state: (state: FrameChannelState) => { report({ kind: 'state', channel: state }) },
    event: (event: FrameRxEvent) => { report(event) },
    receive: (frame: FrameForwardingFrameLease) => { arrive(frame) },
  }
}
const reason = (error: unknown): unknown => error instanceof FrameDiscardedError ? error.reason : error
afterEach(async () => {
  await Promise.all([...channels].map(channel => channel.close()))
  channels.clear()
})

describe('producer connections', () => {
  it('releases frames of mismatched connections or generations immediately', () => {
    const f = fixture()
    const present = vi.fn()
    f.channel.consume(present, vi.fn())
    const wrongConnection = f.lease('other-conn', { connectionId: 2 })
    f.receive(wrongConnection)
    const wrongGeneration = f.lease('other-gen', { generation: 9 })
    f.receive(wrongGeneration)
    expect(wrongConnection.release).toHaveBeenCalledOnce()
    expect(wrongGeneration.release).toHaveBeenCalledOnce()
    expect(present).not.toHaveBeenCalled()
  })
  it('ignores errors of an unknown connection and reports the connected producer\'s errors to the stream', () => {
    const f = fixture()
    const failure = vi.fn()
    f.channel.consume(vi.fn(), failure)
    f.event({ kind: 'error', connectionId: 2 as FrameConnectionId, source: 'producer', error: 'other stream failed' })
    f.event({ kind: 'error', connectionId: 1 as FrameConnectionId, source: 'producer', error: 'PPT stream rendering failed' })
    f.event({ kind: 'error', connectionId: 1 as FrameConnectionId, source: 'presentation', requestId: 'stream', error: 'frame transfer failed' })
    expect(failure.mock.calls).toEqual([
      [new FrameFailureError('producer', 'PPT stream rendering failed')], [new FrameFailureError('presentation', 'frame transfer failed')],
    ])
    expect(failure.mock.calls.map(([error]) => (error as FrameFailureError).source)).toEqual(['producer', 'presentation'])
  })
  it('resolves readiness once the producer acknowledged the latest viewport', async () => {
    const f = fixture(null)
    let ready: FrameConnectionId | undefined
    const waiting = f.channel.ready().then((connectionId) => { ready = connectionId })
    f.state(connected(1))
    await waiting
    expect(ready).toBe(1)
    f.bridge.setViewport.mockResolvedValueOnce({ applied: false, reason: 'no-producer' })
    await f.channel.setViewport(viewport(1))
    const afterViewport = f.channel.ready()
    f.state(connected(1, 0))
    expect(await Promise.race([afterViewport, Promise.resolve('pending')])).toBe('pending')
    f.state(connected(1, 1))
    expect(await afterViewport).toBe(1)
    expect(await f.channel.ready()).toBe(1)
  })
  it('cancels and fails readiness waits', async () => {
    const f = fixture(null)
    const aborted = new AbortController(); aborted.abort()
    expect(await f.channel.ready(aborted.signal).catch(reason)).toBe('cancelled')
    const controller = new AbortController()
    const cancelled = f.channel.ready(controller.signal).catch(reason)
    controller.abort()
    expect(await cancelled).toBe('cancelled')
    const lost = f.channel.ready().catch(reason)
    f.state({ state: 'closed', cause: 'lost', reason: 'Desktop invalidated a presented frame' })
    expect(await lost).toBe('lost')
    const g = fixture(null)
    const closing = g.channel.ready().catch(reason)
    await g.channel.close()
    expect(await closing).toBe('closed')
  })
})

describe('channel lifetime', () => {
  it('releases later frames on close, and completes after lent frames are released', async () => {
    const f = fixture()
    const using = Promise.withResolvers<undefined>()
    f.channel.consume(() => using.promise, vi.fn())
    const lease = f.lease('lent')
    f.receive(lease)
    let closed = false
    const closing = f.channel.close().then(() => { closed = true })
    const late = f.lease('late')
    f.receive(late)
    expect(late.release).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(lease.release).not.toHaveBeenCalled()
    using.resolve(undefined)
    await closing
    expect(lease.release).toHaveBeenCalledOnce()
    await f.channel.close()
    expect(f.detach).toHaveBeenCalledOnce()
    expect(() => f.channel.consume(vi.fn(), vi.fn())).toThrow('Native channel closed.')
  })
  it('ends routing when the Host closes the channel, reporting the closure to readiness and the stream', async () => {
    const f = fixture()
    const failure = vi.fn()
    f.channel.consume(vi.fn(), failure)
    f.state({ state: 'closed', cause: 'closed', reason: 'Native channel closed' })
    expect(reason(failure.mock.calls[0]![0])).toBe('closed')
    expect(await f.channel.closed).toBe('closed')
    f.state(connected(1))
    expect(f.channel.connectionId).toBeUndefined()
    expect(() => f.channel.ready()).toThrow('Native channel closed.')
    const late = f.lease('late')
    f.receive(late)
    expect(late.release).toHaveBeenCalledOnce()
  })
  it('settles closed once, with the cause that ended routing', async () => {
    const lost = fixture()
    lost.state({ state: 'closed', cause: 'lost', reason: 'Desktop invalidated a presented frame' })
    expect(() => lost.channel.ready()).toThrow('Native channel lost.')
    await lost.channel.close()
    expect(await lost.channel.closed).toBe('lost')
    // A receiver failure is a transport failure, not a discarded frame.
    const failed = fixture()
    failed.state({ state: 'closed', cause: 'failed', reason: 'Native channel failed: listener failed' })
    expect(() => failed.channel.ready()).toThrow('Native channel failed: listener failed')
    expect(await failed.channel.closed).toBe('failed')
    const consumer = fixture()
    consumer.event({ kind: 'failure', error: 'consumer exploded' })
    expect(await consumer.channel.closed).toBe('failed')
    const owner = fixture()
    await owner.channel.close()
    expect(await owner.channel.closed).toBe('closed')
  })
  it('rejects later operations after a renderer-side failure', async () => {
    const f = fixture()
    f.event({ kind: 'failure', error: 'consumer exploded' })
    expect(() => f.channel.consume(vi.fn(), vi.fn())).toThrow('consumer exploded')
    const late = f.lease('late')
    f.receive(late)
    expect(late.release).toHaveBeenCalledOnce()
  })
  it('requires increasing viewport versions and reports a viewport the Host refuses', async () => {
    const f = fixture()
    expect(() => f.channel.setViewport(viewport(0))).toThrow('must increase')
    f.bridge.setViewport.mockResolvedValueOnce({ applied: false, reason: 'stale-viewport', currentVersion: 3 })
    await expect(f.channel.setViewport(viewport(1))).rejects.toThrow('must increase')
    expect(() => f.channel.setViewport(viewport(1))).toThrow('must increase')
  })
  it('sends the next viewport after one the producer did not acknowledge, and becomes ready with it', async () => {
    const f = fixture()
    const unacknowledged = Promise.withResolvers<FrameViewportResult>()
    f.bridge.setViewport.mockReturnValueOnce(unacknowledged.promise)
    const timedOut = f.channel.setViewport(viewport(1))
    const resized = f.channel.setViewport(viewport(2))
    unacknowledged.reject(new Error('Native producer acknowledgement timed out'))
    await expect(timedOut).rejects.toThrow('timed out')
    await resized
    expect(f.bridge.setViewport.mock.calls.map(([, sent]) => sent.version)).toEqual([1, 2])
    const ready = f.channel.ready()
    f.state(connected(1, 2))
    expect(await ready).toBe(1)
  })
  it('sends no queued viewport after close, so a reconnected consumer keeps the viewport it set', async () => {
    const f = fixture()
    const acknowledged = Promise.withResolvers<FrameViewportResult>()
    f.bridge.setViewport.mockReturnValueOnce(acknowledged.promise)
    const sent = f.channel.setViewport(viewport(1))
    const hidden = f.channel.setViewport({ ...viewport(2), visible: false }).catch((error: unknown) => error)
    await vi.waitFor(() => { expect(f.bridge.setViewport).toHaveBeenCalledOnce() })
    await f.channel.close()
    acknowledged.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    await sent
    expect(reason(await hidden)).toBe('closed')
    expect(f.bridge.setViewport.mock.calls.map(([, queued]) => queued.version)).toEqual([1])
  })
})

describe('continuous frames', () => {
  it('presents the newest frame next and holds at most one waiting frame behind a slow consumer', async () => {
    const f = fixture()
    const painting = Promise.withResolvers<undefined>()
    const presented: string[] = []
    f.channel.consume(async (frame) => {
      presented.push(frame.metadata.requestId)
      if (presented.length === 1) await painting.promise
    }, vi.fn())
    const first = f.lease('first')
    f.receive(first)
    const arrivals = Array.from({ length: 20 }, (_, index) => f.lease(String(index)))
    for (const lease of arrivals) f.receive(lease)
    const held = [first, ...arrivals].filter(lease => lease.release.mock.calls.length === 0)
    expect(held).toEqual([first, arrivals[19]])
    painting.resolve(undefined)
    await vi.waitFor(() => { expect(arrivals[19]!.release).toHaveBeenCalledOnce() })
    expect(presented).toEqual(['first', '19'])
    expect(first.release).toHaveBeenCalledOnce()
  })
  it('releases the waiting frame on unsubscribe and the presented one only after its callback settles', async () => {
    const f = fixture()
    const painting = Promise.withResolvers<undefined>()
    const remove = f.channel.consume(() => painting.promise, vi.fn())
    const active = f.lease('active'), waiting = f.lease('waiting')
    f.receive(active)
    f.receive(waiting)
    remove(); remove()
    expect(waiting.release).toHaveBeenCalledOnce()
    expect(active.release).not.toHaveBeenCalled()
    const replacement = vi.fn()
    const detach = f.channel.consume(replacement, vi.fn())
    const next = f.lease('replacement')
    f.receive(next)
    expect(replacement).not.toHaveBeenCalled()
    painting.resolve(undefined)
    await vi.waitFor(() => { expect(active.release).toHaveBeenCalledOnce() })
    expect(replacement).toHaveBeenCalledExactlyOnceWith({ image: next.frame, metadata: next.metadata })
    expect(next.release).toHaveBeenCalledOnce()
    detach()
    const after = f.lease('after')
    f.receive(after)
    expect(after.release).toHaveBeenCalledOnce()
  })
  it('reports consumer errors, contains failure-listener exceptions, and keeps presenting later frames', async () => {
    const f = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = vi.fn(() => { throw new Error('listener failed') })
    const paint = vi.fn<() => void>().mockImplementationOnce(() => { throw 'paint failed' })
      .mockImplementationOnce(() => { throw new Error('canvas lost') })
    f.channel.consume(paint, failure)
    const first = f.lease('first')
    f.receive(first)
    await vi.waitFor(() => { expect(first.release).toHaveBeenCalledOnce() })
    expect(failure).toHaveBeenCalledWith(new Error('paint failed'))
    const second = f.lease('second')
    f.receive(second)
    await vi.waitFor(() => { expect(second.release).toHaveBeenCalledOnce() })
    expect(failure).toHaveBeenLastCalledWith(new Error('canvas lost'))
    f.event({ kind: 'failure', error: 'consumer exploded' })
    expect(failure).toHaveBeenLastCalledWith(new Error('consumer exploded'))
    expect(log).toHaveBeenCalledTimes(3)
    log.mockRestore()
  })
  it('allows one stream consumer at a time', () => {
    const f = fixture()
    const remove = f.channel.consume(vi.fn(), vi.fn())
    expect(() => f.channel.consume(vi.fn(), vi.fn())).toThrow('already has a frame consumer')
    remove()
  })
})

describe('channel event subscriptions', () => {
  it('replays known state and content without replaying historical errors', () => {
    const f = fixture()
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
    f.event({ kind: 'error', connectionId: 1 as FrameConnectionId, source: 'producer', error: 'earlier' })
    const seen: FrameRxEvent[] = []
    f.channel.onEvent(event => seen.push(event))
    expect(seen).toEqual([
      { kind: 'state', channel: connected(1) },
      { kind: 'content', submittedGeneration: undefined },
    ])
    log.mockRestore()
  })
  it('does not synthesize channel state before it is known', () => {
    const f = fixture(null)
    const seen: FrameRxEvent[] = []
    f.channel.onEvent(event => seen.push(event))
    expect(seen).toEqual([{ kind: 'content', submittedGeneration: undefined }])
  })
  it('isolates subscriptions including repeated listener identity, exceptions and idempotent disposal', () => {
    const f = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = f.channel.onEvent(() => { throw new Error('event listener failed') })
    const listener = vi.fn()
    const first = f.channel.onEvent(listener)
    const second = f.channel.onEvent(listener)
    listener.mockClear()
    first(); first()
    f.state({ state: 'idle' })
    expect(listener).toHaveBeenCalledExactlyOnceWith({ kind: 'state', channel: { state: 'idle' } })
    expect(log).toHaveBeenCalledWith('Native channel event listener failed', expect.objectContaining({ message: 'event listener failed' }))
    second(); second(); throwing()
    f.state(connected(1, 1))
    expect(listener).toHaveBeenCalledOnce()
    log.mockRestore()
  })
  it('delivers all event kinds in arrival order to every observer, including reentrant events', () => {
    const f = fixture()
    const first: FrameRxEvent[] = [], second: FrameRxEvent[] = []
    const staleError = { kind: 'error', connectionId: 9 as FrameConnectionId, source: 'producer', error: 'other connection' } as const
    f.channel.onEvent((event) => {
      first.push(event)
      if (event.kind === 'content' && event.submittedGeneration === 3) f.event(staleError)
    })
    f.channel.onEvent(event => second.push(event))
    first.length = 0; second.length = 0
    const content = { kind: 'content', submittedGeneration: 3 } as const
    f.event(content)
    const failure = { kind: 'failure', error: 'Client disposed' } as const
    f.event(failure)
    expect(first).toEqual([content, staleError, failure])
    expect(second).toEqual(first)
  })
  it('replays a reentrant subscription after previously queued state changes', () => {
    const f = fixture()
    const late: FrameRxEvent[] = []
    f.channel.onEvent((event) => {
      if (event.kind !== 'content' || event.submittedGeneration !== 3) return
      f.state(connected(1, 3))
      f.channel.onEvent(value => late.push(value))
    })
    f.event({ kind: 'content', submittedGeneration: 3 })
    expect(late).toEqual([{ kind: 'state', channel: connected(1, 3) }, { kind: 'content', submittedGeneration: 3 }])
  })
  it.each(['closed', 'lost', 'failed', 'disposed'] as const)('ends subscriptions after %s and ignores late events', (cause) => {
    const f = fixture()
    const listener = vi.fn()
    const remove = f.channel.onEvent(listener)
    listener.mockClear()
    const terminal: FrameRxEvent = cause === 'disposed' ? { kind: 'failure', error: 'Client disposed' }
      : { kind: 'state', channel: { state: 'closed', cause, reason: 'ended' } }
    f.event(terminal)
    expect(listener).toHaveBeenCalledExactlyOnceWith(terminal)
    f.state(connected(1, 2))
    const late = vi.fn()
    f.channel.onEvent(late)()
    remove(); remove()
    expect(listener).toHaveBeenCalledOnce()
    expect(late).not.toHaveBeenCalled()
  })
  it('reports local closure once, including reentrant close from a terminal listener', async () => {
    const f = fixture()
    const first: FrameRxEvent[] = [], second: FrameRxEvent[] = []
    let reentrant: Promise<void> | undefined
    f.channel.onEvent((event) => {
      first.push(event)
      if (event.kind === 'state' && event.channel.state === 'closed') reentrant = f.channel.close()
    })
    f.channel.onEvent(event => second.push(event))
    first.length = 0; second.length = 0
    const closed = f.channel.close()
    await closed
    expect(reentrant).toBe(closed)
    expect(f.detach).toHaveBeenCalledOnce()
    expect(first).toEqual([{ kind: 'state', channel: { state: 'closed', cause: 'closed', reason: 'Native channel closed.' } }])
    expect(second).toEqual(first)
    f.event({ kind: 'content', submittedGeneration: 5 })
    expect(second).toEqual(first)
  })
  it('stops initial replay when its listener closes the channel', async () => {
    const f = fixture()
    const events: FrameRxEvent[] = []
    let closing: Promise<void> | undefined
    f.channel.onEvent((event) => {
      events.push(event)
      if (event.kind === 'state' && event.channel.state === 'connected') closing = f.channel.close()
    })
    await closing
    expect(events).toEqual([
      { kind: 'state', channel: connected(1) },
      { kind: 'state', channel: { state: 'closed', cause: 'closed', reason: 'Native channel closed.' } },
    ])
    expect(f.detach).toHaveBeenCalledOnce()
  })
})

it('exposes and replays the latest viewport while ordering reentrant viewport requests', async () => {
  const f = fixture()
  expect(f.channel.viewport).toBeUndefined()
  let nested: Promise<void> | undefined
  const events: FrameRxEvent[] = []
  f.channel.onEvent((event) => {
    events.push(event)
    if (event.kind === 'viewport' && event.viewport.version === 1) {
      expect(f.bridge.setViewport).not.toHaveBeenCalled()
      expect(f.channel.viewport).toEqual(viewport(1))
      nested = f.channel.setViewport(viewport(2))
    }
  })
  await f.channel.setViewport(viewport(1)); await nested
  expect(f.bridge.setViewport.mock.calls.map(call => call[1].version)).toEqual([1, 2])
  expect(f.channel.viewport).toEqual(viewport(2))
  const replay: FrameRxEvent[] = []
  f.channel.onEvent(event => replay.push(event))
  expect(replay.map(event => event.kind)).toEqual(['state', 'viewport', 'content'])
  expect(replay[1]).toEqual({ kind: 'viewport', viewport: viewport(2) })
  expect(events.filter(event => event.kind === 'viewport').map(event => event.viewport.version)).toEqual([1, 2])
})

it('delivers each track write, coalesces consecutive clears and replays only the latest submission', () => {
  const f = fixture()
  const seen: FrameRxEvent[] = [], write = { kind: 'content', submittedGeneration: 2 } as const
  const clear = { kind: 'content', submittedGeneration: undefined } as const
  let reentered = false
  f.channel.onEvent((event) => {
    seen.push(event)
    if (event.kind === 'content' && event.submittedGeneration === 2 && !reentered) {
      reentered = true
      f.event(write)
    }
  })
  f.event(clear)
  f.event(write)
  f.event(write)
  expect(seen.filter(event => event.kind === 'content')).toEqual([clear, write, write, write])
  const replay: FrameRxEvent[] = []
  f.channel.onEvent(event => replay.push(event))
  expect(replay.filter(event => event.kind === 'content')).toEqual([write])
  f.event(clear)
  f.event(clear)
  expect(replay.filter(event => event.kind === 'content')).toEqual([write, clear])
})

it('requires a mount for visibility and content setters', () => {
  const f = fixture()
  expect(() => { f.channel.setVisible(false) }).toThrow('Frame visibility requires mount.')
  expect(() => { f.channel.setContentView({ x: 0, y: 0, scale: 1 }) }).toThrow('Frame content requires mount.')
  expect(() => { f.channel.setContentView(undefined) }).toThrow('Frame content requires mount.')
  expect(() => f.channel.setContentWindow({ x: 0, y: 0, width: 1, height: 1 })).toThrow('Frame content requires mount.')
})

it('applies bridge viewport announcements and replays them to later subscribers', () => {
  const f = fixture()
  f.event({ kind: 'viewport', viewport: viewport(7) })
  expect(f.channel.viewport).toEqual(viewport(7))
  const seen: FrameRxEvent[] = []
  f.channel.onEvent(event => seen.push(event))
  expect(seen).toContainEqual({ kind: 'viewport', viewport: viewport(7) })
})

it('skips an event listener removed by an earlier listener in the same delivery', () => {
  const f = fixture()
  let remove = () => {}
  f.channel.onEvent((event) => { if (event.kind === 'content' && event.submittedGeneration === 4) remove() })
  const later = vi.fn()
  remove = f.channel.onEvent(later)
  later.mockClear()
  f.event({ kind: 'content', submittedGeneration: 4 })
  expect(later).not.toHaveBeenCalled()
})

it('does not apply queued state announcements after reentrant close', async () => {
  const f = fixture()
  let closing: Promise<void> | undefined
  f.channel.onEvent((event) => {
    if (event.kind !== 'content' || event.submittedGeneration !== 4) return
    f.state(connected(1, 4))
    closing = f.channel.close()
  })
  f.event({ kind: 'content', submittedGeneration: 4 })
  await closing
  expect(f.channel.connectionId).toBeUndefined()
  await expect(f.channel.closed).resolves.toBe('closed')
})

it('releases a queued stream frame on viewport change while retaining the running frame', async () => {
  const f = fixture()
  const writing = Promise.withResolvers<undefined>()
  const present = vi.fn(() => writing.promise)
  f.channel.consume(present, vi.fn())
  const first = f.lease(''), queued = f.lease('')
  try {
    f.receive(first); f.receive(queued)
    await f.channel.setViewport(viewport(1))
    expect(queued.release).toHaveBeenCalledOnce()
    expect(first.release).not.toHaveBeenCalled()
  } finally {
    writing.resolve(undefined)
    await f.channel.close()
  }
  expect(first.release).toHaveBeenCalledOnce()
  expect(present).toHaveBeenCalledOnce()
})
