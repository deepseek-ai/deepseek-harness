// @vitest-environment jsdom
/** Mounted presentation and observer races without a GPU or browser layout engine. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FrameConnectionId, FrameRxId } from '../src/types.ts'
import type { FrameForwardingBridge, FrameForwardingFrameLease, FrameRxEvent } from '../src/client/api.ts'
import { FrameRx } from '../src/client/rx.ts'
import vectors from './fixtures/content-vectors.json'
import { createMediaPresenter } from '../src/client/presenters.ts'
import { mountElement } from '../src/client/element-mount.ts'

const displays = new Set<{ dispose(): void }>()
const channels = new Set<FrameRx>()
let rafs: Map<number, FrameRequestCallback>
let nextRaf: number
let resized: () => void
let intersected: (entries: Partial<IntersectionObserverEntry>[]) => void
let observerStops: ReturnType<typeof vi.fn>[]
let writer: {
  write: ReturnType<typeof vi.fn<(frame: VideoFrame) => Promise<void>>>
  abort: ReturnType<typeof vi.fn<() => Promise<void>>>
}
let trackStops: ReturnType<typeof vi.fn>[]

beforeEach(() => {
  rafs = new Map(); nextRaf = 0; observerStops = []; trackStops = []
  writer = { write: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { rafs.set(++nextRaf, callback); return nextRaf })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { rafs.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    constructor(callback: () => void) { resized = callback; observerStops.push(this.disconnect) }
    observe() {}
  })
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn()
    constructor(callback: typeof intersected) { intersected = callback; observerStops.push(this.disconnect) }
    observe() {}
  })
  vi.stubGlobal('MediaStreamTrackGenerator', class {
    writable = { getWriter: () => writer }
    stop = vi.fn()
    constructor() { trackStops.push(this.stop) }
  })
  vi.stubGlobal('MediaStream', vi.fn(function MediaStream() { return { active: true } }))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(async () => {
  for (const display of displays) display.dispose()
  displays.clear()
  await Promise.all([...channels].map(channel => channel.close()))
  channels.clear()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function tick() {
  await Promise.resolve()
  const callbacks = [...rafs.values()]
  rafs.clear()
  for (const callback of callbacks) callback(0)
  await Promise.resolve()
  await Promise.resolve()
}
function box(element: Element, x = 10, y = 20, width = 100, height = 80) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) })
}
function frameImage() {
  return {
    codedWidth: 100, codedHeight: 80, codedRect: null, displayWidth: 100, displayHeight: 80,
    duration: null, format: 'RGBA', timestamp: 0, visibleRect: null,
    colorSpace: { fullRange: null, matrix: null, primaries: null, transfer: null, toJSON: () => ({}) },
    allocationSize: () => 100 * 80 * 4, copyTo: async () => [],
    clone: (): VideoFrame => frameImage(), close: vi.fn(),
  } satisfies VideoFrame
}
function fixture(connected = true) {
  const slot = document.createElement('div')
  const element = document.createElement('div')
  slot.append(element); document.body.append(slot); box(element)
  let arrive: (lease: FrameForwardingFrameLease) => void = () => {}
  let event: (event: FrameRxEvent) => void = () => {}
  const bridge = {
    setViewport: vi.fn<FrameForwardingBridge['setViewport']>(async () => ({ applied: true, connectionId: 1 as FrameConnectionId })),
    attach(_rx, { onFrame, onEvent }) {
      arrive = onFrame
      event = onEvent
      if (connected) event({ kind: 'state', channel: { state: 'connected', connectionId: 1 as FrameConnectionId } })
      return () => {}
    },
    apply: vi.fn(), fail: vi.fn(), dispose: vi.fn(),
  } satisfies FrameForwardingBridge
  const channel = new FrameRx('rx' as FrameRxId, bridge)
  channels.add(channel)
  const failure = vi.fn()
  const visible = () =>{  intersected([{ target: element, isIntersecting: true }]) }
  const frame = () => {
    const copy = frameImage()
    const image = { ...frameImage(), clone: vi.fn(() => copy) }
    const lease = { frame: image,
      metadata: { rx: channel.rx, connectionId: 1 as FrameConnectionId, requestId: '', frameId: 1, revision: 1,
        generation: bridge.setViewport.mock.calls.at(-1)?.[1].version ?? 0, width: 100, height: 80 },
      release: vi.fn() } satisfies FrameForwardingFrameLease
    return { lease, copy }
  }
  return { slot, element, channel, bridge, failure, visible, frame,
    arrive: (lease: FrameForwardingFrameLease) => { arrive(lease) }, event: (value: FrameRxEvent) => { event(value) } }
}

const contentView = { x: 0, y: 0, scale: 1 }
const contentWindow = { x: 0, y: 0, width: 200, height: 160 }

describe('video mount', () => {
  it('mounts a reopened receive channel before the first state arrives and uses the retained Host generation', async () => {
    const f = fixture(false)
    let retained = 0
    f.bridge.setViewport.mockImplementation(async (_rx, viewport) => {
      if (viewport.version <= retained) return { applied: false, reason: 'stale-viewport', currentVersion: retained }
      retained = viewport.version
      return { applied: false, reason: 'no-producer' }
    })
    await f.channel.setViewport({ version: 7, width: 20, height: 20, deviceScaleFactor: 1, visible: true })
    await f.channel.close()
    const reopened = new FrameRx(f.channel.rx, f.bridge)
    channels.add(reopened)
    reopened.mount(f.element, f.failure)
    reopened.setContentView(contentView)
    let nextWindow: Promise<NonNullable<FrameRx['viewport']>> | undefined
    reopened.onEvent((event) => {
      if (event.kind === 'viewport' && event.viewport.version === 8) {
        nextWindow = reopened.setContentWindow({ ...contentWindow, y: 100 })
      }
    })
    const viewport = await reopened.setContentWindow(contentWindow)
    expect(viewport.version).toBe(8)
    await expect(nextWindow).resolves.toMatchObject({ version: 9 })
    expect(f.bridge.setViewport.mock.calls.map(([, value]) => value.version)).toEqual([7, 1, 8, 9])
    f.event({ kind: 'state', channel: { state: 'connected', connectionId: 1 as FrameConnectionId, viewportVersion: retained } })
    await expect(reopened.ready()).resolves.toBe(1)
    expect(f.failure).not.toHaveBeenCalled()
  })

  it('rejects duplicate element mounting without removing the active owner', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure)
    await tick()
    const other = fixture()
    expect(() => other.channel.mount(f.element, other.failure)).toThrow('frame consumer')
    expect(f.element.getAttribute('data-dsh-frame-mount')).toBe('video')
    f.event({ kind: 'state', channel: { state: 'closed', cause: 'lost', reason: 'Host exited' } })
    expect(f.element.hasAttribute('data-dsh-frame-mount')).toBe(false)
    expect(f.failure).toHaveBeenCalledOnce()
  })
  it('creates the video display before a window request sends the first viewport, so its frame is shown', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure)
    f.visible()
    f.channel.setContentView(contentView)
    // The window request runs before the mount's first animation frame and sends the first viewport itself.
    const request = f.channel.setContentWindow(contentWindow)
    await vi.waitFor(() => { expect(f.bridge.setViewport).toHaveBeenCalledOnce() })
    const { lease } = f.frame()
    f.arrive(lease)
    await request
    await vi.waitFor(() => { expect(writer.write).toHaveBeenCalledOnce() })
  })
  it('lends video frames until the writer settles and stops the track on unmount', async () => {
    const f = fixture()
    const write = Promise.withResolvers<undefined>()
    writer.write.mockReturnValue(write.promise)
    const unmount = f.channel.mount(f.element, f.failure); await tick()
    const { lease, copy } = f.frame(); f.arrive(lease)
    expect(lease.release).not.toHaveBeenCalled()
    unmount(); expect(trackStops[0]).toHaveBeenCalledOnce()
    write.resolve(undefined); await tick()
    expect(copy.close).toHaveBeenCalledOnce()
    expect(lease.release).toHaveBeenCalledOnce()
    expect(writer.abort).toHaveBeenCalledOnce()
  })
  it('cleans up and reports a lost channel, including an explicit local close', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.event({ kind: 'state', channel: { state: 'closed', cause: 'lost', reason: 'GPU stopped' } })
    expect(trackStops[0]).toHaveBeenCalledOnce()
    expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'lost' }))
    await f.channel.close()
    expect(f.failure).toHaveBeenCalledOnce()
  })
  it('keeps mounted and continuous consumption exclusive', () => {
    const f = fixture()
    const unmount = f.channel.mount(f.element, f.failure)
    expect(() => f.channel.mount(f.element, f.failure)).toThrow('frame consumer')
    expect(() => f.channel.consume(() => {}, f.failure)).toThrow('frame consumer')
    unmount()
    unmount()
    const consume = f.channel.consume(() => {}, f.failure)
    expect(() => f.channel.mount(f.element, f.failure)).toThrow('frame consumer')
    consume()
  })
  it('sends a final hidden update without rAF and restores visibility on the next frame', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); f.visible(); await tick(); await tick()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve(); await Promise.resolve()
    expect(f.bridge.setViewport.mock.calls.at(-1)?.[1].visible).toBe(false)
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'))
    await tick(); await tick()
  })
  it('queues an invisible viewport between a pending visible mount and its replacement', async () => {
    const f = fixture()
    const ack = Promise.withResolvers<Awaited<ReturnType<FrameForwardingBridge['setViewport']>>>()
    f.bridge.setViewport.mockReturnValueOnce(ack.promise)
    const detach = f.channel.mount(f.element, f.failure)
    f.visible(); await tick()
    const first = f.bridge.setViewport.mock.calls[0]![1]
    expect(first.visible).toBe(true)
    detach()
    detach()
    f.channel.mount(f.element, f.failure)
    f.visible(); await tick()
    expect(f.bridge.setViewport).toHaveBeenCalledTimes(1)
    ack.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    await vi.waitFor(() => {
      expect(f.bridge.setViewport.mock.calls.map(([, viewport]) => viewport)).toEqual([
        first, { ...first, version: first.version + 1, visible: false }, { ...first, version: first.version + 2 },
      ])
    })
    await f.channel.close()
    detach()
    expect(f.bridge.setViewport).toHaveBeenCalledTimes(3)
  })
  it.each(['close', 'replace'] as const)('respects a reentrant %s when the displayed frame is cleared', async (action) => {
    const f = fixture()
    const detach = f.channel.mount(f.element, f.failure)
    f.visible(); await tick()
    const viewport = f.channel.viewport!
    const { lease } = f.frame()
    f.arrive(lease)
    await vi.waitFor(() => { expect(lease.release).toHaveBeenCalledOnce() })
    let completion: Promise<void> | undefined
    f.channel.onEvent((event) => {
      if (event.kind === 'content' && event.submittedGeneration === undefined) {
        completion = action === 'close' ? f.channel.close() : f.channel.setViewport({ ...viewport, version: 10 })
      }
    })
    detach()
    await completion
    const sent = f.bridge.setViewport.mock.calls.map(([, value]) => value)
    expect(sent).toEqual(action === 'close' ? [viewport] : [viewport, { ...viewport, version: 10 }])
  })
  it('logs when an unmount viewport is refused without failing the mount', async () => {
    const f = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const detach = f.channel.mount(f.element, f.failure)
    f.visible(); await tick()
    f.bridge.setViewport.mockRejectedValueOnce(new Error('refused'))
    detach()
    await vi.waitFor(() => { expect(f.bridge.setViewport).toHaveBeenCalledTimes(2) })
    expect(log).toHaveBeenCalledWith('Frame unmount viewport failed', expect.any(Error))
    expect(f.failure).not.toHaveBeenCalled()
  })
  it('sends no queued unmount viewport after the channel closes', async () => {
    const f = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ack = Promise.withResolvers<Awaited<ReturnType<FrameForwardingBridge['setViewport']>>>()
    f.bridge.setViewport.mockReturnValueOnce(ack.promise)
    const detach = f.channel.mount(f.element, f.failure)
    f.visible(); await tick()
    detach()
    await f.channel.close()
    ack.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    await tick(); await tick()
    expect(f.bridge.setViewport).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
  })
  it('coalesces viewport changes while an acknowledgement is pending', async () => {
    const f = fixture()
    const ack = Promise.withResolvers<Awaited<ReturnType<FrameForwardingBridge['setViewport']>>>()
    f.bridge.setViewport.mockReturnValueOnce(ack.promise)
    f.channel.mount(f.element, f.failure); await tick()
    box(f.element, 0, 0, 150, 100); resized(); await tick()
    box(f.element, 0, 0, 250, 200); resized(); await tick()
    expect(f.bridge.setViewport).toHaveBeenCalledOnce()
    ack.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    await tick(); await tick(); await tick()
    expect(f.bridge.setViewport).toHaveBeenCalledTimes(2)
    expect(f.bridge.setViewport.mock.calls[1]?.[1].width).toBe(250)
  })
  it('queues reanchors behind mount updates and omits coalesced windows from previous', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.channel.setContentView(contentView)
    await f.channel.setContentWindow(contentWindow)
    const acknowledgement = Promise.withResolvers<Awaited<ReturnType<FrameForwardingBridge['setViewport']>>>()
    f.bridge.setViewport.mockReturnValueOnce(acknowledgement.promise)
    box(f.element, 0, 0, 200, 200); resized(); await tick()
    const skipped = f.channel.setContentWindow({ ...contentWindow, y: 100 })
    const latestWindow = { ...contentWindow, y: 200 }
    const latest = f.channel.setContentWindow(latestWindow)
    expect(latest).toBe(skipped)
    expect(f.bridge.setViewport.mock.calls.at(-1)?.[1].version).toBe(3)
    acknowledgement.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    expect((await latest).version).toBe(4)
    expect(await skipped).toEqual(await latest)
    expect(f.bridge.setViewport.mock.calls.map(call => call[1].version)).toEqual([1, 2, 3, 4])
  })
  it('keeps a reentrant newer window request ahead of an unchanged retry', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.channel.setContentView(contentView)
    let nested: Promise<NonNullable<FrameRx['viewport']>> | undefined
    f.channel.onEvent((event) => {
      if (event.kind === 'viewport' && event.viewport.version === 2) nested = f.channel.setContentWindow({ ...contentWindow, y: 200 })
    })
    await f.channel.setContentWindow(contentWindow)
    const retry = f.channel.setContentWindow({ ...contentWindow, y: 200 })
    expect(retry).toBe(nested)
    expect((await retry).version).toBe(3)
  })
  it('rejects invalid values synchronously without changing state or sending messages', async () => {
    const f = fixture()
    const unmount = f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.channel.setContentView(contentView)
    await f.channel.setContentWindow(contentWindow)
    const versions = f.bridge.setViewport.mock.calls.length
    for (const value of [NaN, Infinity, -Infinity, 2 ** 24 + 1]) {
      expect(() => { f.channel.setContentView({ ...contentView, x: value }) }).toThrow(TypeError)
      expect(() => f.channel.setContentWindow({ ...contentWindow, y: value })).toThrow(TypeError)
    }
    expect(() => { f.channel.setContentView({ ...contentView, scale: 0 }) }).toThrow(TypeError)
    expect(() => f.channel.setContentWindow({ ...contentWindow, height: -1 })).toThrow(TypeError)
    await tick()
    expect(f.bridge.setViewport).toHaveBeenCalledTimes(versions)
    unmount()
    expect(() => f.channel.setContentWindow(contentWindow)).toThrow('Frame content requires mount.')
    expect(() => { f.channel.setContentView(contentView) }).toThrow('Frame content requires mount.')
  })
  it.each([
    ['a lost channel', { name: 'FrameDiscardedError', reason: 'lost' }],
    ['a failed channel', { message: 'receiver stopped' }],
    ['closing the channel', { name: 'FrameDiscardedError', reason: 'closed' }],
    ['unmounting', { name: 'FrameDiscardedError', reason: 'cancelled' }],
  ] as const)('rejects pending content calls with the error of %s and never sends their queued successor', async (ending, expected) => {
    const f = fixture()
    const unmount = f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.channel.setContentView(contentView)
    const acknowledgement = Promise.withResolvers<Awaited<ReturnType<FrameForwardingBridge['setViewport']>>>()
    f.bridge.setViewport.mockReturnValueOnce(acknowledgement.promise)
    const inFlight = f.channel.setContentWindow(contentWindow)
    const queued = f.channel.setContentWindow({ ...contentWindow, y: 100 })
    const settled = Promise.all([inFlight, queued].map(request => request.then(() => undefined, (error: unknown) => error)))
    await vi.waitFor(() => { expect(f.bridge.setViewport).toHaveBeenCalledTimes(2) })
    if (ending === 'a lost channel') f.event({ kind: 'state', channel: { state: 'closed', cause: 'lost', reason: 'GPU stopped' } })
    else if (ending === 'a failed channel') f.event({ kind: 'state', channel: { state: 'closed', cause: 'failed', reason: 'receiver stopped' } })
    else if (ending === 'closing the channel') await f.channel.close()
    else unmount()
    const [inFlightError, queuedError] = await settled
    expect(inFlightError).toMatchObject(expected)
    expect(queuedError).toBe(inFlightError)
    if (ending === 'unmounting') expect(f.failure).not.toHaveBeenCalled()
    else expect(f.failure).toHaveBeenCalledExactlyOnceWith(inFlightError)
    acknowledgement.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    await tick(); await tick()
    expect(f.bridge.setViewport).toHaveBeenCalledTimes(2)
  })
  it('rejects refused content viewports and stops mount resources before reporting failure', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.channel.setContentView(contentView)
    const refusal = new Error('viewport acknowledgement refused')
    f.bridge.setViewport.mockRejectedValueOnce(refusal)
    await expect(f.channel.setContentWindow(contentWindow)).rejects.toBe(refusal)
    expect(trackStops[0]).toHaveBeenCalledOnce()
    expect(f.failure).toHaveBeenCalledExactlyOnceWith(refusal)
    expect(() => f.channel.setContentWindow(contentWindow)).toThrow('Frame content requires mount.')
  })
  it.each(['the viewport refusal', 'the playback failure'] as const)('rejects a queued window request with %s that ended its mount', async (ending) => {
    const f = fixture()
    const playback = Promise.withResolvers<undefined>()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValueOnce(playback.promise)
    f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.channel.setContentView(contentView)
    const acknowledgement = Promise.withResolvers<Awaited<ReturnType<FrameForwardingBridge['setViewport']>>>()
    f.bridge.setViewport.mockReturnValueOnce(acknowledgement.promise)
    const inFlight = f.channel.setContentWindow(contentWindow)
    const queued = f.channel.setContentWindow({ ...contentWindow, y: 100 })
    const settled = Promise.all([inFlight, queued].map(request => request.then(() => undefined, (error: unknown) => error)))
    await vi.waitFor(() => { expect(f.bridge.setViewport).toHaveBeenCalledTimes(2) })
    try {
      if (ending === 'the playback failure') playback.reject(new Error('play denied'))
      else acknowledgement.reject(new Error('viewport acknowledgement refused'))
      const [inFlightError, queuedError] = await settled
      expect(inFlightError).toMatchObject(ending === 'the playback failure'
        ? { name: 'FrameFailureError', source: 'presentation', message: 'play denied' }
        : { message: 'viewport acknowledgement refused' })
      expect(queuedError).toBe(inFlightError)
      expect(f.failure).toHaveBeenCalledExactlyOnceWith(inFlightError)
      expect(f.bridge.setViewport).toHaveBeenCalledTimes(2)
    } finally {
      playback.resolve(undefined)
      acknowledgement.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    }
  })
  it('settles an unchanged-window wait when a resized mount closes before Host acknowledges', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); await tick(); await tick()
    f.channel.setContentView(contentView)
    await f.channel.setContentWindow(contentWindow)
    const acknowledgement = Promise.withResolvers<Awaited<ReturnType<FrameForwardingBridge['setViewport']>>>()
    f.bridge.setViewport.mockReturnValueOnce(acknowledgement.promise)
    box(f.element, 0, 0, 300, 200); resized(); await tick()
    const unchanged = f.channel.setContentWindow(contentWindow).catch((error: unknown) => error)
    await f.channel.close()
    const result = await Promise.race([unchanged, Promise.resolve('still waiting')])
    acknowledgement.resolve({ applied: true, connectionId: 1 as FrameConnectionId })
    await tick()
    expect(result).toMatchObject({ reason: 'closed' })
  })
  it('ignores late playback rejection after idempotent disposal and reports writer teardown failure', async () => {
    const f = fixture()
    const playback = Promise.withResolvers<undefined>()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValueOnce(playback.promise)
    const error = new Error('writer teardown refused')
    writer.abort.mockRejectedValueOnce(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const presenter = createMediaPresenter(f.element, f.failure, vi.fn())
    presenter.dispose(); presenter.dispose()
    playback.reject(new Error('late playback'))
    await tick()
    expect(f.failure).not.toHaveBeenCalled()
    expect(trackStops[0]).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('Frame video writer teardown failed', error)
  })
  it('resumes the same video after its tab is detached during playback startup', async () => {
    const f = fixture()
    const initial = Promise.withResolvers<undefined>()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockReturnValueOnce(initial.promise)
    f.channel.mount(f.element, f.failure)
    await tick()
    const video = f.element.querySelector('video')
    f.element.remove()
    initial.reject(new DOMException('removed from document', 'AbortError'))
    resized()
    await tick()
    expect(play).toHaveBeenCalledTimes(1)
    f.slot.append(f.element)
    f.visible()
    await tick()
    expect(play.mock.contexts.at(-1)).toBe(video)
    expect(play).toHaveBeenCalledTimes(2)
    vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false)
    resized()
    await tick()
    expect(play).toHaveBeenCalledTimes(2)
    expect(f.failure).not.toHaveBeenCalled()
  })

  it('stops the track and removes media when playback setup throws', () => {
    const f = fixture()
    const error = new Error('play setup failed')
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementationOnce(() => { throw error })
    expect(() => createMediaPresenter(f.element, f.failure, vi.fn())).toThrow(error)
    expect(trackStops[0]).toHaveBeenCalledOnce()
    expect(writer.abort).toHaveBeenCalledOnce()
    expect(f.element.children).toHaveLength(0)
  })
  it('rejects failed writes while closing the cloned frame', async () => {
    const f = fixture()
    const error = new Error('write failed')
    writer.write.mockRejectedValueOnce(error)
    const presenter = createMediaPresenter(f.element, f.failure, vi.fn())
    const { lease, copy } = f.frame()
    await expect(presenter.present({ image: lease.frame, metadata: lease.metadata })).rejects.toBe(error)
    expect(copy.close).toHaveBeenCalledOnce()
    presenter.dispose()
  })

  it('reports the generation accepted by the video track only after its write completes', async () => {
    const f = fixture()
    const events: FrameRxEvent[] = []
    f.channel.onEvent(event => events.push(event))
    const write = Promise.withResolvers<undefined>()
    writer.write.mockReturnValue(write.promise)
    const unmount = f.channel.mount(f.element, f.failure)
    f.visible(); await tick()
    const { lease } = f.frame()
    f.arrive(lease)
    const content = () => events.filter(event => event.kind === 'content').at(-1)
    expect(content()?.submittedGeneration).toBeUndefined()
    write.resolve(undefined)
    await tick()
    expect(content()?.submittedGeneration).toBe(lease.metadata.generation)
    unmount()
    expect(content()?.submittedGeneration).toBeUndefined()
  })

  it('keeps the submitted document rectangle while a resize frame is pending', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure)
    await tick()
    f.channel.setContentView(contentView)
    await f.channel.setContentWindow(contentWindow)
    f.arrive(f.frame().lease)
    await tick()
    const video = f.element.querySelector('video')!
    const write = Promise.withResolvers<undefined>()
    writer.write.mockReturnValueOnce(write.promise)
    await f.channel.setContentWindow({ ...contentWindow, y: 80, height: 40 })
    f.arrive(f.frame().lease)
    try {
      f.channel.setContentView({ ...contentView, y: 20 })
      await f.channel.setContentWindow({ ...contentWindow, y: 100 })
      await f.channel.setContentWindow({ ...contentWindow, y: 120 })
      await tick()
      expect(f.channel.submittedWindow).toMatchObject(contentWindow)
      expect(video.style.height).toBe('160px')
      expect(video.style.transform).toBe('translate(0px, -20px)')
      expect(video.style.objectFit).toBe('contain')
    } finally { write.resolve(undefined) }
    await tick()
    expect(f.channel.submittedWindow).toMatchObject({ y: 80, height: 40 })
    expect(video.style.height).toBe('40px')
    expect(video.style.transform).toBe('translate(0px, 60px)')
  })

  it('retains the submitted window across unrecognized frames and clears it when the mount ends', async () => {
    const f = fixture()
    const unmount = f.channel.mount(f.element, f.failure)
    await tick()
    f.channel.setContentView(contentView)
    await f.channel.setContentWindow(contentWindow)
    f.arrive(f.frame().lease); await tick()
    expect(f.channel.submittedWindow).toMatchObject(contentWindow)
    const unknown = f.frame().lease
    unknown.metadata.generation = 99
    f.arrive(unknown); await tick()
    expect(unknown.release).toHaveBeenCalledOnce()
    expect(f.channel.submittedWindow).toMatchObject(contentWindow)
    unmount()
    expect(f.channel.submittedWindow).toBeUndefined()
  })

  it('shows a previous window after a viewport-only version replaces the current generation', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); await tick()
    f.channel.setContentView(contentView)
    await f.channel.setContentWindow(contentWindow)
    f.arrive(f.frame().lease); await tick()
    const a = { ...contentWindow, y: 100 }, b = { ...contentWindow, y: 200 }
    const previous = await f.channel.setContentWindow(a)
    const superseded = await f.channel.setContentWindow(b)
    box(f.element, 0, 0, 120, 100); resized(); await tick(); await tick()
    expect(f.channel.viewport!.version).toBe(superseded.version + 1)
    expect(f.channel.submittedWindow).toMatchObject(contentWindow)
    for (const [generation, expected] of [[previous.version, a], [superseded.version, a], [f.channel.viewport!.version, b]] as const) {
      const lease = f.frame().lease
      lease.metadata.generation = generation
      f.arrive(lease); await tick()

      expect(f.channel.submittedWindow).toMatchObject(expected)
    }
  })

  it.each(vectors.mapping)('places the video for $name', async ({ window, view, expected }) => {
    const f = fixture()
    f.channel.mount(f.element, f.failure)
    await tick()
    f.channel.setContentView(view)
    await f.channel.setContentWindow(window)
    const video = f.element.querySelector('video')!
    expect([video.style.width, video.style.height, video.style.transform]).toEqual([
      `${expected.width}px`, `${expected.height}px`, `translate(${expected.x}px, ${expected.y}px)`,
    ])
  })
})

function directMount(element: HTMLElement, initialVisible?: boolean) {
  const owner = {
    content: () => undefined,
    viewport: vi.fn<Parameters<typeof mountElement>[1]['viewport']>(async value => ({ ...value, version: 1 })),
    report: vi.fn<Parameters<typeof mountElement>[1]['report']>(), failure: vi.fn(),
  }
  const mount = mountElement(element, owner, initialVisible)
  displays.add(mount)
  return { mount, owner }
}

describe('display resource ownership', () => {
  it('requires a live document and an unclaimed element', () => {
    const f = fixture()
    expect(() => directMount(document.implementation.createHTMLDocument().createElement('div'))).toThrow('needs a live document')
    f.element.setAttribute('data-dsh-frame-mount', 'pending')
    expect(() => directMount(f.element)).toThrow('already has a frame consumer')
  })
  it.each(['', 'static', 'absolute'])('restores inline styles and priorities after unmount: %s', (position) => {
    const f = fixture()
    f.element.style.setProperty('position', position, 'important')
    f.element.style.setProperty('isolation', 'auto', 'important')
    const { mount } = directMount(f.element)
    expect(f.element.style.position).toBe(position === 'absolute' ? 'absolute' : 'relative')
    mount.dispose()
    expect(f.element.style.position).toBe(position)
    expect(f.element.style.getPropertyPriority('position')).toBe(position === '' ? '' : 'important')
    expect(f.element.style.isolation).toBe('auto')
    expect(f.element.style.getPropertyPriority('isolation')).toBe('important')
  })
  it('reports synchronous viewport failure and ignores completion after disposal', async () => {
    const f = fixture()
    const { mount, owner } = directMount(f.element)
    const error = new Error('viewport failed')
    owner.viewport.mockImplementationOnce(() => { throw error })
    await expect(mount.requestViewport()).rejects.toBe(error)
    expect(owner.failure).toHaveBeenCalledWith(error)
    mount.pushContent(); mount.dirty()
    await expect(mount.requestViewport()).rejects.toMatchObject({ reason: 'cancelled' })
  })
  it('rejects content requests when synchronous geometry measurement fails', async () => {
    const f = fixture()
    const { mount, owner } = directMount(f.element)
    vi.spyOn(f.element, 'getBoundingClientRect').mockImplementationOnce(() => { throw new Error('layout unavailable') })
    await expect(mount.requestViewport()).rejects.toThrow('layout unavailable')
    expect(owner.failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'layout unavailable' }))
  })
  it('contains hidden-document measurement failure', async () => {
    const f = fixture()
    f.channel.mount(f.element, f.failure); await tick(); await tick()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    vi.spyOn(f.element, 'getBoundingClientRect').mockImplementationOnce(() => { throw new Error('hidden layout failed') })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ message: 'hidden layout failed' }))
    expect(trackStops[0]).toHaveBeenCalledOnce()
  })
  it('ignores queued animation and visibility callbacks after unmount', async () => {
    const f = fixture()
    const events = vi.spyOn(document, 'addEventListener')
    const unmount = f.channel.mount(f.element, f.failure)
    const flush = [...rafs.values()][0]!
    const visibility = events.mock.calls.find(([type]) => type === 'visibilitychange')![1]
    unmount()
    flush(0)
    if (typeof visibility !== 'function') throw new Error('Expected visibility callback')
    visibility(new Event('visibilitychange'))
    await tick()
    expect(trackStops).toHaveLength(0)
    expect(f.bridge.setViewport).not.toHaveBeenCalled()
  })
  it('rolls back synchronous observer setup failure', () => {
    const f = fixture()
    vi.stubGlobal('IntersectionObserver', class {
      disconnect = vi.fn()
      constructor() { observerStops.push(this.disconnect) }
      observe() { throw new Error('observe failed') }
    })
    expect(() => f.channel.mount(f.element, f.failure)).toThrow('observe failed')
    expect(f.element.hasAttribute('data-dsh-frame-mount')).toBe(false)
    expect(observerStops.every(stop => stop.mock.calls.length > 0)).toBe(true)
    expect(() => f.channel.consume(vi.fn(), vi.fn())).not.toThrow()
  })
  it('contains cleanup and failure-listener errors while freeing consumption', async () => {
    const f = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    f.channel.mount(f.element, () => { throw new Error('listener failed') }); await tick(); await tick()
    trackStops[0]!.mockImplementationOnce(() => { throw new Error('detach failed') })
    await f.channel.close()
    expect(log).toHaveBeenCalledWith('Frame mount cleanup failed', expect.objectContaining({ message: 'detach failed' }))
    expect(log).toHaveBeenCalledWith('Native frame failure listener failed', expect.objectContaining({ message: 'listener failed' }))
  })
})

it('reports non-Error layout failures even when video cleanup also fails', async () => {
  const f = fixture()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  f.channel.mount(f.element, f.failure); await tick(); await tick()
  trackStops[0]!.mockImplementationOnce(() => { throw new Error('detach failed') })
  vi.spyOn(f.element, 'getBoundingClientRect').mockImplementationOnce(() => { throw 'layout lost' })
  resized(); await tick()
  expect(log).toHaveBeenCalledWith('Frame mount cleanup failed', expect.objectContaining({ message: 'detach failed' }))
  expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ source: 'presentation', message: 'layout lost' }))
})

it('drops a retained queued document frame when fill mode makes its generation obsolete', async () => {
  const f = fixture()
  f.channel.mount(f.element, f.failure); await tick(); await tick()
  f.channel.setContentView(contentView)
  await f.channel.setContentWindow(contentWindow)
  const writing = Promise.withResolvers<undefined>()
  writer.write.mockReturnValueOnce(writing.promise)
  const first = f.frame(), queued = f.frame()
  try {
    f.arrive(first.lease); f.arrive(queued.lease)
    await f.channel.setContentWindow({ ...contentWindow, y: 100 })
    expect(queued.lease.release).not.toHaveBeenCalled()
    f.channel.setContentView(undefined)
  } finally {
    writing.resolve(undefined)
    await tick(); await tick()
  }
  expect(f.channel.submittedWindow).toBeUndefined()
  expect(first.lease.release).toHaveBeenCalledOnce()
  expect(queued.lease.release).toHaveBeenCalledOnce()
  expect(writer.write).toHaveBeenCalledOnce()
})

it('keeps video display after an individual frame failure and reports it through onEvent', async () => {
  const f = fixture()
  const events: FrameRxEvent[] = []
  f.channel.onEvent(event => events.push(event))
  f.channel.mount(f.element, f.failure); await tick(); await tick()
  const error = { kind: 'error', connectionId: 1 as FrameConnectionId, source: 'presentation', error: 'invalid-surface' } as const
  f.event(error); await tick()
  expect(f.element.getAttribute('data-dsh-frame-mount')).toBe('video')
  expect(trackStops[0]).not.toHaveBeenCalled()
  expect(events).toContainEqual(error)
  expect(f.failure).not.toHaveBeenCalled()
})
it('releases a previous-window video frame older than the submitted generation', async () => {
  const f = fixture()
  const events: FrameRxEvent[] = []
  f.channel.onEvent(event => events.push(event))
  f.channel.mount(f.element, f.failure); await tick()
  f.channel.setContentView(contentView)
  await f.channel.setContentWindow(contentWindow)
  const previous = await f.channel.setContentWindow({ ...contentWindow, y: 100 })
  const current = await f.channel.setContentWindow({ ...contentWindow, y: 200 })
  const shown = f.frame().lease
  f.arrive(shown); await tick()
  expect(shown.metadata.generation).toBe(current.version)
  const older = f.frame().lease; older.metadata.generation = previous.version
  f.arrive(older); await tick()
  expect(older.release).toHaveBeenCalledOnce()
  expect(writer.write).toHaveBeenCalledOnce()
  expect(events.filter(event => event.kind === 'content').at(-1)).toEqual({ kind: 'content', submittedGeneration: current.version })
})
it.each([new Error('play denied'), 'play denied'])('reports rejected playback: %s', async (error) => {
  const f = fixture()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(error)
  const presenter = createMediaPresenter(f.element, f.failure, vi.fn())
  displays.add(presenter)
  await tick()
  expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ source: 'presentation', message: 'play denied' }))
})

it('observes only its own intersection and honours explicit mount visibility', async () => {
  const f = fixture()
  f.channel.mount(f.element, f.failure, { visible: false })
  intersected([{ target: f.slot, isIntersecting: true }]); await tick()
  expect(f.bridge.setViewport.mock.calls.at(-1)?.[1].visible).toBe(false)
  f.visible(); await tick()
  expect(f.bridge.setViewport.mock.calls.at(-1)?.[1].visible).toBe(false)
  f.channel.setVisible(false)
  f.channel.setVisible(true); await tick(); await tick()
  expect(f.bridge.setViewport.mock.calls.at(-1)?.[1].visible).toBe(true)
  f.channel.setVisible(false); await tick(); await tick()
  expect(f.bridge.setViewport.mock.calls.at(-1)?.[1].visible).toBe(false)
  f.channel.setVisible(true); await tick(); await tick()
  expect(f.bridge.setViewport.mock.calls.at(-1)?.[1].visible).toBe(true)
  expect(() => f.channel.setViewport({ version: 100, width: 1, height: 1, deviceScaleFactor: 1, visible: true })).toThrow('managed by mount')
})

it('reports video startup failure and releases the mount', async () => {
  vi.stubGlobal('MediaStreamTrackGenerator', undefined)
  const f = fixture()
  f.channel.mount(f.element, f.failure); await tick()
  expect(f.failure).toHaveBeenCalledWith(expect.objectContaining({ source: 'presentation' }))
  expect(f.element.hasAttribute('data-dsh-frame-mount')).toBe(false)
})

it('ignores a rejected viewport whose display was disposed before the rejection was delivered', async () => {
  const f = fixture()
  const { mount, owner } = directMount(f.element)
  const error = new Error('viewport failed')
  owner.viewport.mockImplementationOnce(() => { throw error })
  const request = mount.requestViewport()
  mount.dispose()
  await expect(request).rejects.toBe(error)
  expect(owner.failure).not.toHaveBeenCalled()
})

it('keeps an idle channel available for its first producer and ignores a cancelled track write during unmount', async () => {
  const f = fixture(false)
  f.event({ kind: 'state', channel: { state: 'idle' } })
  const unmount = f.channel.mount(f.element, f.failure)
  f.event({ kind: 'state', channel: { state: 'connected', connectionId: 1 as FrameConnectionId } })
  await tick()
  const pending = Promise.withResolvers<undefined>()
  writer.write.mockReturnValueOnce(pending.promise)
  const { lease } = f.frame()
  f.arrive(lease)
  expect(writer.write).toHaveBeenCalledOnce()
  unmount()
  pending.reject(new Error('track stopped'))
  await tick()
  expect(lease.release).toHaveBeenCalledOnce()
  expect(f.failure).not.toHaveBeenCalled()
})
