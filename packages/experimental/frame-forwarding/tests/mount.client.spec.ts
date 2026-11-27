// @vitest-environment jsdom
/** The Client plugin mounts its Remote, provides the renderer-side service in the Desktop document, and relays channel states. */
import { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { SharedTextureClientExport, SharedTextureLease } from '@deepseek-ai/dsh-shared-texture/client'
import { afterEach, expect, test, vi } from 'vitest'
import * as plugin from '../src/client/mount.ts'
import type { FrameRxEvent } from '../src/client/api.ts'
import type { FrameRxId } from '../src/types.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(document, 'fullscreenElement') })

const contribution: TypertRemoteContribution = { package: '@deepseek-ai/dsh-frame-forwarding', descriptors: [] }
const rx = 'rx-1' as FrameRxId

test('exports the mount, its injections, and the renderer-side classes at runtime', () => {
  expect(Object.keys(plugin).sort()).toEqual(['inject', 'mountFrameForwarding'])
  expect(plugin.inject).toEqual(['remote'])
})

function fixture(stream: () => AsyncIterable<unknown>, textures = true) {
  const order: string[] = []
  const viewport = vi.fn(async () => ({ ok: true as const, value: { applied: true, connectionId: 1 } }))
  const events = vi.fn()
  let consumer: ((lease: SharedTextureLease) => void) | undefined
  let streamOptions: { open(signal: AbortSignal): unknown; ended(): Error } | undefined
  const remote = {
    frameForwarding: { viewport, events },
    $mount: vi.fn(async () => async () => { order.push('remote') }),
    $stream: vi.fn((options: NonNullable<typeof streamOptions>) => {
      streamOptions = options
      return { [Symbol.asyncIterator]: () => stream()[Symbol.asyncIterator](), dispose: vi.fn(async () => { order.push('events') }) }
    }),
  }
  const onFrame = (listener: (lease: SharedTextureLease) => void): (() => void) => {
    consumer = listener
    return () => { consumer = undefined }
  }
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null })
  const ctx = new Context()
  if (textures) ctx.provide('sharedTexture', { onFrame } satisfies SharedTextureClientExport)
  ctx.provide('remote', remote as never)
  ctx.provide('remote.frameForwarding', remote.frameForwarding as never)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  const deliver = (lease: SharedTextureLease): void => { if (consumer === undefined) lease.release(); else consumer(lease) }
  return { ctx, remote, viewport, events, order, warn, deliver, options: () => streamOptions!, consuming: () => consumer !== undefined }
}

test('provides no service outside the Desktop document and withdraws the Remote on dispose', async () => {
  const f = fixture(() => (async function* () {})(), false)
  const dispose = await plugin.mountFrameForwarding(f.ctx, contribution)
  expect(f.remote.$mount).toHaveBeenCalledExactlyOnceWith(contribution)
  expect(f.ctx.get('frameForwarding')).toBeUndefined()
  expect(f.remote.$stream).not.toHaveBeenCalled()
  await dispose()
  expect(f.order).toEqual(['remote'])
  await f.ctx.fiber.dispose()
})

test('connects channels that route textures by metadata, send viewports to the Host, and follow Host channel states', async () => {
  const closed = Promise.withResolvers<undefined>()
  const accept = vi.fn()
  const f = fixture(() => (async function* () {
    yield { value: { kind: 'snapshot', channels: [{ rx, sequence: 1, channel: { state: 'connected', connectionId: 1 } }] }, accept }
    await closed.promise
    yield { value: { kind: 'state', rx, sequence: 2, channel: { state: 'closed', cause: 'lost', reason: 'Desktop invalidated a presented frame' } }, accept }
  })())
  const dispose = await plugin.mountFrameForwarding(f.ctx, contribution)
  const service = f.ctx.get('frameForwarding')!
  const channel = service.connect(rx)
  await vi.waitFor(() => { expect(channel.connectionId).toBe(1) })
  await channel.setViewport({ version: 1, width: 4, height: 2, deviceScaleFactor: 1, visible: true })
  expect(f.viewport).toHaveBeenCalledWith(rx, expect.objectContaining({ version: 1 }))
  const present = vi.fn(), failure = vi.fn()
  channel.consume(present, failure)
  const lease = { frame: {} as VideoFrame, metadata: { rx, connectionId: 1, requestId: 'tile', frameId: 1, generation: 1, revision: 0, width: 4, height: 2 }, release: vi.fn() }
  const stray = { frame: {} as VideoFrame, metadata: { ...lease.metadata, rx: 'other' }, release: vi.fn() }
  f.deliver(stray)
  f.deliver(lease)
  expect(present).toHaveBeenCalledExactlyOnceWith({ image: lease.frame, metadata: lease.metadata })
  await vi.waitFor(() => { expect(lease.release).toHaveBeenCalledOnce() })
  expect(stray.release).toHaveBeenCalledOnce()
  const cancelled = new AbortController()
  const discarded = channel.ready(cancelled.signal)
  cancelled.abort()
  expect(service.discardReason(await discarded.catch((error: unknown) => error))).toBe('cancelled')
  expect(service.discardReason(new Error('other'))).toBeUndefined()
  closed.resolve(undefined)
  expect(await channel.closed).toBe('lost')
  expect(service.discardReason(failure.mock.calls[0]![0])).toBe('lost')
  expect(accept).toHaveBeenCalledTimes(2)
  const signal = new AbortController().signal
  f.options().open(signal)
  expect(f.events).toHaveBeenCalledExactlyOnceWith(signal)
  expect(f.options().ended().message).toBe('Frame-forwarding channel events ended.')
  await channel.close()
  // The Client keeps consuming Desktop's textures with no channel open, until it is disposed.
  expect(f.consuming()).toBe(true)
  await dispose()
  expect(f.consuming()).toBe(false)
  expect(f.order).toEqual(['events', 'remote'])
  await f.ctx.fiber.dispose()
})

test('a terminal event stream failure fails every channel and every later connection while the service stays provided', async () => {
  const broken = Promise.withResolvers<undefined>()
  const f = fixture(() => (async function* () {
    yield { value: { kind: 'snapshot', channels: [{ rx, sequence: 1, channel: { state: 'connected', connectionId: 1 } }] }, accept: vi.fn() }
    await broken.promise
    throw new Error('stream broke')
  })(), true)
  // The display is never flushed, so it stays reserved without selecting a presenter.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('ResizeObserver', class { disconnect = vi.fn(); observe() {} })
  vi.stubGlobal('IntersectionObserver', class { disconnect = vi.fn(); observe() {} })
  const dispose = await plugin.mountFrameForwarding(f.ctx, contribution)
  const service = f.ctx.get('frameForwarding')!
  const channel = service.connect(rx)
  await vi.waitFor(() => { expect(channel.connectionId).toBe(1) })
  const events: FrameRxEvent[] = []
  channel.onEvent(event => events.push(event))
  const element = document.createElement('div')
  document.body.append(element)
  const mountFailure = vi.fn()
  channel.mount(element, mountFailure)
  expect(element.getAttribute('data-dsh-frame-mount')).toBe('video')
  broken.resolve(undefined)
  const message = 'Frame-forwarding channel events failed: stream broke'
  expect(await channel.closed).toBe('failed')
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'stream broke' }))
  expect(events.at(-1)).toEqual({ kind: 'failure', error: message })
  expect(element.hasAttribute('data-dsh-frame-mount')).toBe(false)
  expect(mountFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message }))
  const lease = { frame: {} as VideoFrame, metadata: { rx, connectionId: 1, requestId: 'tile', frameId: 1, generation: 0, revision: 0, width: 4, height: 2 }, release: vi.fn() }
  f.deliver(lease)
  expect(lease.release).toHaveBeenCalledOnce()
  expect(f.ctx.get('frameForwarding')).toBe(service)
  const later = service.connect('rx-2' as FrameRxId)
  expect(await later.closed).toBe('failed')
  expect(() => later.consume(vi.fn(), vi.fn())).toThrow(message)
  expect(() => later.mount(element, vi.fn())).toThrow(message)
  await channel.close()
  await later.close()
  element.remove()
  await dispose()
  await f.ctx.fiber.dispose()
})

test('a terminal event stream failure that is not an Error fails channels with its text', async () => {
  const f = fixture(() => (async function* () { throw 'stream gone' })())
  const dispose = await plugin.mountFrameForwarding(f.ctx, contribution)
  await vi.waitFor(() => { expect(f.warn).toHaveBeenCalledWith('stream gone') })
  const channel = f.ctx.get('frameForwarding')!.connect(rx)
  const events: FrameRxEvent[] = []
  channel.onEvent(event => events.push(event))
  expect(await channel.closed).toBe('failed')
  // The channel failed while connecting, so a later subscription receives nothing.
  expect(events).toEqual([])
  expect(() => channel.ready()).toThrow('Frame-forwarding channel events failed: stream gone')
  await channel.close()
  await dispose()
  await f.ctx.fiber.dispose()
})

test('a failed service registration withdraws the mounted Remote contribution', async () => {
  const f = fixture(() => (async function* () {})())
  f.remote.$stream.mockImplementationOnce(() => { throw new Error('stream unavailable') })
  await expect(plugin.mountFrameForwarding(f.ctx, contribution)).rejects.toThrow('stream unavailable')
  expect(f.order).toEqual(['remote'])
  expect(f.consuming()).toBe(false)
  await f.ctx.fiber.dispose()
})
