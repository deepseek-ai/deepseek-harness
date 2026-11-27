/**
 * The Host forwarder owns channels, follows their producer connections, attaches Desktop's native sink to each
 * receiver, keeps each receiver's presentation gate current, and reports the receiver's presentation failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  FrameForwardingAdapterId, FrameForwardingBindings, FrameForwardingDeliveryId, FrameForwardingReceiver,
  FrameForwardingReceiverEvent,
} from '../src/host/native.ts'
import type { SharedTextureCapabilities, SharedTextureNativeSink, SharedTextureService } from '@deepseek-ai/dsh-shared-texture'
import { FrameForwarder } from '../src/host/forwarder.ts'
import type { FrameChannelState, FrameConnectionId, FrameForwardingEvent, FrameRxId } from '../src/types.ts'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(value: NodeJS.Platform): void { Object.defineProperty(process, 'platform', { value, configurable: true }) }

const BUDGET = 128 * 1024 * 1024
const limits = {
  maxFrames: 3, maxBytes: vi.fn(() => BUDGET), requestTimeoutMs: 10000, maxPendingRequests: 128 }
const order: string[] = []
type Deliverable = Parameters<FrameForwardingReceiver['setDeliverable']>[0]
function mockReceiver(tx: string) {
  return {
    tx,
    send: vi.fn<(connectionId: FrameConnectionId, json: string) => void>(),
    release: vi.fn((deliveryId: FrameForwardingDeliveryId) => { order.push(`release:${String(deliveryId)}`); return true }),
    attachSink: vi.fn<(rx: string, sink: unknown, timeoutMs: number) => void>(),
    setDeliverable: vi.fn<(state: Deliverable) => void>(),
    close: vi.fn(async () => {}),
  } satisfies FrameForwardingReceiver
}
const receiver = mockReceiver('1|1|secret|ai.deepseek.render.name')
let onEvent: ((event: FrameForwardingReceiverEvent) => void) | undefined
const createBudget = vi.fn(() => ({}) as ReturnType<FrameForwardingBindings['createBudget']>)
const createReceiver = vi.fn((_options: object, callback: (event: FrameForwardingReceiverEvent) => void): FrameForwardingReceiver => {
  onEvent = callback
  return receiver
})
const bindings = { createBudget, createReceiver } satisfies FrameForwardingBindings
const desktop: SharedTextureCapabilities = { supported: true }
/** An opaque sink that equality checks tell apart by `name`. */
function sink(name: string): SharedTextureNativeSink {
  const value = {} as SharedTextureNativeSink
  Object.defineProperty(value, 'name', { value: name, enumerable: true })
  return value
}
const firstSink = sink('first'), secondSink = sink('second')
const sharedTexture = {
  capabilities: vi.fn(async () => desktop),
  nativeSink: vi.fn(async (_timeoutMs: number) => firstSink),
  adapterLuid: vi.fn(async (_timeoutMs: number): Promise<string | null> => '0:1234'),
} satisfies SharedTextureService
const listeners = {
  event: vi.fn<(event: Exclude<FrameForwardingEvent, { kind: 'snapshot' }>) => void>(),
  warn: vi.fn<(message: string) => void>(),
}
let forwarder: FrameForwarder
let loadFailure: Error | undefined

beforeEach(() => {
  vi.clearAllMocks()
  setPlatform('darwin')
  order.length = 0
  onEvent = undefined
  loadFailure = undefined
  receiver.close.mockImplementation(async () => { order.push('close') })
  receiver.setDeliverable.mockImplementation((state) => { order.push(`gate:${JSON.stringify(state)}`) })
  sharedTexture.capabilities.mockResolvedValue(desktop)
  sharedTexture.nativeSink.mockResolvedValue(firstSink)
  forwarder = new FrameForwarder(sharedTexture, () => {
    if (loadFailure !== undefined) throw loadFailure
    return bindings
  }, limits, listeners)
})
afterEach(async () => {
  try {
    await forwarder.closeAll()
    if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers(); Object.defineProperty(process, 'platform', platform) }
})

const id = (value: number): FrameConnectionId => value as FrameConnectionId
const viewport = (version: number, visible = true): object => ({ version, width: 512, height: 512, deviceScaleFactor: 1, visible })
async function open(): Promise<FrameRxId> {
  return (await forwarder.channel()).rx
}
function connect(connectionId = 1): void {
  onEvent!({ type: 'connected', connectionId: id(connectionId), pid: 4000 + connectionId })
}
/** The last viewport request sent to the producer. */
function lastRequest(): { connectionId: FrameConnectionId; requestId: string; version: number } {
  const [connectionId, json] = receiver.send.mock.calls.at(-1)!
  const message = JSON.parse(json) as { requestId: string; viewport: { version: number } }
  return { connectionId, requestId: message.requestId, version: message.viewport.version }
}
function message(connectionId: number, value: object | string): void {
  onEvent!({ type: 'message', connectionId: id(connectionId), text: typeof value === 'string' ? value : JSON.stringify(value) })
}
/** Acknowledge the last viewport request from the connection it was sent to. */
function ack(): void {
  const { connectionId, requestId, version } = lastRequest()
  message(connectionId, { type: 'viewport-applied', requestId, version })
}
async function applyViewport(rx: FrameRxId, value: object): Promise<unknown> {
  const pending = forwarder.setViewport(rx, value)
  ack()
  return pending
}
/** A connected channel whose producer acknowledged viewport 1. */
async function ready(): Promise<FrameRxId> {
  const rx = await open()
  connect()
  await applyViewport(rx, viewport(1))
  return rx
}
type Frame = Extract<FrameForwardingReceiverEvent, { type: 'frame' }>
function frame(options: { connectionId?: number; deliveryId?: number } = {}): Frame {
  const { connectionId = 1, deliveryId = 7007 } = options
  return {
    type: 'frame', connectionId: id(connectionId), frameId: 7, deliveryId: deliveryId as FrameForwardingDeliveryId, width: 512, height: 512,
    stride: 2048, transport: 'shared-texture', sourceKeyedMutex: false, adapterId: '0:1234' as FrameForwardingAdapterId,
    presentationAdapterId: null, handle: Buffer.alloc(8, 0x5a), metadata: JSON.stringify({ requestId: 'tile', generation: 1, revision: 0 }),
  }
}
/** The presentation gate the forwarder last pushed to the receiver. */
const gate = (): Deliverable | undefined => receiver.setDeliverable.mock.calls.at(-1)?.[0]
const open1 = (maxGeneration: number, visible = true): Deliverable => ({ connectionId: id(1), visible, maxGeneration })
function states(rx: FrameRxId): FrameChannelState[] {
  return listeners.event.mock.calls.map(([event]) => event).filter(event => event.kind === 'state' && event.rx === rx)
    .map(event => (event as Extract<FrameForwardingEvent, { kind: 'state' }>).channel)
}
function errors(): Extract<FrameForwardingEvent, { kind: 'error' }>[] {
  return listeners.event.mock.calls.map(([event]) => event)
    .filter((event): event is Extract<FrameForwardingEvent, { kind: 'error' }> => event.kind === 'error')
}

describe('channel creation', () => {
  it('opens an ordered receiver under the shared window budget, attaches Desktop\'s sink, returns its credential, and publishes it idle', async () => {
    expect(limits.maxBytes).not.toHaveBeenCalled()
    const channel = await forwarder.channel()
    expect(channel.tx).toBe(receiver.tx)
    expect(createBudget).toHaveBeenCalledExactlyOnceWith(BUDGET)
    expect(createReceiver).toHaveBeenCalledWith(expect.objectContaining({
      maxFrames: 3, maxBytes: BUDGET, displayAdapter: null, readbackTimeoutMs: 10000,
    }), expect.any(Function))
    expect(sharedTexture.nativeSink).toHaveBeenCalledExactlyOnceWith(limits.requestTimeoutMs)
    expect(receiver.attachSink).toHaveBeenCalledExactlyOnceWith(channel.rx, firstSink, limits.requestTimeoutMs)
    expect(sharedTexture.adapterLuid).not.toHaveBeenCalled()
    expect(states(channel.rx)).toEqual([{ state: 'idle' }])
    expect(forwarder.isOpen(channel.rx)).toBe(true)
    expect(forwarder.isOpen('missing' as FrameRxId)).toBe(false)
    expect(forwarder.snapshot()).toEqual([{ rx: channel.rx, sequence: 1, channel: { state: 'idle' } }])
    // The next channel reuses the window budget and asks Desktop for the sink of its current connection, which a
    // disconnect replaced without a frame reaching this thread.
    sharedTexture.nativeSink.mockResolvedValueOnce(secondSink)
    const second = await forwarder.channel()
    expect(createBudget).toHaveBeenCalledOnce()
    expect(limits.maxBytes).toHaveBeenCalledOnce()
    expect(sharedTexture.nativeSink).toHaveBeenCalledTimes(2)
    expect(receiver.attachSink).toHaveBeenLastCalledWith(second.rx, secondSink, limits.requestTimeoutMs)
  })
  it('requests Desktop\'s sink once for channels opening together, before allocating their receivers', async () => {
    const requested = Promise.withResolvers<SharedTextureNativeSink>()
    sharedTexture.nativeSink.mockReturnValueOnce(requested.promise)
    const opening = Promise.all([forwarder.channel(), forwarder.channel()])
    await vi.waitFor(() => { expect(sharedTexture.nativeSink).toHaveBeenCalledOnce() })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(createReceiver).not.toHaveBeenCalled()
    requested.resolve(secondSink)
    const [first, second] = await opening
    expect(sharedTexture.nativeSink).toHaveBeenCalledOnce()
    expect(receiver.attachSink.mock.calls).toEqual([
      [first.rx, secondSink, limits.requestTimeoutMs], [second.rx, secondSink, limits.requestTimeoutMs],
    ])
  })
  it('gives Desktop\'s sink a presentation deadline of at most 30000 ms, also when it replaces the sink', async () => {
    forwarder = new FrameForwarder(sharedTexture, () => bindings, { ...limits, requestTimeoutMs: 60_000 }, listeners)
    const rx = await open()
    expect(sharedTexture.nativeSink).toHaveBeenCalledExactlyOnceWith(60_000)
    expect(receiver.attachSink).toHaveBeenCalledExactlyOnceWith(rx, firstSink, 30_000)
    sharedTexture.nativeSink.mockResolvedValueOnce(secondSink)
    onEvent!(frame())
    await vi.waitFor(() => { expect(receiver.attachSink).toHaveBeenLastCalledWith(rx, secondSink, 30_000) })
  })
  it('fails the channel without a receiver when Desktop provides no sink, and discards a receiver that refuses it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    sharedTexture.nativeSink.mockRejectedValueOnce(new Error('Desktop shared textures are unavailable'))
    await expect(open()).rejects.toThrow('Desktop native frame submission is unavailable: Desktop shared textures are unavailable')
    expect(createReceiver).not.toHaveBeenCalled()
    // The failed request is not cached; a non-Error refusal of the sink is reported too.
    receiver.attachSink.mockImplementationOnce(() => { throw 'Unsupported Desktop shared-texture sink ABI' })
    receiver.close.mockRejectedValueOnce(new Error('close failed'))
    await expect(open()).rejects.toThrow('Desktop native frame submission is unavailable: Unsupported Desktop shared-texture sink ABI')
    expect(log).toHaveBeenCalledWith('Native receiver teardown failed', expect.any(Error))
    expect(sharedTexture.nativeSink).toHaveBeenCalledTimes(2)
    expect(receiver.close).toHaveBeenCalledOnce()
    expect(forwarder.snapshot()).toEqual([])
    log.mockRestore()
  })
  it('gives a Windows receiver the LUID of Chromium\'s compositor adapter that Desktop reads', async () => {
    setPlatform('win32')
    await open()
    expect(sharedTexture.adapterLuid).toHaveBeenCalledExactlyOnceWith(limits.requestTimeoutMs)
    expect(createReceiver).toHaveBeenCalledWith(expect.objectContaining({ displayAdapter: '0:1234' }), expect.any(Function))
  })
  it('asks Desktop for the Windows adapter for every channel, so a later channel follows the adapter Desktop reports', async () => {
    setPlatform('win32')
    await open()
    // Desktop reads another adapter after its GPU process restarted, although no presented frame was invalidated.
    sharedTexture.adapterLuid.mockResolvedValueOnce('0:5678')
    await open()
    expect(sharedTexture.adapterLuid).toHaveBeenCalledTimes(2)
    expect(createReceiver.mock.calls.map(([options]) => (options as { displayAdapter: unknown }).displayAdapter)).toEqual(['0:1234', '0:5678'])
  })
  it('cancels a Windows creation that closeAll overtakes while Desktop reads the adapter', async () => {
    setPlatform('win32')
    const reading = Promise.withResolvers<string | null>()
    sharedTexture.adapterLuid.mockReturnValueOnce(reading.promise)
    const creation = expect(open()).rejects.toThrow('creation cancelled')
    await vi.waitFor(() => { expect(sharedTexture.adapterLuid).toHaveBeenCalledOnce() })
    const closing = forwarder.closeAll()
    reading.resolve('0:1234')
    await creation
    await closing
    expect(createReceiver).not.toHaveBeenCalled()
  })
  it('rejects an unidentified or unread Windows adapter before allocating native resources, and asks Desktop again', async () => {
    setPlatform('win32')
    sharedTexture.adapterLuid.mockResolvedValueOnce(null)
    await expect(open()).rejects.toThrow('Desktop shared textures are unavailable: Electron graphics adapter could not be identified')
    sharedTexture.adapterLuid.mockRejectedValueOnce(new Error('Desktop adapter reading timed out'))
    await expect(open()).rejects.toThrow('Desktop adapter reading timed out')
    expect(createReceiver).not.toHaveBeenCalled()
    await open()
    expect(sharedTexture.adapterLuid).toHaveBeenCalledTimes(3)
    expect(createReceiver).toHaveBeenCalledWith(expect.objectContaining({ displayAdapter: '0:1234' }), expect.any(Function))
  })
  it('refuses channels when Desktop reports textures unsupported or the addon does not load', async () => {
    sharedTexture.capabilities.mockResolvedValueOnce({ supported: false, reason: 'no-electron' })
    await expect(open()).rejects.toThrow('unavailable: no-electron')
    sharedTexture.capabilities.mockResolvedValueOnce({ supported: false })
    await expect(open()).rejects.toThrow('Desktop shared textures are unavailable: unsupported')
    loadFailure = new Error('frame-forwarding.node is missing')
    const unloaded = new FrameForwarder(sharedTexture, () => { throw loadFailure! }, limits, listeners)
    expect(await unloaded.capabilities()).toEqual({ supported: false, reason: 'receiver-unavailable: frame-forwarding.node is missing' })
    await expect(unloaded.channel()).rejects.toThrow('receiver is unavailable')
    expect(createReceiver).not.toHaveBeenCalled()
    expect(limits.maxBytes).not.toHaveBeenCalled()
  })
  it.each(['darwin', 'win32'] as const)('reports capability on %s from Desktop and the addon', async (value) => {
    setPlatform(value)
    expect(await forwarder.capabilities()).toEqual({ supported: true })
    sharedTexture.capabilities.mockResolvedValueOnce({ supported: false, reason: 'desktop-says-no' })
    expect(await forwarder.capabilities()).toEqual({ supported: false, reason: 'desktop-says-no' })
    sharedTexture.capabilities.mockResolvedValueOnce({ supported: false })
    expect(await forwarder.capabilities()).toEqual({ supported: false, reason: 'desktop-shared-texture-unavailable' })
  })
  it('reports other platforms unsupported without asking Desktop', async () => {
    setPlatform('linux')
    expect(await forwarder.capabilities()).toEqual({ supported: false, reason: 'unsupported-platform' })
    expect(sharedTexture.capabilities).not.toHaveBeenCalled()
  })
  it('cancels a creation that outlives closeAll', async () => {
    const probing = Promise.withResolvers<SharedTextureCapabilities>()
    sharedTexture.capabilities.mockReturnValueOnce(probing.promise)
    const creation = open()
    const rejected = expect(creation).rejects.toThrow('creation cancelled')
    const closing = forwarder.closeAll()
    await expect(forwarder.channel()).rejects.toThrow('closing')
    probing.resolve(desktop)
    await rejected
    await closing
    expect(createReceiver).not.toHaveBeenCalled()
  })
  it('cancels a creation that closeAll overtakes while Desktop\'s sink is requested, before allocating its receiver', async () => {
    const requested = Promise.withResolvers<SharedTextureNativeSink>()
    sharedTexture.nativeSink.mockReturnValueOnce(requested.promise)
    const creation = open()
    const rejected = expect(creation).rejects.toThrow('creation cancelled')
    await vi.waitFor(() => { expect(sharedTexture.nativeSink).toHaveBeenCalledOnce() })
    const closing = forwarder.closeAll()
    requested.resolve(firstSink)
    await rejected
    await closing
    expect(createReceiver).not.toHaveBeenCalled()
    expect(order).toEqual([])
  })
})

describe('producer connections', () => {
  it('applies a viewport submitted while idle once the producer connects and publishes the version it acknowledged', async () => {
    const rx = await open()
    expect(await forwarder.setViewport(rx, viewport(1))).toEqual({ applied: false, reason: 'no-producer' })
    const stale = { applied: false, reason: 'stale-viewport', currentVersion: 1 }
    expect(await forwarder.setViewport(rx, viewport(1))).toEqual(stale)
    expect(receiver.send).not.toHaveBeenCalled()
    connect()
    expect(await forwarder.setViewport(rx, viewport(1))).toEqual(stale)
    expect(lastRequest()).toMatchObject({ connectionId: 1, version: 1 })
    expect(states(rx).at(-1)).toEqual({ state: 'connected', connectionId: 1 })
    ack()
    expect(states(rx).at(-1)).toEqual({ state: 'connected', connectionId: 1, viewportVersion: 1 })
    expect(await applyViewport(rx, viewport(2))).toEqual({ applied: true, connectionId: 1 })
    expect(states(rx).at(-1)).toEqual({ state: 'connected', connectionId: 1, viewportVersion: 2 })
  })
  it('closes the channel permanently when its producer disconnects, distinguishing clean disconnect from error disconnect', async () => {
    const failed = await ready()
    const pending = expect(forwarder.setViewport(failed, viewport(2))).rejects.toThrow('Native channel closed')
    onEvent!({ type: 'disconnected', connectionId: id(99) })
    expect(forwarder.isOpen(failed)).toBe(true)
    onEvent!({ type: 'disconnected', connectionId: id(1), text: 'connection lost' })
    await pending
    expect(listeners.warn).toHaveBeenCalledWith('Native producer 1 disconnected: connection lost')
    expect(forwarder.isOpen(failed)).toBe(false)
    expect(states(failed).at(-1)).toEqual({
      state: 'closed', cause: 'failed', reason: 'Native producer disconnected: connection lost',
    })
    await vi.waitFor(() => { expect(forwarder.snapshot()).toEqual([]) })
    const clean = await ready()
    onEvent!({ type: 'disconnected', connectionId: id(1) })
    expect(forwarder.isOpen(clean)).toBe(false)
    expect(states(clean).at(-1)).toEqual({
      state: 'closed', cause: 'closed', reason: 'Native producer disconnected',
    })
    expect(listeners.warn).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(forwarder.snapshot()).toEqual([]) })
  })
  it('fails the channel if an unexpected second producer connects and rejects sends the addon refuses', async () => {
    const rx = await ready()
    receiver.send.mockImplementationOnce(() => { throw new Error('Frame-forwarding connection is not active') })
    await expect(forwarder.setViewport(rx, viewport(2))).rejects.toThrow('Native channel is closed')
    connect(2)
    expect(forwarder.isOpen(rx)).toBe(false)
    expect(states(rx).at(-1)).toEqual({
      state: 'closed', cause: 'failed', reason: 'Native channel received an unexpected second producer',
    })
    await vi.waitFor(() => { expect(forwarder.snapshot()).toEqual([]) })
  })
  it('rejects a timed-out or refused viewport while the channel stays open, and still confirms a late acknowledgement', async () => {
    vi.useFakeTimers()
    const bounded = new FrameForwarder(sharedTexture, () => bindings,
      { ...limits, requestTimeoutMs: 100, maxPendingRequests: 1 }, listeners)
    const rx = (await bounded.channel()).rx
    connect()
    const timedOut = expect(bounded.setViewport(rx, viewport(1))).rejects.toThrow('acknowledgement timed out')
    const late = lastRequest()
    await expect(bounded.setViewport(rx, viewport(2))).rejects.toThrow('queue is full')
    await vi.advanceTimersByTimeAsync(100)
    await timedOut
    expect(bounded.isOpen(rx)).toBe(true)
    message(1, { type: 'viewport-applied', requestId: late.requestId, version: late.version })
    expect(states(rx).at(-1)).toEqual({ state: 'connected', connectionId: 1, viewportVersion: 1 })
    const rejected = expect(bounded.setViewport(rx, viewport(3))).rejects.toThrow('too large')
    message(1, { type: 'viewport-rejected', requestId: lastRequest().requestId, error: 'too large' })
    await rejected
    const unnamed = expect(bounded.setViewport(rx, viewport(4))).rejects.toThrow('Native producer rejected viewport')
    message(1, { type: 'viewport-rejected', requestId: lastRequest().requestId })
    await unnamed
    expect(bounded.isOpen(rx)).toBe(true)
    await bounded.closeAll()
  })
  it('validates viewports, requires increasing versions, and refuses closed channels', async () => {
    const rx = await ready()
    await expect(forwarder.setViewport('missing' as FrameRxId, viewport(2))).rejects.toThrow('channel is closed')
    await expect(forwarder.setViewport(rx, { ...viewport(2), width: 0 })).rejects.toThrow()
    await expect(forwarder.setViewport(rx, viewport(1))).resolves.toEqual({ applied: false, reason: 'stale-viewport', currentVersion: 1 })
    await forwarder.close(rx)
    await expect(forwarder.setViewport(rx, viewport(2))).rejects.toThrow('channel is closed')
  })
  it('warns when an initial viewport fails, but not when the channel closed meanwhile', async () => {
    vi.useFakeTimers()
    const first = await open()
    await forwarder.setViewport(first, viewport(1))
    connect()
    await vi.advanceTimersByTimeAsync(limits.requestTimeoutMs)
    expect(listeners.warn).toHaveBeenCalledExactlyOnceWith('Native initial viewport apply failed: Native producer acknowledgement timed out')
    const second = await open()
    await forwarder.setViewport(second, viewport(1))
    connect()
    onEvent!({ type: 'disconnected', connectionId: id(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(listeners.warn).toHaveBeenCalledOnce()
  })
  it('reports producer errors and invalid control messages of the connected producer only', async () => {
    const rx = await ready()
    message(1, { type: 'error', message: 'PPT stream rendering failed' })
    message(1, { type: 'error' })
    message(1, '{')
    message(1, 'null')
    message(1, '[]')
    message(2, { type: 'error', message: 'not current' })
    for (const value of [{ type: 'input-applied' }, { type: 'viewport-applied' }, { type: 'viewport-applied', requestId: 'missing', version: 'x' }])
      message(1, value)
    expect(errors().map(({ error }) => error)).toEqual([
      'PPT stream rendering failed', 'Native producer failed', 'Native producer sent an invalid control message',
      'Native producer sent an invalid control message', 'Native producer sent an invalid control message',
    ])
    expect(errors().every(event => event.rx === rx && event.connectionId === 1 && event.source === 'producer')).toBe(true)
    expect(states(rx).at(-1)).toEqual({ state: 'connected', connectionId: 1, viewportVersion: 1 })
  })
  it('reports refusals and blocked drains, and closes a channel whose listener failed', async () => {
    const rx = await ready()
    onEvent!({ type: 'rejected', text: 'channel-busy' })
    expect(listeners.warn).toHaveBeenCalledWith('Native producer refused: channel-busy')
    onEvent!({ type: 'drain-blocked', connectionId: id(1), text: 'GPU cleanup is stalled' })
    expect(listeners.warn).toHaveBeenCalledWith('Native producer 1 drain is blocked: GPU cleanup is stalled')
    expect(states(rx).at(-1)).toEqual({ state: 'connected', connectionId: 1, viewportVersion: 1 })
    onEvent!({ type: 'failed', text: 'listener failed' })
    expect(forwarder.isOpen(rx)).toBe(false)
    expect(states(rx).at(-1)).toEqual({ state: 'closed', cause: 'failed', reason: 'Native channel failed: listener failed' })
    await vi.waitFor(() => { expect(forwarder.snapshot()).toEqual([]) })
    onEvent!({ type: 'drained', connectionId: id(1) })
    // A frame of a forgotten channel returns its credit without asking Desktop for a sink.
    onEvent!(frame())
    expect(receiver.release).toHaveBeenCalledExactlyOnceWith(7007)
    expect(sharedTexture.nativeSink).toHaveBeenCalledOnce()
    expect(states(rx).at(-1)).toEqual({ state: 'closed', cause: 'failed', reason: 'Native channel failed: listener failed' })
  })
})

describe('presentation gate', () => {
  it('admits each viewport\'s generation before sending it, without waiting for its acknowledgement', async () => {
    const rx = await open()
    expect(receiver.setDeliverable).not.toHaveBeenCalled()
    await forwarder.setViewport(rx, viewport(1))
    expect(gate()).toBeNull()
    // A producer's frame can reach the receiver before its acknowledgement reaches this thread.
    const atSend: unknown[] = []
    receiver.send.mockImplementationOnce(() => { atSend.push(gate()) }).mockImplementationOnce(() => { atSend.push(gate()) })
    connect()
    const replay = lastRequest()
    const pending = forwarder.setViewport(rx, viewport(2))
    expect(atSend).toEqual([open1(1), open1(2)])
    message(1, { type: 'viewport-applied', requestId: replay.requestId, version: 1 })
    ack()
    await pending
    // Acknowledgements leave the gate alone, including one of a version the renderer never sent.
    const pushed = receiver.setDeliverable.mock.calls.length
    message(1, { type: 'viewport-applied', requestId: 'forged', version: 5 })
    expect(receiver.setDeliverable).toHaveBeenCalledTimes(pushed)
    expect(gate()).toEqual(open1(2))
    await applyViewport(rx, viewport(3, false))
    expect(gate()).toEqual(open1(3, false))
    await applyViewport(rx, viewport(4))
    expect(gate()).toEqual(open1(4))
  })
  it('closes when the producer disconnects or the channel closes', async () => {
    const disconnected = await ready()
    onEvent!({ type: 'disconnected', connectionId: id(1) })
    expect(gate()).toBeNull()
    expect(order.slice(-2)).toEqual(['gate:null', 'close'])
    await vi.waitFor(() => { expect(forwarder.snapshot()).toEqual([]) })
    expect(forwarder.isOpen(disconnected)).toBe(false)
    const explicit = await ready()
    await forwarder.close(explicit)
    expect(order.slice(-2)).toEqual(['gate:null', 'close'])
  })
})

describe('frames delivered to JavaScript', () => {
  it('returns the frame\'s credit at once and attaches a new Desktop sink to every open channel', async () => {
    const first = await ready()
    const onFirst = onEvent!
    const other = mockReceiver('1|1|other|ai.deepseek.render.other')
    createReceiver.mockImplementationOnce(() => other)
    const second = (await forwarder.channel()).rx
    // A closing channel receives no sink.
    const closingRx = await open()
    const closed = Promise.withResolvers<undefined>()
    receiver.close.mockReturnValueOnce(closed.promise)
    const closing = forwarder.close(closingRx)
    receiver.attachSink.mockClear()
    // Desktop's service replaced its connection, so every later request returns the new sink.
    sharedTexture.nativeSink.mockResolvedValue(secondSink)
    onFirst(frame())
    expect(receiver.release).toHaveBeenCalledExactlyOnceWith(7007)
    await vi.waitFor(() => { expect(other.attachSink).toHaveBeenLastCalledWith(second, secondSink, limits.requestTimeoutMs) })
    expect(receiver.attachSink.mock.calls).toEqual([[first, secondSink, limits.requestTimeoutMs]])
    closed.resolve(undefined)
    await closing
    expect(sharedTexture.nativeSink).toHaveBeenCalledTimes(4)
    // The next channel asks Desktop again and gets the sink of its current connection.
    await open()
    expect(sharedTexture.nativeSink).toHaveBeenCalledTimes(5)
    expect(receiver.attachSink).toHaveBeenLastCalledWith(expect.any(String), secondSink, limits.requestTimeoutMs)
  })
  it('requests one sink for frames arriving while a request is outstanding, and reports a channel that refuses it', async () => {
    const rx = await ready()
    const requested = Promise.withResolvers<SharedTextureNativeSink>()
    sharedTexture.nativeSink.mockReturnValueOnce(requested.promise)
    onEvent!(frame())
    onEvent!(frame({ deliveryId: 7008 }))
    expect(receiver.release.mock.calls).toEqual([[7007], [7008]])
    expect(sharedTexture.nativeSink).toHaveBeenCalledTimes(2)
    receiver.attachSink.mockImplementationOnce(() => { throw new Error('Unsupported Desktop shared-texture sink ABI') })
    requested.resolve(secondSink)
    await vi.waitFor(() => {
      expect(listeners.warn).toHaveBeenCalledExactlyOnceWith('Native channel could not attach Desktop\'s sink: Unsupported Desktop shared-texture sink ABI')
    })
    expect(forwarder.isOpen(rx)).toBe(true)
  })
  it('warns when Desktop provides no sink and requests again only on the next frame', async () => {
    await ready()
    sharedTexture.nativeSink.mockRejectedValueOnce(new Error('Desktop connection is lost'))
    onEvent!(frame())
    await vi.waitFor(() => {
      expect(listeners.warn).toHaveBeenCalledExactlyOnceWith('Desktop native frame submission is unavailable: Desktop connection is lost')
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sharedTexture.nativeSink).toHaveBeenCalledTimes(2)
    onEvent!(frame({ deliveryId: 7008 }))
    await vi.waitFor(() => { expect(receiver.attachSink).toHaveBeenCalledTimes(2) })
    expect(sharedTexture.nativeSink).toHaveBeenCalledTimes(3)
  })
  it('requests no sink while every channel closes', async () => {
    await ready()
    const closing = Promise.withResolvers<undefined>()
    receiver.close.mockReturnValueOnce(closing.promise)
    const resetting = forwarder.closeAll()
    onEvent!(frame())
    expect(receiver.release).toHaveBeenCalledExactlyOnceWith(7007)
    closing.resolve(undefined)
    await resetting
    expect(sharedTexture.nativeSink).toHaveBeenCalledOnce()
  })
})

describe('presentation events', () => {
  it('reports the receiver\'s presentation errors with their source and request', async () => {
    const rx = await ready()
    onEvent!({ type: 'presentation-error', connectionId: id(1), source: 'presentation', requestId: 'tile', text: 'Native frame transfer failed (source=0:1, presentation=IOSurface): renderer import failed' })
    onEvent!({ type: 'presentation-error', connectionId: id(1), source: 'producer', text: 'Invalid native frame metadata: metadata is not valid JSON' })
    expect(errors()).toEqual([
      { kind: 'error', rx, connectionId: 1, source: 'presentation', requestId: 'tile', error: 'Native frame transfer failed (source=0:1, presentation=IOSurface): renderer import failed' },
      { kind: 'error', rx, connectionId: 1, source: 'producer', error: 'Invalid native frame metadata: metadata is not valid JSON' },
    ])
    expect(forwarder.isOpen(rx)).toBe(true)
  })
  it('closes the channel as lost when Desktop invalidated a presented frame', async () => {
    const rx = await ready()
    onEvent!({ type: 'presentation-invalidated', connectionId: id(1), text: 'Desktop invalidated a presented frame' })
    expect(forwarder.isOpen(rx)).toBe(false)
    expect(states(rx).at(-1)).toEqual({ state: 'closed', cause: 'lost', reason: 'Desktop invalidated a presented frame' })
    await vi.waitFor(() => { expect(forwarder.snapshot()).toEqual([]) })
    expect(receiver.close).toHaveBeenCalledOnce()
  })
})

describe('teardown', () => {
  it('closes a channel once, ending its connection and rejecting its pending requests', async () => {
    const rx = await ready()
    const pending = expect(forwarder.setViewport(rx, viewport(2))).rejects.toThrow('Native channel closed')
    const first = forwarder.close(rx)
    expect(forwarder.close(rx)).toStrictEqual(first)
    await first
    await pending
    await forwarder.close(rx)
    expect(receiver.close).toHaveBeenCalledOnce()
    expect(states(rx).filter(state => state.state === 'closed')).toEqual([{ state: 'closed', cause: 'closed', reason: 'Native channel closed' }])
  })
  it('ignores connection events and messages while a channel closes', async () => {
    const rx = await open()
    const closing = Promise.withResolvers<undefined>()
    receiver.close.mockReturnValueOnce(closing.promise)
    const closed = forwarder.close(rx)
    connect()
    onEvent!({ type: 'disconnected', connectionId: id(1) })
    onEvent!({ type: 'drained', connectionId: id(1) })
    onEvent!({ type: 'drain-blocked', connectionId: id(1), text: 'stalled' })
    message(1, { type: 'error', message: 'late' })
    expect(states(rx)).toEqual([{ state: 'idle' }, { state: 'closed', cause: 'closed', reason: 'Native channel closed' }])
    expect(forwarder.snapshot()).toEqual([{ rx, sequence: 2, channel: { state: 'closed', cause: 'closed', reason: 'Native channel closed' } }])
    closing.resolve(undefined)
    await closed
  })
  it('contains throwing listeners and asynchronous receiver teardown failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rx = await ready()
    listeners.event.mockImplementationOnce(() => { throw new Error('listener exploded') })
    listeners.warn.mockImplementationOnce(() => { throw new Error('logger exploded') })
    receiver.close.mockRejectedValueOnce(new Error('close failed'))
    onEvent!({ type: 'rejected', text: 'channel-busy' })
    onEvent!({ type: 'failed', text: 'device lost' })
    await vi.waitFor(() => { expect(log).toHaveBeenCalledWith('Native receiver teardown failed', expect.any(Error)) })
    expect(log).toHaveBeenCalledWith('Native channel event listener failed', expect.any(Error))
    expect(log).toHaveBeenCalledWith('Native channel warning listener failed', expect.any(Error))
    expect(forwarder.isOpen(rx)).toBe(false)
    const invalidated = await ready()
    receiver.close.mockRejectedValueOnce(new Error('close failed again'))
    onEvent!({ type: 'presentation-invalidated', connectionId: id(1) })
    await vi.waitFor(() => { expect(log).toHaveBeenCalledTimes(4) })
    expect(forwarder.isOpen(invalidated)).toBe(false)
    log.mockRestore()
  })
  it('contains native close failures and waits for a failed cleanup before accepting new channels', async () => {
    await ready()
    receiver.close.mockRejectedValueOnce(new Error('native close failed'))
    const closing = forwarder.closeAll()
    await expect(forwarder.channel()).rejects.toThrow('closing')
    await expect(closing).rejects.toThrow('cleanup failed')
    await open()
  })
})

describe('concurrent channels', () => {
  it('keeps each channel\'s producer, viewports, gate, and closure to itself', async () => {
    const first = await ready()
    const second = mockReceiver('1|1|other|ai.deepseek.render.other')
    let onSecond: ((event: FrameForwardingReceiverEvent) => void) | undefined
    createReceiver.mockImplementationOnce((_options, callback) => { onSecond = callback; return second })
    const other = (await forwarder.channel()).rx
    // Both channels open under the one window budget.
    expect(createBudget).toHaveBeenCalledOnce()
    expect(second.attachSink).toHaveBeenCalledExactlyOnceWith(other, firstSink, limits.requestTimeoutMs)
    onSecond!({ type: 'connected', connectionId: id(1), pid: 5001 })
    const applying = forwarder.setViewport(other, viewport(1, false))
    const [connectionId, json] = second.send.mock.calls.at(-1)!
    const { requestId } = JSON.parse(json) as { requestId: string }
    onSecond!({ type: 'message', connectionId, text: JSON.stringify({ type: 'viewport-applied', requestId, version: 1 }) })
    expect(await applying).toEqual({ applied: true, connectionId: 1 })
    expect(receiver.send).toHaveBeenCalledOnce()
    expect(second.setDeliverable).toHaveBeenLastCalledWith(open1(1, false))
    expect(gate()).toEqual(open1(1))
    // Closing one channel leaves the other serving its producer.
    await forwarder.close(first)
    expect(receiver.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    expect(forwarder.isOpen(other)).toBe(true)
    expect(second.setDeliverable).toHaveBeenLastCalledWith(open1(1, false))
  })
})
