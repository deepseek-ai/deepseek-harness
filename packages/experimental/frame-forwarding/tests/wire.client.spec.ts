// @vitest-environment jsdom
/**
 * Leases stay with their consumer across subscription and channel teardown; frames route by metadata and states by
 * sequence; the document's fullscreen element is held by one channel and reported to every channel.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SharedTextureClientExport, SharedTextureLease } from '@deepseek-ai/dsh-shared-texture/client'
import type { FrameChannelState, FrameConnectionId, FrameRxId } from '../src/types.ts'
import type { FrameChannelReceiver, FrameForwardingFrameLease, FrameRxEvent } from '../src/client/api.ts'
import { FrameRx } from '../src/client/rx.ts'
import { adaptFrameForwardingBridge, type FrameForwardingRemote } from '../src/client/wire.ts'

const rx = brandString<FrameRxId>('rx')
const other = brandString<FrameRxId>('other')
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'fullscreenElement')
  Reflect.deleteProperty(document, 'exitFullscreen')
})
/** jsdom has no Fullscreen API; this document shows one element fullscreen and reports each change as Chromium does. */
function fullscreenDocument() {
  let current: Element | null = null
  const change = (element: Element | null): void => {
    current = element
    document.dispatchEvent(new Event('fullscreenchange'))
  }
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current })
  const exit = vi.fn(async () => { change(null) })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
  const element = () => {
    const target = document.createElement('div')
    return Object.assign(target, { requestFullscreen: vi.fn(async () => { change(target) }) })
  }
  return { change, exit, element }
}
function fixture() {
  const fullscreen = fullscreenDocument()
  let consumer: ((lease: SharedTextureLease) => void) | undefined
  const textures = {
    onFrame: vi.fn<SharedTextureClientExport['onFrame']>((listener) => {
      consumer = listener
      return () => { if (consumer === listener) consumer = undefined }
    }),
  } satisfies SharedTextureClientExport
  const remote = {
    viewport: vi.fn<FrameForwardingRemote['viewport']>(async () => ({ ok: true, value: { applied: true, connectionId: 1 as FrameConnectionId } })),
  }
  // Like the preload, a texture without a consumer is released at once.
  const deliver = (lease: SharedTextureLease): void => { if (consumer === undefined) lease.release(); else consumer(lease) }
  const bridge = adaptFrameForwardingBridge(textures, remote, document)
  return {
    textures, remote, fullscreen, bridge, deliver,
    attach: (id: FrameRxId, callbacks: Partial<FrameChannelReceiver> = {}) =>
      bridge.attach(id, { onFrame: vi.fn(), onEvent: vi.fn(), ...callbacks }),
    consuming: () => consumer !== undefined,
  }
}
const metadata = (revision = 1, id: FrameRxId | string = rx) =>
  ({ rx: id, connectionId: 1, requestId: String(revision), frameId: revision, generation: 1, revision, width: 2, height: 2 })
function texture(revision = 1, id: FrameRxId | string = rx) {
  return { frame: {} as VideoFrame, metadata: metadata(revision, id), release: vi.fn() } satisfies SharedTextureLease
}
const connected = (connectionId: number): FrameChannelState => ({ state: 'connected', connectionId: connectionId as FrameConnectionId })
const states = (events: FrameRxEvent[]) => events.filter(event => event.kind === 'state').map(event => event.channel)

test('forwards viewports to the Host with its outcome and surfaces its rejection', async () => {
  const f = fixture(), viewport = { version: 1, width: 2, height: 2, deviceScaleFactor: 1, visible: true }
  expect(await f.bridge.setViewport(rx, viewport)).toEqual({ applied: true, connectionId: 1 })
  expect(f.remote.viewport).toHaveBeenCalledWith(rx, viewport)
  f.remote.viewport.mockResolvedValueOnce({ ok: false, error: { message: 'Native viewport version must increase' } } as never)
  await expect(f.bridge.setViewport(rx, viewport)).rejects.toThrow('must increase')
})

test('delivers shared frames by channel and preserves owned leases after unsubscribe and close', async () => {
  const f = fixture(), delivered: FrameForwardingFrameLease[] = [], lease = texture()
  const remove = f.attach(rx, { onFrame: value => delivered.push(value) })
  f.deliver(lease)
  expect(delivered).toMatchObject([{ frame: lease.frame, metadata: lease.metadata }])
  await remove()
  expect(lease.release).not.toHaveBeenCalled()
  delivered[0]!.release()
  expect(lease.release).toHaveBeenCalledOnce()
})

test('a replacement connected in the close listener keeps routing events and frames for the same rx', async () => {
  const f = fixture(), present = vi.fn()
  f.bridge.apply({ kind: 'state', rx, sequence: 1, channel: connected(1) })
  const first = new FrameRx(rx, f.bridge)
  let next: FrameRx | undefined
  first.onEvent((event) => {
    if (event.kind === 'state' && event.channel.state === 'closed') next = new FrameRx(rx, f.bridge)
  })
  await first.close()
  if (!next) throw new Error('The close listener did not reconnect')
  expect(next.connectionId).toBe(1)
  next.consume(present, vi.fn())
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: connected(2) })
  const lease = texture()
  Object.assign(lease.metadata, { connectionId: 2, generation: 0 })
  f.deliver(lease)
  expect(next.connectionId).toBe(2)
  await next.close()
  expect(present).toHaveBeenCalledExactlyOnceWith({ image: lease.frame, metadata: lease.metadata })
  expect(lease.release).toHaveBeenCalledOnce()
})

test('contains a throwing consumer, releases its lease and reports the failure to the channel', () => {
  const f = fixture(), events: FrameRxEvent[] = [], lease = texture()
  f.attach(rx, { onFrame() { throw new Error('paint failed') }, onEvent: event => events.push(event) })
  expect(() => { f.deliver(lease) }).not.toThrow()
  expect(lease.release).toHaveBeenCalledOnce()
  expect(events).toEqual([{ kind: 'failure', error: 'paint failed' }])
  const after = texture(2)
  f.deliver(after)
  expect(after.release).toHaveBeenCalledOnce()
})

test('a failed obsolete consumer cannot drop its replacement', async () => {
  const f = fixture(), replacement = vi.fn(), lease = texture(), unrouted = texture()
  const remove = f.attach(rx, { onFrame() {
    void remove()
    f.deliver(unrouted)
    f.attach(rx, { onFrame: replacement })
    throw new Error('old consumer failed')
  } })
  f.deliver(lease)
  await remove()
  expect(lease.release).toHaveBeenCalledOnce()
  expect(unrouted.release).toHaveBeenCalledOnce()
  const fresh = texture(2)
  f.deliver(fresh)
  expect(replacement).toHaveBeenCalledWith(expect.objectContaining({ frame: fresh.frame }))
  fresh.release()
})

test('applies channel states in sequence order and gives a late observer the latest one', () => {
  const f = fixture(), events: FrameRxEvent[] = []
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: connected(1) })
  const detach = f.attach(rx, { onEvent: event => events.push(event) })
  f.bridge.apply({ kind: 'state', rx, sequence: 1, channel: { state: 'idle' } })
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: { state: 'idle' } })
  f.bridge.apply({ kind: 'state', rx, sequence: 3, channel: { state: 'draining', connectionId: 1 as FrameConnectionId } })
  f.bridge.apply({ kind: 'error', rx, connectionId: 1 as FrameConnectionId, source: 'producer', error: 'stream failed' })
  f.bridge.apply({ kind: 'error', rx, connectionId: 1 as FrameConnectionId, source: 'presentation', requestId: 'tile', error: 'transfer failed' })
  f.bridge.apply({ kind: 'state', rx: other, sequence: 4, channel: { state: 'idle' } })
  expect(events).toEqual([
    { kind: 'state', channel: connected(1) },
    { kind: 'state', channel: { state: 'draining', connectionId: 1 } },
    { kind: 'error', connectionId: 1, source: 'producer', error: 'stream failed' },
    { kind: 'error', connectionId: 1, source: 'presentation', requestId: 'tile', error: 'transfer failed' },
  ])
  void detach()
  f.bridge.apply({ kind: 'state', rx, sequence: 5, channel: { state: 'idle' } })
  expect(events).toHaveLength(4)
})

test('a snapshot replaces every known state and reports channels that closed meanwhile as lost', () => {
  const f = fixture(), seen: FrameRxEvent[] = [], gone: FrameRxEvent[] = []
  f.bridge.apply({ kind: 'state', rx, sequence: 9, channel: connected(1) })
  f.bridge.apply({ kind: 'state', rx: other, sequence: 10, channel: { state: 'idle' } })
  f.attach(rx, { onEvent: event => seen.push(event) })
  const detach = f.attach(other, { onEvent: event => gone.push(event) })
  // A new subscription numbers its states afresh.
  f.bridge.apply({ kind: 'snapshot', channels: [{ rx, sequence: 1, channel: connected(2) }] })
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: { state: 'draining', connectionId: 2 as FrameConnectionId } })
  expect(states(seen)).toEqual([connected(1), connected(2), { state: 'draining', connectionId: 2 }])
  expect(states(gone)).toEqual([
    { state: 'idle' }, { state: 'closed', cause: 'lost', reason: 'Native channel closed while the renderer was not subscribed' },
  ])
  const late: FrameRxEvent[] = []
  void detach()
  f.attach(other, { onEvent: event => late.push(event) })
  expect(late).toEqual([])
})

test('a snapshot reports the closure it carries to an observer that never received the channel state', () => {
  const f = fixture(), seen: FrameRxEvent[] = []
  f.attach(rx, { onEvent: event => seen.push(event) })
  const failed = { state: 'closed', cause: 'failed', reason: 'Native channel failed: device lost' } as const
  f.bridge.apply({ kind: 'snapshot', channels: [{ rx, sequence: 4, channel: failed }] })
  expect(states(seen)).toEqual([failed])
})

const closedState = { state: 'closed', cause: 'closed', reason: 'Native channel closed' } as const

test('forgets a closed channel once its consumer detaches, but keeps an open one for its next consumer', async () => {
  const f = fixture(), seen: FrameRxEvent[] = [], late: FrameRxEvent[] = [], open: FrameRxEvent[] = []
  f.bridge.apply({ kind: 'state', rx, sequence: 1, channel: connected(1) })
  const detach = f.attach(rx, { onEvent: event => seen.push(event) })
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: closedState })
  expect(states(seen)).toEqual([connected(1), closedState])
  await detach()
  f.attach(rx, { onEvent: event => late.push(event) })
  expect(late).toEqual([])
  // A closure that arrived before any consumer still reaches the first one, which forgets it on detaching.
  f.bridge.apply({ kind: 'snapshot', channels: [{ rx: other, sequence: 3, channel: closedState }] })
  const detachOther = f.attach(other, { onEvent: event => open.push(event) })
  expect(states(open)).toEqual([closedState])
  await detachOther()
  open.length = 0
  f.attach(other, { onEvent: event => open.push(event) })
  expect(open).toEqual([])
})

test('keeps only the newest closures of channels no consumer attached, while attached and open channels stay', async () => {
  const f = fixture(), id = (index: number) => brandString<FrameRxId>(`rx-${index}`)
  const replay = (channel: FrameRxId): FrameChannelState[] => {
    const events: FrameRxEvent[] = []
    void f.attach(channel, { onEvent: event => events.push(event) })()
    return states(events)
  }
  f.bridge.apply({ kind: 'state', rx: other, sequence: 1, channel: connected(1) })
  const attached: FrameRxEvent[] = []
  f.attach(rx, { onEvent: event => attached.push(event) })
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: closedState })
  for (let index = 0; index < 100; index++) f.bridge.apply({ kind: 'state', rx: id(index), sequence: 3 + index, channel: closedState })
  expect(states(attached)).toEqual([closedState])
  expect(replay(id(35))).toEqual([])
  expect(replay(id(36))).toEqual([closedState])
  expect(replay(id(99))).toEqual([closedState])
  expect(replay(other)).toEqual([connected(1)])
  // A snapshot with more closures than the bound keeps its newest ones too.
  f.bridge.apply({ kind: 'snapshot', channels: Array.from({ length: 70 }, (_, index) => ({ rx: id(index), sequence: index, channel: closedState })) })
  expect(replay(id(5))).toEqual([])
  expect(replay(id(6))).toEqual([closedState])
  // The attached closure outlived the bound: the snapshot that omits it reports it vanished.
  expect(states(attached)).toEqual([
    closedState, { state: 'closed', cause: 'lost', reason: 'Native channel closed while the renderer was not subscribed' },
  ])
})

test('a bridge whose texture subscription fails observes nothing, and duplicate frame consumers are rejected', () => {
  const f = fixture()
  const listen = vi.spyOn(document, 'addEventListener')
  const taken = { onFrame: () => { throw new Error('Shared textures already have a consumer') } } satisfies SharedTextureClientExport
  expect(() => adaptFrameForwardingBridge(taken, f.remote, document)).toThrow('already have a consumer')
  expect(listen).not.toHaveBeenCalled()
  const remove = f.attach(rx)
  expect(() => f.attach(rx)).toThrow('already has')
  void remove()
  f.attach(rx)
})

test.each([
  ['a non-object', 'nothing'],
  ['null', null],
  ['a non-string channel', { ...metadata(), rx: 7 }],
  ['an empty channel', { ...metadata(), rx: '' }],
  ['a missing connection', { ...metadata(), connectionId: undefined }],
  ['connection zero', { ...metadata(), connectionId: 0 }],
  ['a non-string request', { ...metadata(), requestId: 7 }],
  ['a negative frame', { ...metadata(), frameId: -1 }],
  ['a fractional generation', { ...metadata(), generation: 1.5 }],
  ['a missing revision', { ...metadata(), revision: undefined }],
  ['a string width', { ...metadata(), width: '2' }],
  ['an infinite height', { ...metadata(), height: Infinity }],
  ['an unknown channel', metadata(1, 'unknown')],
])('releases a texture whose metadata is %s', (_name, value) => {
  const f = fixture(), consume = vi.fn()
  f.attach(rx, { onFrame: consume })
  const lease = { frame: {} as VideoFrame, metadata: value, release: vi.fn() }
  f.deliver(lease)
  expect(lease.release).toHaveBeenCalledOnce()
  expect(consume).not.toHaveBeenCalled()
})

test('delivers only the frame fields and contains a non-Error consumer failure', () => {
  const f = fixture(), events: FrameRxEvent[] = [], delivered: FrameForwardingFrameLease[] = []
  f.attach(rx, { onFrame(lease) { delivered.push(lease); throw 'paint failed' }, onEvent: event => events.push(event) })
  const lease = { ...texture(), metadata: { ...metadata(), sourceKeyedMutex: true, tileKey: 'a' } }
  f.deliver(lease)
  expect(delivered[0]?.metadata).toEqual(metadata())
  expect(lease.release).toHaveBeenCalledOnce()
  expect(events).toEqual([{ kind: 'failure', error: 'paint failed' }])
})

test('the bridge keeps one texture subscription from creation until disposal, with or without channels', () => {
  const f = fixture(), first = vi.fn(), second = vi.fn()
  expect(f.consuming()).toBe(true)
  const unrouted = texture()
  f.deliver(unrouted)
  expect(unrouted.release).toHaveBeenCalledOnce()
  const removeFirst = f.attach(rx, { onFrame: first })
  f.attach(other, { onFrame: second })
  void removeFirst()
  const lease = texture(1, other)
  f.deliver(lease)
  expect(second).toHaveBeenCalledOnce()
  expect(first).not.toHaveBeenCalled()
  lease.release()
  const events: FrameRxEvent[] = []
  f.attach(rx, { onEvent: event => events.push(event) })
  f.bridge.dispose()
  expect(f.consuming()).toBe(false)
  expect(f.textures.onFrame).toHaveBeenCalledOnce()
  f.fullscreen.change(document.body)
  expect(events).toEqual([{ kind: 'failure', error: 'Frame-forwarding Client disposed.' }])
})

test('a failed bridge fails every known channel once and every later subscription at once', async () => {
  const f = fixture(), seen: FrameRxEvent[] = [], gone: FrameRxEvent[] = [], delivered: FrameForwardingFrameLease[] = []
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failure = { kind: 'failure', error: 'events failed' } as const
  f.bridge.apply({ kind: 'snapshot', channels: [{ rx, sequence: 1, channel: connected(1) }] })
  f.attach(rx, { onFrame: lease => delivered.push(lease), onEvent: event => seen.push(event) })
  f.attach(other, { onEvent: (event) => { gone.push(event); throw new Error('listener failed') } })
  const held = texture()
  f.deliver(held)
  f.bridge.fail('events failed')
  f.bridge.fail('failed again')
  expect(seen).toEqual([{ kind: 'state', channel: connected(1) }, failure])
  expect(gone).toEqual([failure])
  expect(log).toHaveBeenCalledWith('Native channel listener failed', expect.objectContaining({ message: 'listener failed' }))
  // A delivered lease stays with its holder; later textures have no consumer and are released.
  expect(held.release).not.toHaveBeenCalled()
  delivered[0]!.release()
  const late = texture(2)
  f.deliver(late)
  expect(late.release).toHaveBeenCalledOnce()
  const replacement = vi.fn()
  const later: FrameRxEvent[] = []
  const remove = f.attach(rx, { onFrame: replacement, onEvent: event => later.push(event) })
  void remove()
  const after = texture(3)
  f.deliver(after)
  expect(after.release).toHaveBeenCalledOnce()
  expect(replacement).not.toHaveBeenCalled()
  // Host events no longer reach any channel, and the forgotten states are not replayed.
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: { state: 'idle' } })
  expect(later).toEqual([failure])
  expect(seen).toHaveLength(2)
  await expect(f.bridge.setViewport(rx, { version: 1, width: 2, height: 2, deviceScaleFactor: 1, visible: true }))
    .rejects.toThrow('events failed')
  expect(f.remote.viewport).not.toHaveBeenCalled()
  f.bridge.dispose()
  expect(f.consuming()).toBe(false)
  expect(seen).toHaveLength(2)
})

test('failing a disposed bridge changes nothing', async () => {
  const f = fixture(), events: FrameRxEvent[] = []
  f.bridge.apply({ kind: 'state', rx, sequence: 1, channel: connected(1) })
  f.bridge.dispose()
  f.bridge.fail('events failed')
  f.attach(rx, { onEvent: event => events.push(event) })
  expect(events).toEqual([{ kind: 'state', channel: connected(1) }])
  await f.bridge.setViewport(rx, { version: 1, width: 2, height: 2, deviceScaleFactor: 1, visible: true })
  expect(f.remote.viewport).toHaveBeenCalledOnce()
})

test('reports fullscreen to every channel with its holder and gives a late observer the current state', async () => {
  const f = fixture(), seen: FrameRxEvent[] = [], covered: FrameRxEvent[] = []
  f.attach(other, { onEvent: event => covered.push(event) })
  const view = f.fullscreen.element()
  await f.bridge.requestFullscreen(rx, view)
  f.attach(rx, { onEvent: event => seen.push(event) })
  expect(view.requestFullscreen).toHaveBeenCalledOnce()
  const late: FrameRxEvent[] = []
  const lateRx = brandString<FrameRxId>('late')
  f.bridge.apply({ kind: 'snapshot', channels: [{ rx: lateRx, sequence: 1, channel: connected(1) }] })
  f.attach(lateRx, { onEvent: event => late.push(event) })
  expect(late).toEqual([{ kind: 'state', channel: connected(1) }, { kind: 'fullscreen', active: true, holder: false }])
  // Fullscreen another element took over covers its former holder too.
  f.fullscreen.change(document.body)
  f.fullscreen.change(null)
  // Fullscreen that no channel requested covers every channel.
  f.fullscreen.change(document.body)
  f.fullscreen.change(null)
  expect(seen).toEqual([
    { kind: 'fullscreen', active: true, holder: true },
    { kind: 'fullscreen', active: true, holder: false },
    { kind: 'fullscreen', active: false, holder: true },
    { kind: 'fullscreen', active: true, holder: false },
    { kind: 'fullscreen', active: false, holder: false },
  ])
  expect(covered.map(event => event.kind === 'fullscreen' && event.holder)).toEqual([false, false, false, false, false])
})

test('leaves every element a holder stacked by moving its fullscreen, so another channel can take it', async () => {
  const f = fixture()
  // Chromium keeps an earlier fullscreen element below a later one, and each exit reveals the element below it.
  const stack: Element[] = []
  const show = () => { f.fullscreen.change(stack.at(-1) ?? null) }
  const stacked = () => {
    const target = f.fullscreen.element()
    target.requestFullscreen.mockImplementation(async () => {
      if (stack.includes(target)) stack.splice(stack.indexOf(target), 1)
      stack.push(target)
      show()
    })
    return target
  }
  f.fullscreen.exit.mockImplementation(async () => { stack.pop(); show() })
  const events: FrameRxEvent[] = []
  f.attach(rx, { onEvent: event => events.push(event) })
  const first = stacked(), moved = stacked(), second = f.fullscreen.element()
  await f.bridge.requestFullscreen(rx, first)
  await f.bridge.requestFullscreen(rx, moved)
  await f.bridge.exitFullscreen(rx)
  expect(f.fullscreen.exit).toHaveBeenCalledTimes(2)
  expect(document.fullscreenElement).toBeNull()
  // The revealed earlier element stays the channel's own while the exit continues.
  expect(events.filter(event => event.kind === 'fullscreen').map(event => event.kind === 'fullscreen' && [event.active, event.holder]))
    .toEqual([[true, true], [true, true], [true, true], [false, true]])
  await f.bridge.requestFullscreen(other, second)
  expect(document.fullscreenElement).toBe(second)
})

test('an exit or failure during a refused fullscreen move leaves the element that stays fullscreen', async () => {
  for (const end of ['exit', 'fail'] as const) {
    const f = fixture()
    const view = f.fullscreen.element(), removed = f.fullscreen.element(), second = f.fullscreen.element()
    await f.bridge.requestFullscreen(rx, view)
    const refused = Promise.withResolvers<undefined>()
    removed.requestFullscreen.mockReturnValueOnce(refused.promise)
    const moving = f.bridge.requestFullscreen(rx, removed)
    let ending = Promise.resolve()
    if (end === 'exit') ending = f.bridge.exitFullscreen(rx)
    else f.bridge.fail('renderer failed')
    refused.reject(new TypeError('Element is not connected'))
    await expect(moving).rejects.toThrow('not connected')
    await ending
    await vi.waitFor(() => { expect(document.fullscreenElement).toBeNull() })
    if (end === 'exit') await f.bridge.requestFullscreen(other, second)
    f.bridge.dispose()
  }
})

test('one channel holds fullscreen at a time, and a refused entry frees it', async () => {
  const f = fixture()
  const view = f.fullscreen.element(), second = f.fullscreen.element()
  view.requestFullscreen.mockRejectedValueOnce(new TypeError('Permissions check failed'))
  await expect(f.bridge.requestFullscreen(rx, view)).rejects.toThrow('Permissions check failed')
  await f.bridge.requestFullscreen(other, second)
  await expect(f.bridge.requestFullscreen(rx, view)).rejects.toThrow('Another native channel holds fullscreen.')
  // The holder may move its fullscreen to another of its elements.
  await f.bridge.requestFullscreen(other, view)
  expect(document.fullscreenElement).toBe(view)
  await f.bridge.exitFullscreen(other)
  await f.bridge.requestFullscreen(rx, view)
  // A failed re-entry of the holder leaves a newer entry in place.
  const retry = f.fullscreen.element()
  const refused = Promise.withResolvers<undefined>()
  retry.requestFullscreen.mockReturnValueOnce(refused.promise)
  const failing = f.bridge.requestFullscreen(rx, retry)
  await f.bridge.requestFullscreen(rx, view)
  refused.reject(new TypeError('refused'))
  await expect(failing).rejects.toThrow('refused')
  await expect(f.bridge.requestFullscreen(other, second)).rejects.toThrow('Another native channel holds fullscreen.')
  // A refused move keeps the holder of the element that stays fullscreen, so the channel can still leave it.
  const removed = f.fullscreen.element()
  removed.requestFullscreen.mockRejectedValueOnce(new TypeError('Element is not connected'))
  await expect(f.bridge.requestFullscreen(rx, removed)).rejects.toThrow('not connected')
  expect(document.fullscreenElement).toBe(view)
  await expect(f.bridge.requestFullscreen(other, second)).rejects.toThrow('Another native channel holds fullscreen.')
  await f.bridge.exitFullscreen(rx)
  expect(document.fullscreenElement).toBeNull()
})

test('a request refused while an earlier one is pending keeps the hold for the entry that completes', async () => {
  const f = fixture(), events: FrameRxEvent[] = []
  const detach = f.attach(rx, { onEvent: event => events.push(event) })
  const view = f.fullscreen.element(), refused = f.fullscreen.element(), second = f.fullscreen.element()
  const entering = Promise.withResolvers<undefined>()
  view.requestFullscreen.mockImplementationOnce(async () => { await entering.promise; f.fullscreen.change(view) })
  const entry = f.bridge.requestFullscreen(rx, view)
  refused.requestFullscreen.mockRejectedValueOnce(new TypeError('Permissions check failed'))
  await expect(f.bridge.requestFullscreen(rx, refused)).rejects.toThrow('Permissions check failed')
  await expect(f.bridge.requestFullscreen(other, second)).rejects.toThrow('Another native channel holds fullscreen.')
  entering.resolve(undefined)
  await entry
  expect(events).toEqual([{ kind: 'fullscreen', active: true, holder: true }])
  // Closing the channel leaves the fullscreen its pending entry took.
  await detach()
  expect(f.fullscreen.exit).toHaveBeenCalledOnce()
  expect(document.fullscreenElement).toBeNull()
})

test('fullscreen that ends while a request is pending stays held until that request settles', async () => {
  for (const enters of [true, false]) {
    const f = fixture()
    const view = f.fullscreen.element(), moved = f.fullscreen.element(), second = f.fullscreen.element()
    await f.bridge.requestFullscreen(rx, view)
    const settling = Promise.withResolvers<undefined>()
    moved.requestFullscreen.mockImplementationOnce(async () => {
      await settling.promise
      if (!enters) throw new TypeError('Element is not connected')
      f.fullscreen.change(moved)
    })
    const moving = f.bridge.requestFullscreen(rx, moved).then(() => 'entered', (error: unknown) => (error as Error).message)
    // Escape leaves fullscreen before the move settles.
    f.fullscreen.change(null)
    await expect(f.bridge.requestFullscreen(other, second)).rejects.toThrow('Another native channel holds fullscreen.')
    settling.resolve(undefined)
    expect(await moving).toBe(enters ? 'entered' : 'Element is not connected')
    await f.bridge.exitFullscreen(rx)
    expect(f.fullscreen.exit).toHaveBeenCalledTimes(enters ? 1 : 0)
    // The hold ends with the request's fullscreen, so another channel can take it.
    await f.bridge.requestFullscreen(other, second)
    expect(document.fullscreenElement).toBe(second)
  }
})

test('a channel whose entry is still pending hears no end of fullscreen that another element held', async () => {
  const f = fixture(), events: FrameRxEvent[] = []
  f.attach(rx, { onEvent: event => events.push(event) })
  const view = f.fullscreen.element()
  f.fullscreen.change(document.body)
  const entering = Promise.withResolvers<undefined>()
  view.requestFullscreen.mockImplementationOnce(async () => { await entering.promise; f.fullscreen.change(view) })
  const entry = f.bridge.requestFullscreen(rx, view)
  // The page leaves its own fullscreen before the channel's entry completes.
  f.fullscreen.change(null)
  entering.resolve(undefined)
  await entry
  expect(events.filter(event => event.kind === 'fullscreen')).toEqual([
    { kind: 'fullscreen', active: true, holder: false },
    { kind: 'fullscreen', active: false, holder: false },
    { kind: 'fullscreen', active: true, holder: true },
  ])
})

test('exits of one channel run one at a time, so a second exit leaves the page fullscreen below its element', async () => {
  const f = fixture(), stack: Element[] = [document.body]
  const show = () => { f.fullscreen.change(stack.at(-1) ?? null) }
  show()
  const view = f.fullscreen.element()
  view.requestFullscreen.mockImplementation(async () => { stack.push(view); show() })
  await f.bridge.requestFullscreen(rx, view)
  // Chromium settles an exit after the call returns, so both exits would see the channel's element on top.
  const exiting = Promise.withResolvers<undefined>()
  f.fullscreen.exit.mockImplementation(async () => { await exiting.promise; stack.pop(); show() })
  const first = f.bridge.exitFullscreen(rx), second = f.bridge.exitFullscreen(rx)
  await vi.waitFor(() => { expect(f.fullscreen.exit).toHaveBeenCalled() })
  expect(f.fullscreen.exit).toHaveBeenCalledOnce()
  exiting.resolve(undefined)
  await first
  await second
  expect(f.fullscreen.exit).toHaveBeenCalledOnce()
  expect(document.fullscreenElement).toBe(document.body)
})

test('a refused request keeps the hold of a channel whose element another element covers', async () => {
  const f = fixture(), stack: Element[] = []
  const show = () => { f.fullscreen.change(stack.at(-1) ?? null) }
  const view = f.fullscreen.element(), refused = f.fullscreen.element(), second = f.fullscreen.element()
  view.requestFullscreen.mockImplementation(async () => { stack.push(view); show() })
  f.fullscreen.exit.mockImplementation(async () => { stack.pop(); show() })
  await f.bridge.requestFullscreen(rx, view)
  // The page shows its own element above the channel's, and the document reports only the page element.
  stack.push(document.body)
  show()
  refused.requestFullscreen.mockRejectedValueOnce(new TypeError('Permissions check failed'))
  await expect(f.bridge.requestFullscreen(rx, refused)).rejects.toThrow('Permissions check failed')
  await expect(f.bridge.requestFullscreen(other, second)).rejects.toThrow('Another native channel holds fullscreen.')
  // Once the page leaves, the channel still owns the element it revealed and can leave it.
  stack.pop()
  show()
  await f.bridge.exitFullscreen(rx)
  expect(document.fullscreenElement).toBeNull()
})

test('exits only the fullscreen its channel holds, after a pending entry, and tolerates an exit Chromium performed', async () => {
  const f = fixture()
  await f.bridge.exitFullscreen(rx)
  const view = f.fullscreen.element()
  const entering = Promise.withResolvers<undefined>()
  view.requestFullscreen.mockImplementationOnce(async () => { await entering.promise; f.fullscreen.change(view) })
  const entry = f.bridge.requestFullscreen(rx, view)
  const exit = f.bridge.exitFullscreen(rx)
  await f.bridge.exitFullscreen(other)
  expect(f.fullscreen.exit).not.toHaveBeenCalled()
  entering.resolve(undefined)
  await entry
  await exit
  expect(f.fullscreen.exit).toHaveBeenCalledOnce()
  expect(document.fullscreenElement).toBeNull()
  await f.bridge.exitFullscreen(rx)
  expect(f.fullscreen.exit).toHaveBeenCalledOnce()
  // Escape leaves fullscreen before the requested exit runs.
  await f.bridge.requestFullscreen(rx, view)
  f.fullscreen.exit.mockImplementationOnce(async () => { throw new TypeError('Document not active') })
  vi.spyOn(document, 'fullscreenElement', 'get').mockReturnValueOnce(view).mockReturnValue(null)
  await f.bridge.exitFullscreen(rx)
  vi.restoreAllMocks()
  // An exit Chromium refuses while the element stays fullscreen fails visibly.
  f.fullscreen.change(null)
  await f.bridge.requestFullscreen(rx, view)
  f.fullscreen.exit.mockRejectedValueOnce(new TypeError('exit refused'))
  await expect(f.bridge.exitFullscreen(rx)).rejects.toThrow('exit refused')
  // Fullscreen another element took over is not the holder's to exit.
  f.fullscreen.change(document.body)
  await f.bridge.exitFullscreen(rx)
  expect(document.fullscreenElement).toBe(document.body)
})

test('closing the holding channel or disposing the bridge leaves its fullscreen', async () => {
  const f = fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = f.fullscreen.element()
  const detach = f.attach(rx)
  await f.bridge.requestFullscreen(rx, view)
  const detachOther = f.attach(other)
  await detachOther()
  expect(document.fullscreenElement).toBe(view)
  await detach()
  expect(document.fullscreenElement).toBeNull()
  const detachAgain = f.attach(rx)
  await f.bridge.requestFullscreen(rx, view)
  f.fullscreen.exit.mockRejectedValueOnce(new TypeError('exit refused'))
  await detachAgain()
  expect(log).toHaveBeenCalledWith('Native channel fullscreen exit failed', expect.objectContaining({ message: 'exit refused' }))
  f.fullscreen.exit.mockRejectedValueOnce(new TypeError('exit refused'))
  f.bridge.dispose()
  await vi.waitFor(() => { expect(log).toHaveBeenCalledTimes(2) })
  const idle = fixture()
  idle.bridge.dispose()
  expect(idle.fullscreen.exit).not.toHaveBeenCalled()
})

test('a failed bridge leaves the holder\'s fullscreen after its pending entry and refuses later requests', async () => {
  const f = fixture(), log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const view = f.fullscreen.element()
  const entering = Promise.withResolvers<undefined>()
  view.requestFullscreen.mockImplementationOnce(async () => { await entering.promise; f.fullscreen.change(view) })
  const entry = f.bridge.requestFullscreen(rx, view)
  f.bridge.fail('events failed')
  expect(f.fullscreen.exit).not.toHaveBeenCalled()
  entering.resolve(undefined)
  await entry
  await vi.waitFor(() => { expect(f.fullscreen.exit).toHaveBeenCalledOnce() })
  expect(document.fullscreenElement).toBeNull()
  await expect(f.bridge.requestFullscreen(rx, view)).rejects.toThrow('events failed')
  expect(view.requestFullscreen).toHaveBeenCalledOnce()
  // A refused exit is logged; the failed bridge holds no fullscreen afterwards.
  const refused = fixture(), shown = refused.fullscreen.element()
  await refused.bridge.requestFullscreen(rx, shown)
  refused.fullscreen.exit.mockRejectedValueOnce(new TypeError('exit refused'))
  refused.bridge.fail('events failed')
  await vi.waitFor(() => { expect(log).toHaveBeenCalledWith('Native channel fullscreen exit failed', expect.objectContaining({ message: 'exit refused' })) })
  await refused.bridge.exitFullscreen(rx)
  expect(refused.fullscreen.exit).toHaveBeenCalledOnce()
})
