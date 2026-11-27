/**
 * Leases stay with their consumer across subscription and channel teardown; frames route by metadata and states by
 * sequence.
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
})
function fixture() {
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
  const bridge = adaptFrameForwardingBridge(textures, remote)
  return {
    textures, remote, bridge, deliver,
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
const connected = (connectionId: number, viewportVersion?: number): FrameChannelState => ({
  state: 'connected', connectionId: connectionId as FrameConnectionId, ...viewportVersion === undefined ? {} : { viewportVersion },
})
const states = (events: FrameRxEvent[]) => events.filter(event => event.kind === 'state').map(event => event.channel)

test('forwards viewports to the Host with its outcome and surfaces its rejection', async () => {
  const f = fixture(), viewport = { version: 1, width: 2, height: 2, deviceScaleFactor: 1, visible: true }
  expect(await f.bridge.setViewport(rx, viewport)).toEqual({ applied: true, connectionId: 1 })
  expect(f.remote.viewport).toHaveBeenCalledWith(rx, viewport)
  f.remote.viewport.mockResolvedValueOnce({ ok: false, error: { message: 'Native viewport version must increase' } } as never)
  await expect(f.bridge.setViewport(rx, viewport)).rejects.toThrow('must increase')
})

test('delivers shared frames by channel and preserves owned leases after unsubscribe and close', () => {
  const f = fixture(), delivered: FrameForwardingFrameLease[] = [], lease = texture()
  const remove = f.attach(rx, { onFrame: value => delivered.push(value) })
  f.deliver(lease)
  expect(delivered).toMatchObject([{ frame: lease.frame, metadata: lease.metadata }])
  remove()
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
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: connected(1, 1) })
  const lease = texture()
  Object.assign(lease.metadata, { generation: 0 })
  f.deliver(lease)
  expect(next.connectionId).toBe(1)
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

test('a failed obsolete consumer cannot drop its replacement', () => {
  const f = fixture(), replacement = vi.fn(), lease = texture(), unrouted = texture()
  const remove = f.attach(rx, { onFrame() {
    remove()
    f.deliver(unrouted)
    f.attach(rx, { onFrame: replacement })
    throw new Error('old consumer failed')
  } })
  f.deliver(lease)
  remove()
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
  f.bridge.apply({ kind: 'state', rx, sequence: 3, channel: connected(1, 1) })
  f.bridge.apply({ kind: 'error', rx, connectionId: 1 as FrameConnectionId, source: 'producer', error: 'stream failed' })
  f.bridge.apply({ kind: 'error', rx, connectionId: 1 as FrameConnectionId, source: 'presentation', requestId: 'tile', error: 'transfer failed' })
  f.bridge.apply({ kind: 'state', rx: other, sequence: 4, channel: { state: 'idle' } })
  expect(events).toEqual([
    { kind: 'state', channel: connected(1) },
    { kind: 'state', channel: connected(1, 1) },
    { kind: 'error', connectionId: 1, source: 'producer', error: 'stream failed' },
    { kind: 'error', connectionId: 1, source: 'presentation', requestId: 'tile', error: 'transfer failed' },
  ])
  detach()
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
  f.bridge.apply({ kind: 'snapshot', channels: [{ rx, sequence: 1, channel: connected(1, 2) }] })
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: connected(1, 3) })
  expect(states(seen)).toEqual([connected(1), connected(1, 2), connected(1, 3)])
  expect(states(gone)).toEqual([
    { state: 'idle' }, { state: 'closed', cause: 'lost', reason: 'Native channel closed while the renderer was not subscribed' },
  ])
  const late: FrameRxEvent[] = []
  detach()
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

test('forgets a closed channel once its consumer detaches, but keeps an open one for its next consumer', () => {
  const f = fixture(), seen: FrameRxEvent[] = [], late: FrameRxEvent[] = [], open: FrameRxEvent[] = []
  f.bridge.apply({ kind: 'state', rx, sequence: 1, channel: connected(1) })
  const detach = f.attach(rx, { onEvent: event => seen.push(event) })
  f.bridge.apply({ kind: 'state', rx, sequence: 2, channel: closedState })
  expect(states(seen)).toEqual([connected(1), closedState])
  detach()
  f.attach(rx, { onEvent: event => late.push(event) })
  expect(late).toEqual([])
  // A closure that arrived before any consumer still reaches the first one, which forgets it on detaching.
  f.bridge.apply({ kind: 'snapshot', channels: [{ rx: other, sequence: 3, channel: closedState }] })
  const detachOther = f.attach(other, { onEvent: event => open.push(event) })
  expect(states(open)).toEqual([closedState])
  detachOther()
  open.length = 0
  f.attach(other, { onEvent: event => open.push(event) })
  expect(open).toEqual([])
})

test('keeps only the newest closures of channels no consumer attached, while attached and open channels stay', () => {
  const f = fixture(), id = (index: number) => brandString<FrameRxId>(`rx-${index}`)
  const replay = (channel: FrameRxId): FrameChannelState[] => {
    const events: FrameRxEvent[] = []
    f.attach(channel, { onEvent: event => events.push(event) })()
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

test('a bridge whose texture subscription fails throws immediately, and duplicate frame consumers are rejected', () => {
  const f = fixture()
  const taken = { onFrame: () => { throw new Error('Shared textures already have a consumer') } } satisfies SharedTextureClientExport
  expect(() => adaptFrameForwardingBridge(taken, f.remote)).toThrow('already have a consumer')
  const remove = f.attach(rx)
  expect(() => f.attach(rx)).toThrow('already has')
  remove()
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
  removeFirst()
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
  remove()
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
