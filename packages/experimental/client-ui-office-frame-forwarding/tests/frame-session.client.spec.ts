// @vitest-environment jsdom
/** Office mount ownership and stream deadlines are independent of the frame transport. */
import { afterEach, expect, test, vi } from 'vitest'
import type { FrameRx, FrameRxEvent } from '@deepseek-ai/dsh-frame-forwarding/client'
import { FrameDiscardedError } from '@deepseek-ai/dsh-frame-forwarding/src/client/errors.ts'
import type { FrameConnectionId, FrameForwardingViewport } from '@deepseek-ai/dsh-frame-forwarding/types'
import type { OfficeDocumentId } from '../src/types.ts'
import { brandString, brandNumber } from '@deepseek-ai/dsh-brand'
import { FrameForwardingOfficeSession } from '../src/client/frame-forwarding.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const documentId = brandString<OfficeDocumentId>('doc')
const viewport = (version = 1, visible = true): FrameForwardingViewport => ({
  version, visible, width: 800, height: 500, deviceScaleFactor: 1 })
function fixture() {
  const listeners = new Set<(event: FrameRxEvent) => void>()
  let current: FrameForwardingViewport | undefined
  let replay: FrameRxEvent = { kind: 'state', channel: { state: 'idle' } }
  const detach = vi.fn(), failure = vi.fn(), waiting = vi.fn()
  const send = vi.fn(async (_value: object, _signal?: AbortSignal) => ({ documentId }))
  const rx = {
    get viewport() { return current },
    mount: vi.fn<FrameRx['mount']>(() => detach),
    onEvent: (listener: (event: FrameRxEvent) => void) => {
      listeners.add(listener); listener(replay); return () => { listeners.delete(listener) }
    },
    ready: vi.fn<FrameRx['ready']>(async () => brandNumber<FrameConnectionId>(1)), close: vi.fn(async () => {}),
    setVisible: vi.fn(),
    setContentView: vi.fn(),
  } satisfies Partial<FrameRx>
  const session = new FrameForwardingOfficeSession(rx as Partial<FrameRx> as FrameRx, 1000)
  const element = document.createElement('div')
  const emit = (event: FrameRxEvent) => {
    if (event.kind === 'viewport') current = event.viewport
    replay = event
    for (const listener of listeners) listener(event)
  }
  return { session, element, rx, detach, failure, waiting, send, emit, listeners,
    ready: () => { emit({ kind: 'viewport', viewport: viewport() }) } }
}

test('duplicate mounting rejects, failure detaches once, and a replacement can mount', async () => {
  const f = fixture(), error = new Error('presenter unavailable')
  try {
    f.session.setContentView({ x: 0, y: 0, scale: 1 }); expect(f.rx.setContentView).not.toHaveBeenCalled()
    const detach = f.session.mount(f.element, f.failure)
    expect(() => f.session.mount(f.element, f.failure)).toThrow('already has a mount')
    f.rx.mount.mock.calls[0]![1](error)
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(error)
    detach(); expect(f.detach).toHaveBeenCalledOnce()
    f.session.mount(f.element, f.failure)()
    expect(f.detach).toHaveBeenCalledTimes(2)
    f.rx.mount.mockImplementationOnce(() => { throw error })
    expect(() => f.session.mount(f.element, f.failure)).toThrow(error)
  } finally { await f.session.close() }
})

test('a synchronous mount failure releases Office ownership before the failure callback', async () => {
  const f = fixture(), error = new Error('mount unavailable')
  f.rx.mount.mockImplementationOnce((_element, failure) => { failure(error); return f.detach })
  try {
    f.session.mount(f.element, f.failure)()
    expect(f.failure).toHaveBeenCalledWith(error)
    f.session.mount(f.element, f.failure)()
  } finally { await f.session.close() }
})

test('a viewport wait keeps the lost mount error until the next mount', async () => {
  const f = fixture(), lost = new FrameDiscardedError('lost'), cancelled = AbortSignal.abort()
  try {
    f.session.mount(f.element, f.failure)
    await f.session.ready(cancelled)
    expect(f.listeners.size).toBe(0)
    expect(f.rx.ready).not.toHaveBeenCalled()
    const ready = f.session.ready()
    f.rx.mount.mock.calls[0]![1](lost)
    f.emit({ kind: 'state', channel: { state: 'closed', cause: 'lost', reason: 'frame lost' } })
    await expect(ready).rejects.toBe(lost)
    expect(f.listeners.size).toBe(0)
    // A terminated FrameRx no longer replays its closed event to new subscribers.
    const subscribe = vi.spyOn(f.rx, 'onEvent')
    await expect(f.session.ready(cancelled)).rejects.toBe(lost)
    expect(subscribe).not.toHaveBeenCalled()

    f.emit({ kind: 'state', channel: { state: 'idle' } })
    f.session.mount(f.element, f.failure)
    const remounted = f.session.ready()
    f.ready()
    await remounted
  } finally { await f.session.close() }
})

test('trim without a mount is inert, and a mounted trim toggles explicit visibility without losing hidden state', async () => {
  const f = fixture()
  try {
    f.session.setVisible(false); expect(f.rx.setVisible).not.toHaveBeenCalled()
    await f.session.trim(); expect(f.rx.ready).not.toHaveBeenCalled()
    f.session.mount(f.element, f.failure, true); f.ready()
    expect(f.rx.mount).toHaveBeenLastCalledWith(f.element, expect.any(Function), { visible: true })
    const trimmed = f.session.trim()
    expect(f.rx.setVisible).toHaveBeenLastCalledWith(false)
    f.emit({ kind: 'viewport', viewport: viewport(2, false) }); await trimmed
    expect(f.rx.setVisible).toHaveBeenLastCalledWith(true)
    const hiddenTrim = f.session.trim()
    f.session.setVisible(false)
    f.emit({ kind: 'viewport', viewport: viewport(3, false) }); await hiddenTrim
    expect(f.rx.setVisible).toHaveBeenLastCalledWith(false)
  } finally { await f.session.close() }
})

test.each(['timeout', 'failure', 'closed', 'replay'] as const)('readiness rejects on %s without retaining its listener', async (cause) => {
  vi.useFakeTimers()
  const f = fixture(), { signal } = new AbortController()
  const added = vi.spyOn(signal, 'addEventListener'), removed = vi.spyOn(signal, 'removeEventListener')
  const event: FrameRxEvent = cause === 'failure' ? { kind: 'failure', error: 'mount failed' }
    : { kind: 'state', channel: { state: 'closed', cause: 'closed', reason: 'released' } }
  if (cause === 'replay') f.emit(event)
  const ready = f.session.ready(signal), failed = expect(ready).rejects.toThrow(cause === 'timeout' ? 'viewport timed out' : 'mount closed')
  try {
    if (cause === 'timeout') await vi.advanceTimersByTimeAsync(1000)
    else if (cause !== 'replay') f.emit(event)
    await failed
    expect(removed).toHaveBeenCalledExactlyOnceWith('abort', added.mock.calls[0]![1])
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally { await f.session.close() }
})

test('retiring a mount while trim waits for an invisible viewport restores visibility and skips producer readiness', async () => {
  vi.useFakeTimers()
  const f = fixture(), lifetime = new AbortController()
  try {
    f.session.mount(f.element, f.failure); f.ready()
    const trimmed = f.session.trim(lifetime.signal)
    expect(f.rx.setVisible).toHaveBeenLastCalledWith(false)
    lifetime.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listeners.size).toBe(0)
    await trimmed
    expect(f.rx.setVisible).toHaveBeenLastCalledWith(true)
    expect(f.rx.ready).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally { await f.session.close() }
})

test.each(['before-ready', 'during-send', 'loaded'] as const)('%s avoids a first-image timeout and stop is idempotent', async (phase) => {
  vi.useFakeTimers()
  const f = fixture(), sent = Promise.withResolvers<undefined>(), accepted = Promise.withResolvers<undefined>()
  f.send.mockImplementationOnce(async () => { sent.resolve(undefined); await accepted.promise; return { documentId } })
  const stream = f.session.startPlayback(f.element, f.send, f.failure, f.waiting)
  let stopping: Promise<void> | undefined
  try {
    if (phase === 'before-ready') stopping = stream.stop()
    f.ready()
    if (phase !== 'before-ready') await sent.promise
    if (phase === 'during-send') stopping = stream.stop()
    if (phase === 'loaded') f.element.dispatchEvent(new Event('loadeddata'))
    accepted.resolve(undefined); await stream.ready; await stopping
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.waiting).not.toHaveBeenCalledWith(true)
    const stopped = stream.stop(); expect(stream.stop()).toBe(stopped); await stopped
    await stream.resize(640, 360)
    expect(f.send.mock.calls.some(([value]) => (value as { action: string }).action === 'resize')).toBe(false)
  } finally { accepted.resolve(undefined); await stream.stop(); await f.session.close() }
})

test('stopping before the first slideshow viewport releases its wait at the current clock tick', async () => {
  vi.useFakeTimers()
  const f = fixture(), stream = f.session.startPlayback(f.element, f.send, f.failure, f.waiting)
  try {
    expect(f.listeners.size).toBe(1)
    const stopped = stream.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await Promise.all([stopped, stream.ready])
    expect(f.rx.ready).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.failure).not.toHaveBeenCalled()
  } finally { await f.session.close() }
})

test('stopping while the producer acknowledges the slideshow viewport cancels readiness', async () => {
  vi.useFakeTimers()
  const f = fixture(), entered = Promise.withResolvers<AbortSignal>(), ack = Promise.withResolvers<FrameConnectionId>()
  f.rx.ready.mockImplementationOnce((signal) => {
    entered.resolve(signal!)
    signal!.addEventListener('abort', () => { ack.reject(new FrameDiscardedError('cancelled')) }, { once: true })
    return ack.promise
  })
  const stream = f.session.startPlayback(f.element, f.send, f.failure, f.waiting)
  try {
    f.ready()
    const signal = await entered.promise
    const stopped = stream.stop()
    expect(signal.aborted).toBe(true)
    await Promise.all([stopped, stream.ready])
    expect(f.send).not.toHaveBeenCalled()
    expect(f.failure).not.toHaveBeenCalled()
  } finally { ack.resolve(brandNumber<FrameConnectionId>(1)); await f.session.close() }
})

test('a mount failure reported as playback stops retains its channel loss reason', async () => {
  const f = fixture(), lost = new FrameDiscardedError('lost')
  const stream = f.session.startPlayback(f.element, f.send, f.failure, f.waiting)
  try {
    f.rx.mount.mock.calls[0]![1](lost)
    const stopped = stream.stop()
    await expect(stream.ready).rejects.toBe(lost)
    await stopped
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(lost)
    expect(f.send).not.toHaveBeenCalled()
  } finally { await f.session.close() }
})

test('a missing first image reports waiting until loadeddata and close joins shutdown once', async () => {
  vi.useFakeTimers()
  const f = fixture(), stream = f.session.startPlayback(f.element, f.send, f.failure, f.waiting)
  try {
    f.ready(); await stream.ready
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.waiting).toHaveBeenLastCalledWith(true)
    f.element.dispatchEvent(new Event('loadeddata'))
    expect(f.waiting).toHaveBeenLastCalledWith(false)
    await stream.resize(640, 360)
    expect(f.send).toHaveBeenLastCalledWith({ action: 'resize', pixelWidth: 640, pixelHeight: 360 }, expect.any(AbortSignal))
    const close = f.session.close(); expect(f.session.close()).toBe(close); await close
    expect(f.rx.close).toHaveBeenCalledOnce()
    expect(f.send.mock.calls.some(([value]) => (value as { enabled?: boolean }).enabled === false)).toBe(false)
  } finally { await stream.stop(); await f.session.close() }
})

test('a rejected stream start remains joinable by stop', async () => {
  const f = fixture(), failure = new Error('stream refused')
  f.send.mockRejectedValueOnce(failure)
  const stream = f.session.startPlayback(f.element, f.send, f.failure, f.waiting)
  const rejected = expect(stream.ready).rejects.toBe(failure)
  try { f.ready(); await rejected; await stream.stop() }
  finally { await f.session.close() }
})
