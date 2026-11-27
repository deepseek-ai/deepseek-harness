/**
 * The built receiver presents frames of a real producer through a Desktop shared-texture sink in native code: a test
 * addon implements the sink ABI of Desktop's `shared-texture-sink.h` and answers each presentation. Covers the frame
 * metadata, credit return on release, the presentation gate, invalid producer metadata, failed deliveries, an
 * invalidated settlement that stops the channel before releasing the frame, a rejected presentation that keeps the
 * sink, a disconnected sink that is detached, answers inside `present`, ABI checks that refuse a sink of another magic
 * or of version 1 or 3, argument checks, the sink references of attaching and presenting, and settlements that arrive
 * after the receiver was closed and collected. On Windows, a receiver closes without waiting out the handshake of a
 * connected client that has not sent its hello. With Desktop's addons built, frames cross Desktop's real hop sink into
 * Desktop's ingress.
 */
import { receiverAddon } from './desktop-receiver.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadFrameForwardingBindings } from '../src/host/native.ts'
import type { FrameForwardingAdapterId, FrameForwardingBindings, FrameForwardingReceiver, FrameForwardingReceiverEvent } from '../src/host/native.ts'
import type { FrameConnectionId } from '../src/types.ts'
import { buildFakeSink, buildFixtureProducer, type FakeSinkAddon } from './fake-sink.ts'

const addon = receiverAddon
const platform = `${process.platform}-${process.arch}`
const desktopNative = fileURLToPath(new URL(`../../../../apps/desktop/lib/native/${platform}/`, import.meta.url))
const desktopIngress = join(desktopNative, 'shared-texture-ingress.node')
const desktopHop = join(desktopNative, 'shared-texture-hop.node')
const supported = (process.platform === 'darwin' || process.platform === 'win32') && existsSync(addon)
type Event = FrameForwardingReceiverEvent
const connection = (value: number) => value as FrameConnectionId

// Run `pnpm --filter @deepseek-ai/dsh-desktop run build:native` first; Windows needs the Visual Studio C++ tools.
describe.skipIf(!supported)('Desktop sink bridge of the built frame-forwarding receiver', () => {
  let scratch = ''
  let producer = ''
  let fakes: FakeSinkAddon
  let bindings: FrameForwardingBindings
  let displayAdapter: FrameForwardingAdapterId | null = null
  const children: ChildProcess[] = []

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-frame-forwarding-bridge-'))
    const built = buildFakeSink(scratch)
    fakes = built.fakes
    producer = buildFixtureProducer(scratch, 'producer', built.run)
    if (process.platform === 'win32') {
      displayAdapter = fakes.defaultAdapter() as FrameForwardingAdapterId | null
      expect(displayAdapter, 'a Windows receiver needs a hardware D3D11 adapter').not.toBeNull()
    }
    bindings = loadFrameForwardingBindings(addon)
  }, 180_000)
  afterAll(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }))
    if (!scratch) return
    try {
      await rm(scratch, { recursive: true, force: true })
    } catch (error) {
      // Windows keeps the loaded test addon's file open until this worker exits; the other build outputs are gone.
      if (process.platform !== 'win32' || !(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error
    }
  })

  /** One receiver with a fresh sink attached, whose events are read in order; a channel failure fails the read. */
  function channel(rx = 'rx-bridge') {
    const queued: Event[] = []
    const waiters: ((event: Event) => void)[] = []
    const receiver = bindings.createReceiver({
      maxFrames: 1, maxBytes: 65536, budget: bindings.createBudget(65536), displayAdapter, readbackTimeoutMs: 10_000,
    }, (event) => { const waiter = waiters.shift(); if (waiter === undefined) queued.push(event); else waiter(event) })
    const next = async <T extends Event['type']>(type: T, match: (event: Extract<Event, { type: T }>) => boolean = () => true): Promise<Extract<Event, { type: T }>> => {
      for (;;) {
        const event = queued.shift() ?? await new Promise<Event>((resolve) => { waiters.push(resolve) })
        if (event.type === 'failed' && type !== 'failed') throw new Error(event.text)
        if (event.type === type && match(event as Extract<Event, { type: T }>)) return event as Extract<Event, { type: T }>
      }
    }
    const fake = fakes.create()
    receiver.attachSink(rx, fake.sink, 5000)
    /** Wait for the producer to report submitting `frame`; its credit for the previous frame must have returned. */
    const submitted = (frame: number) => next('message', event => event.text === JSON.stringify({ submitted: frame }))
    const render = (metadata: object | string) => {
      receiver.send(connection(1), `render ${typeof metadata === 'string' ? metadata : JSON.stringify(metadata)}`)
    }
    return { receiver, next, queued, fake, rx, submitted, render, presented: () => fakes.presented(fake.native) }
  }
  function start(receiver: FrameForwardingReceiver) {
    const child = spawn(producer, [receiver.tx], { stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    return { child, exited: once(child, 'exit'), stderr: () => stderr }
  }
  const frame = (requestId: string, generation = 1, revision = 0) => ({ requestId, generation, revision })
  const open = (maxGeneration = 5) => ({ connectionId: connection(1), visible: true, maxGeneration })
  /** Connect a producer and consume the presentation error of its first frame, whose metadata names no request. */
  async function connected(context: ReturnType<typeof channel>) {
    const process = start(context.receiver)
    await context.next('connected')
    expect(await context.next('presentation-error')).toEqual({
      type: 'presentation-error', connectionId: 1, source: 'producer',
      text: 'Invalid native frame metadata: requestId must be a string of 1 to 512 characters',
    })
    return process
  }

  it('presents a frame with its identity as metadata and returns its credit once Desktop releases it', async () => {
    const context = channel()
    const { receiver, fake, rx } = context
    expect(fakes.references(fake.native)).toEqual({ refs: 2, retains: 1, releases: 0 })
    receiver.setDeliverable(open())
    try {
      await connected(context)
      context.render({ ...frame('tile-α', 3, 2), extra: true })
      await context.submitted(2)
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(1) })
      const [presented] = context.presented()
      expect(Object.entries(JSON.parse(presented!.metadata) as object)).toEqual(Object.entries({
        requestId: 'tile-α', generation: 3, revision: 2, rx, connectionId: 1, frameId: 2, width: 64, height: 64,
      }))
      expect({ ...presented, id: undefined, metadata: undefined, handle: undefined })
        .toEqual({ width: 64, height: 64, timeoutMs: 5000, pixelFormat: 0 })
      expect(presented!.handle.readBigUInt64LE()).not.toBe(0n)
      // Desktop holds the only credit, so the producer cannot submit its next frame.
      context.render(frame('second', 3, 3))
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(context.presented()).toHaveLength(1)
      fakes.answer(fake.native, presented!.id, 'delivered', null)
      fakes.answer(fake.native, presented!.id, 'settled', false)
      await context.submitted(3)
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(2) })
      expect(JSON.parse(context.presented()[1]!.metadata)).toMatchObject({ requestId: 'second', frameId: 3 })
      // The attach holds the only reference the bridge takes; presenting frames retains nothing more.
      expect(fakes.references(fake.native)).toEqual({ refs: 2, retains: 1, releases: 0 })
      expect(context.queued.filter(event => event.type === 'frame' || event.type === 'presentation-error')).toEqual([])
      receiver.send(connection(1), 'exit')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('returns the credit of frames outside the deliverable state without presenting them', async () => {
    const context = channel()
    const { receiver } = context
    try {
      await connected(context)
      const gates = [null, { ...open(), visible: false }, { ...open(), connectionId: connection(2) }, open(2)]
      for (const [index, gate] of gates.entries()) {
        receiver.setDeliverable(gate)
        context.render(frame(`gated-${String(index)}`, 3))
        await context.submitted(index + 2)
      }
      // Invalid metadata is reported only after the last gated frame returned its credit.
      context.render('not json')
      expect(await context.next('presentation-error')).toMatchObject({ source: 'producer', text: 'Invalid native frame metadata: metadata is not valid JSON' })
      receiver.setDeliverable(open(3))
      context.render(frame('visible', 3))
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(1) })
      expect(JSON.parse(context.presented()[0]!.metadata)).toMatchObject({ requestId: 'visible', generation: 3 })
      expect(context.queued.filter(event => event.type === 'frame')).toEqual([])
      receiver.send(connection(1), 'exit')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('reports a failed delivery, then stops the channel before releasing a frame Desktop invalidated', async () => {
    const context = channel()
    const { receiver, fake } = context
    receiver.setDeliverable(open())
    try {
      const producerProcess = await connected(context)
      context.render(frame('lost'))
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(1) })
      const { id } = context.presented()[0]!
      fakes.answer(fake.native, id, 'delivered', 'renderer import failed')
      const failed = await context.next('presentation-error')
      expect(failed).toMatchObject({ connectionId: 1, source: 'presentation', requestId: 'lost' })
      expect(failed.text).toMatch(/^Native frame transfer failed \(source=.+, presentation=.+\): renderer import failed$/u)
      context.render(frame('after-loss'))
      fakes.answer(fake.native, id, 'settled', true)
      expect(await context.next('presentation-invalidated')).toEqual({
        type: 'presentation-invalidated', connectionId: 1, text: 'Desktop invalidated a presented frame',
      })
      // The stopped channel ends the producer's connection without returning the invalidated frame's credit.
      expect((await context.next('disconnected')).connectionId).toBe(1)
      expect(await producerProcess.exited).toEqual([0, null])
      expect(context.presented()).toHaveLength(1)
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('returns the credit of a rejected frame and keeps presenting later frames through the same sink', async () => {
    const context = channel()
    const { receiver, fake } = context
    receiver.setDeliverable(open())
    try {
      await connected(context)
      fakes.refuseNext(fake.native, 'Desktop shared-texture presentation limit reached', 1)
      context.render(frame('rejected'))
      const rejected = await context.next('presentation-error')
      expect(rejected).toMatchObject({ source: 'presentation', requestId: 'rejected' })
      expect(rejected.text).toContain('Desktop shared-texture presentation limit reached')
      // The sink stays attached and holds only its attach reference.
      expect(fakes.references(fake.native)).toEqual({ refs: 2, retains: 1, releases: 0 })
      context.render(frame('kept'))
      // The producer submits the next frame only once the rejected frame's credit returned.
      await context.submitted(3)
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(1) })
      expect(JSON.parse(context.presented()[0]!.metadata)).toMatchObject({ requestId: 'kept', frameId: 3 })
      expect(context.queued.filter(event => event.type === 'frame')).toEqual([])
      receiver.send(connection(1), 'exit')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('returns the credit of a frame whose sink disconnected, detaches the sink, and delivers later frames to JavaScript', async () => {
    const context = channel()
    const { receiver, fake, rx } = context
    receiver.setDeliverable(open())
    try {
      await connected(context)
      fakes.refuseNext(fake.native, 'Desktop shared-texture ingress disconnected', 2)
      context.render(frame('refused'))
      const refused = await context.next('presentation-error')
      expect(refused).toMatchObject({ source: 'presentation', requestId: 'refused' })
      expect(refused.text).toContain('Desktop shared-texture ingress disconnected')
      // The detached attach released its reference; only the sink external's own reference remains.
      expect(fakes.references(fake.native)).toEqual({ refs: 1, retains: 1, releases: 1 })
      context.render(frame('unattached'))
      const delivered = await context.next('frame')
      expect(JSON.parse(delivered.metadata)).toMatchObject({ requestId: 'unattached' })
      expect(receiver.release(delivered.deliveryId)).toBe(true)
      receiver.attachSink(rx, fake.sink, 5000)
      expect(fakes.references(fake.native)).toEqual({ refs: 2, retains: 2, releases: 1 })
      context.render(frame('reattached'))
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(1) })
      expect(JSON.parse(context.presented()[0]!.metadata)).toMatchObject({ requestId: 'reattached' })
      receiver.send(connection(1), 'exit')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('accepts a delivery and release that Desktop reports before present returns', async () => {
    const context = channel()
    const { receiver, fake } = context
    fakes.answerInline(fake.native, true)
    receiver.setDeliverable(open())
    try {
      await connected(context)
      for (const [index, requestId] of ['inline-1', 'inline-2', 'inline-3'].entries()) {
        context.render(frame(requestId))
        await context.submitted(index + 2)
      }
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(3) })
      receiver.send(connection(1), 'exit')
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('refuses a sink of another ABI and invalid attach or gate arguments', async () => {
    const { receiver, fake } = channel()
    try {
      const refused = [fakes.create({ magic: 0x12345678 }), fakes.create({ version: 1 }), fakes.create({ version: 3 })]
      for (const other of refused)
        expect(() => { receiver.attachSink('rx', other.sink, 5000) }).toThrow('Unsupported Desktop shared-texture sink ABI')
      expect(refused.map(other => fakes.references(other.native).retains)).toEqual([0, 0, 0])
      expect(() => { receiver.attachSink('rx', {}, 5000) }).toThrow('Expected a Desktop shared-texture sink external')
      for (const rx of ['', 'x'.repeat(129), 'rx-é', 'rx\n'])
        expect(() => { receiver.attachSink(rx, fake.sink, 5000) }).toThrow('Expected an rx of 1 to 128 printable ASCII characters')
      for (const timeout of [0, 30_001, 1.5, Number.NaN])
        expect(() => { receiver.attachSink('rx', fake.sink, timeout) }).toThrow('Expected a presentation timeout of 1 to 30000 ms')
      receiver.attachSink('x'.repeat(128), fake.sink, 30_000)
      // Attaching again replaces the previous reference.
      expect(fakes.references(fake.native)).toEqual({ refs: 2, retains: 2, releases: 1 })
      const invalid = [
        {}, { connectionId: 0, visible: true, maxGeneration: 0 }, { connectionId: 1, visible: 1, maxGeneration: 0 },
        { connectionId: 1, visible: true, maxGeneration: -1 }, { connectionId: 1, visible: true, maxGeneration: 2 ** 53 },
        { connectionId: 1, visible: true },
      ]
      for (const state of invalid) {
        expect(() => { receiver.setDeliverable(state as never) }).toThrow('Expected { connectionId, visible, maxGeneration } or null')
      }
      expect(() => { receiver.setDeliverable('open' as never) }).toThrow('Expected { connectionId, visible, maxGeneration } or null')
      receiver.setDeliverable({ connectionId: connection(1), visible: false, maxGeneration: 0 })
      receiver.setDeliverable(null)
    } finally {
      await receiver.close()
    }
  }, 30_000)

  it('survives settlements that arrive after the receiver closed and was collected, then releases the sink', async () => {
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    // Everything that refers to the receiver stays inside this function, so it can be collected afterwards.
    const held = async () => {
      const context = channel()
      context.receiver.setDeliverable(open())
      await connected(context)
      context.render(frame('late'))
      await vi.waitFor(() => { expect(context.presented()).toHaveLength(1) })
      context.receiver.send(connection(1), 'exit')
      await context.receiver.close()
      return { fake: context.fake, id: context.presented()[0]!.id }
    }
    const { fake, id } = await held()
    fakes.answer(fake.native, id, 'delivered', 'renderer gone')
    for (let round = 0; round < 5; round++) {
      gc()
      await new Promise(resolve => setImmediate(resolve))
    }
    // The settlement drops the last reference to the receiver on the answering thread.
    fakes.answer(fake.native, id, 'settled', true)
    await vi.waitFor(() => {
      gc()
      expect(fakes.references(fake.native).refs).toBe(1)
    }, { timeout: 10_000 })
  }, 30_000)

  it.runIf(process.platform === 'win32')('closes without waiting out the handshake of a client that has not sent its hello', async () => {
    const { receiver } = channel('rx-silent')
    // A connected pipe client that never says hello, like a producer still creating its D3D11 device.
    const client = connect(receiver.tx.split('|').at(-1)!)
    client.on('error', () => {})
    await once(client, 'connect')
    await new Promise(resolve => setTimeout(resolve, 300))
    const started = performance.now()
    await receiver.close()
    // The handshake deadline is the 10 s readback timeout.
    expect(performance.now() - started).toBeLessThan(5_000)
    client.destroy()
  }, 30_000)

  it.skipIf(!existsSync(desktopIngress) || !existsSync(desktopHop))('presents through Desktop\'s hop sink into Desktop\'s ingress and follows Main\'s settlements', async () => {
    interface IngressFrame { type: 'frame'; requestId: number; handle: Buffer; width: number; height: number; pixelFormat: 'bgra' | 'rgba'; metadata: string }
    interface Ingress {
      open(pid: number, onEvent: (event: { type: string }) => void): { native: object; endpoint: string }
      reply(native: object, requestId: number, kind: number, noReferenceKept: boolean, error: string): void
      release(handle: Buffer): void
      close(native: object): Promise<void>
    }
    interface Hop {
      connect(endpoint: string, onEvent: (event: { type: string }) => void): { native: object; sink: object }
      close(native: object): void
    }
    const require = createRequire(import.meta.url)
    const ingress = require(desktopIngress) as Ingress, hop = require(desktopHop) as Hop
    const frames: IngressFrame[] = []
    // This process is both Desktop Host and Main, so the ingress admits its own process as the Host.
    const opened = ingress.open(process.pid, (event) => { if (event.type === 'frame') frames.push(event as IngressFrame) })
    const connection = hop.connect(opened.endpoint, () => {})
    const context = channel()
    const { receiver, rx } = context
    receiver.attachSink(rx, connection.sink, 5000)
    receiver.setDeliverable(open())
    const settle = (frame: IngressFrame, kind: 3 | 4) => {
      ingress.reply(opened.native, frame.requestId, 1, false, '')
      ingress.reply(opened.native, frame.requestId, kind, false, '')
      ingress.release(frame.handle)
    }
    try {
      await connected(context)
      context.render(frame('through-desktop', 2, 1))
      await vi.waitFor(() => { expect(frames).toHaveLength(1) })
      const [first] = frames
      expect(JSON.parse(first!.metadata)).toEqual({
        requestId: 'through-desktop', generation: 2, revision: 1, rx, connectionId: 1, frameId: 2, width: 64, height: 64,
      })
      expect({ width: first!.width, height: first!.height, pixelFormat: first!.pixelFormat }).toEqual({ width: 64, height: 64, pixelFormat: 'bgra' })
      expect(first!.handle).toHaveLength(8)
      // The producer regains its only credit once Main releases the texture.
      context.render(frame('second'))
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(frames).toHaveLength(1)
      settle(first!, 3)
      await context.submitted(3)
      await vi.waitFor(() => { expect(frames).toHaveLength(2) })
      settle(frames[1]!, 4)
      expect(await context.next('presentation-invalidated')).toMatchObject({ connectionId: 1 })
      expect((await context.next('disconnected')).connectionId).toBe(1)
    } finally {
      await receiver.close()
      hop.close(connection.native)
      await ingress.close(opened.native)
    }
  }, 30_000)
})
