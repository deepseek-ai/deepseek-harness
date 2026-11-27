/**
 * The installed LibreOffice Kit producer renders a two-slide deck through the built receiver and the Host forwarder,
 * with Desktop's sink replaced by an in-process native sink that can hold every presented texture. Covers requested frames and
 * credit return; a slideshow whose state advances while every credit is held and whose newest slide is delivered once
 * credit returns; replacing the engine process, normally and after a crash, on the same channel: the replacement
 * connects only after the previous engine's frames are released and receives the channel's viewport; two engines on
 * two channels at once; and an engine whose viewport turns invisible returning its idle surfaces to the shared budget.
 */
import { receiverAddon } from './desktop-receiver.ts'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SharedTextureNativeSink, SharedTextureService } from '@deepseek-ai/dsh-shared-texture'
import type { EditorDocument } from '@deepseek-ai/libreoffice-kit/editor'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FrameForwarder } from '../src/host/forwarder.ts'
import { FRAME_FORWARDING_PROTOCOL_VERSION, loadFrameForwardingBindings } from '../src/host/native.ts'
import type { FrameChannel } from '../src/host/service.ts'
import type { FrameChannelState, FrameForwardingEvent, FrameForwardingFrameMetadata } from '../src/types.ts'
import { buildFakeSink, type FakeSinkAddon } from './fake-sink.ts'

const require = createRequire(import.meta.url)
const addon = receiverAddon
const slides = fileURLToPath(new URL('./fixtures/two-slides.pptx', import.meta.url))
const pixelSource = fileURLToPath(new URL('../../../../apps/desktop/tests/frame-forwarding/fixtures/surface-pixel.cc', import.meta.url))
const nodeHeaders = join(dirname(process.execPath), '..', 'include', 'node')
const BLUE = 0xff2244cc, GREEN = 0xff22aa44
const MAX_FRAMES = 3

async function nativeKit(): Promise<boolean> {
  if (process.platform !== 'darwin' || !existsSync(addon) || !existsSync(join(nodeHeaders, 'node_api.h'))) return false
  // A Kit release built for another protocol version connects to no receiver of this one.
  const kitSdkPath = require.resolve('@deepseek-ai/libreoffice-kit/frame-forwarding/sdk')
  const kitSdk = JSON.parse(await readFile(kitSdkPath, 'utf8')) as { protocolVersion?: unknown }
  if (kitSdk.protocolVersion !== FRAME_FORWARDING_PROTOCOL_VERSION) {
    console.warn(`Skipping native Kit frame tests: the installed Kit speaks frame-forwarding protocol ${String(kitSdk.protocolVersion)}, `
      + `and this receiver speaks protocol ${FRAME_FORWARDING_PROTOCOL_VERSION}.`)
    return false
  }
  const { ConversionError, discoverRuntime } = await import('@deepseek-ai/libreoffice-kit')
  const runtime = await discoverRuntime().catch((_error: unknown) => undefined)
  if (runtime?.backend !== 'native' || !runtime.nativePreview) return false
  const { openDocument } = await import('@deepseek-ai/libreoffice-kit/editor')
  let probe: EditorDocument
  try {
    // Native Kit discovery does not initialize the GPU. Forced Ganesh reports unavailable before loading the document.
    probe = await openDocument({ bytes: new Uint8Array(await readFile(slides)), format: 'pptx', renderBackend: 'ganesh' })
  } catch (error) {
    if (!(error instanceof ConversionError) || error.code !== 'unavailable') throw error
    console.warn('Skipping native Kit frame tests: Ganesh GPU rendering is unavailable on this machine.', error.message)
    return false
  }
  try { expect(probe.initialInfo.renderBackend).toBe('ganesh'); return true }
  finally { await probe.close() }
}
const available = await nativeKit()

interface Presented {
  readonly metadata: FrameForwardingFrameMetadata
  readonly pixel: number
  release(): void
}

let fakes: FakeSinkAddon

/** Desktop stand-in: a native sink that holds each presented texture, records its center pixel, and releases it when the test does. */
function desktop(read: (handle: Buffer, width: number, height: number) => number) {
  const fake = fakes.create()
  const released = new Set<string>()
  const pixels = new Map<string, number>()
  const sharedTexture = {
    capabilities: async () => ({ supported: true }),
    adapterLuid: async () => null,
    nativeSink: async () => fake.sink as SharedTextureNativeSink,
  } satisfies SharedTextureService
  /** Presentations Desktop still holds, oldest first; each read returns a new array. */
  const held = (): Presented[] => fakes.presented(fake.native).filter(entry => !released.has(entry.id)).map((entry) => {
    // A held texture stays valid, so its pixel is read when the test first observes it.
    if (!pixels.has(entry.id)) pixels.set(entry.id, read(entry.handle, entry.width, entry.height))
    return {
      metadata: JSON.parse(entry.metadata) as FrameForwardingFrameMetadata,
      pixel: pixels.get(entry.id)!,
      release: () => {
        if (released.has(entry.id)) return
        released.add(entry.id)
        fakes.answer(fake.native, entry.id, 'delivered', null)
        fakes.answer(fake.native, entry.id, 'settled', false)
      },
    }
  })
  return { sharedTexture, get held() { return held() }, total: () => fakes.presented(fake.native).length }
}

describe.skipIf(!available)('LibreOffice Kit frames through the built receiver and the Host forwarder', () => {
  let temporary = ''
  let document: EditorDocument
  let forwarder: FrameForwarder
  let channel: FrameChannel
  let host: ReturnType<typeof desktop>
  let read: (handle: Buffer, width: number, height: number) => number
  const events: Exclude<FrameForwardingEvent, { kind: 'snapshot' }>[] = []
  const failures = (): string[] => events.flatMap(event => event.kind === 'error' ? [event.error] : [])
  const state = (): FrameChannelState | undefined => events.flatMap(event => event.kind === 'state' ? [event.channel] : []).at(-1)
  const open = async (): Promise<EditorDocument> => {
    const { openDocument } = await import('@deepseek-ai/libreoffice-kit/editor')
    return openDocument({ bytes: new Uint8Array(await readFile(slides)), format: 'pptx', renderBackend: 'ganesh' })
  }

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-frame-forwarding-kit-'))
    const library = join(temporary, 'surface-pixel.node')
    const build = spawnSync('clang++', ['-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-std=c++17', `-I${nodeHeaders}`,
      '-DNAPI_VERSION=8', '-shared', '-undefined', 'dynamic_lookup', pixelSource, '-framework', 'IOSurface', '-o', library],
    { encoding: 'utf8', timeout: 60_000 })
    expect(build.status, build.stdout + build.stderr).toBe(0)
    fakes = buildFakeSink(temporary).fakes
    const reader = require(library) as { pixel(handle: Buffer, x: number, y: number): number }
    read = (handle, width, height) => reader.pixel(handle, width >> 1, height >> 1)
    host = desktop(read)
    forwarder = new FrameForwarder(host.sharedTexture, () => loadFrameForwardingBindings(addon),
      {
        maxFrames: MAX_FRAMES, maxBytes: () => 64 * 1024 * 1024, requestTimeoutMs: 10_000, maxPendingRequests: 16 },
      { event: (event) => { events.push(event) }, warn: () => {} })
    document = await open()
    channel = await forwarder.channel()
    // The engine process is a separate producer that receives a copy of the credential; nothing binds its PID.
    await document.attachSurfaceTransport(channel.tx, { timeoutMs: 10_000 })
    await vi.waitFor(() => { expect(state()).toEqual({ state: 'connected', connectionId: 1 }) })
  }, 120_000)
  afterAll(async () => {
    for (const entry of [...host.held]) entry.release()
    try { await document.detachSurfaceTransport() } finally {
      await document.close()
      await forwarder.closeAll()
      await rm(temporary, { recursive: true, force: true })
    }
  }, 60_000)

  it('delivers each requested frame by request identifier and regains credit when Desktop releases it', async () => {
    expect(await forwarder.setViewport(channel.rx, { version: 1, width: 320, height: 240, deviceScaleFactor: 1, visible: true }))
      .toEqual({ applied: true, connectionId: 1 })
    const info = await document.getInfo()
    const area = { x: 0, y: 0, width: info.width, height: info.height }
    // More requests than the view's credits succeed only because each released frame returns its credit.
    for (let index = 0; index < MAX_FRAMES + 2; index++) {
      const requestId = `tile-${String(index)}`
      await document.renderSurface(area, 320, 240, { requestId, generation: 1 })
      await vi.waitFor(() => { expect(host.held.map(entry => entry.metadata.requestId)).toEqual([requestId]) })
      expect(host.held[0]).toMatchObject({
        pixel: BLUE, metadata: { rx: channel.rx, connectionId: 1, generation: 1, width: 320, height: 240 },
      })
      host.held[0]!.release()
    }
    expect(failures()).toEqual([])
  }, 60_000)

  it('advances slideshow state while every credit is held and delivers the newest slide once credit returns', async () => {
    await document.presentation({ action: 'start', pixelWidth: 320, pixelHeight: 240, part: 0 })
    await forwarder.setViewport(channel.rx, { version: 2, width: 320, height: 240, deviceScaleFactor: 1, visible: true })
    const parts: number[] = []
    const unsubscribe = document.onEvent((event) => { if (event.kind === 'presentation') parts.push(event.part) })
    try {
      await document.presentation({ action: 'stream', enabled: true, requestId: 'stream', generation: 2, frameRate: 60 })
      await vi.waitFor(() => { expect(host.held.map(entry => entry.pixel)).toEqual([BLUE]) }, { timeout: 10_000 })
      // Desktop holds every presented frame, as a stalled renderer with slow GPU release would. The slideshow submits
      // its newest frame and keeps one surface out of flight, so one frame fewer than the limit is presented.
      const inFlight = MAX_FRAMES - 1
      let part = 0
      const toggle = async (): Promise<void> => {
        part = 1 - part
        await document.presentation({ action: part === 1 ? 'next' : 'previous' })
      }
      while (host.held.length < inFlight) {
        const before = host.held.length
        await toggle()
        await vi.waitFor(() => { expect(host.held).toHaveLength(before + 1) }, { timeout: 10_000 })
      }
      const exhaustedAt = host.total()
      // Without credit the slideshow still advances; an unsent newer state replaces an older one.
      for (let step = 0; step < 2; step++) {
        await toggle()
        await vi.waitFor(() => { expect(parts.at(-1)).toBe(part) }, { timeout: 10_000 })
      }
      expect(host.total()).toBe(exhaustedAt)
      expect(host.held).toHaveLength(inFlight)
      // Releasing one held frame, with no further command, lets the producer deliver its newest state.
      host.held[0]!.release()
      await vi.waitFor(() => { expect(host.total()).toBe(exhaustedAt + 1) }, { timeout: 10_000 })
      expect(host.held.at(-1)?.pixel).toBe(part === 1 ? GREEN : BLUE)
      expect(host.held).toHaveLength(inFlight)
    } finally {
      unsubscribe()
      for (const entry of [...host.held]) entry.release()
      await document.presentation({ action: 'stream', enabled: false, requestId: 'stream', generation: 2 })
      await document.presentation({ action: 'stop' })
    }
    expect(failures()).toEqual([])
  }, 60_000)

  it('closes the old channel on detach or crash and serves a replacement engine on a fresh channel', async () => {
    const info = await document.getInfo()
    const area = { x: 0, y: 0, width: info.width, height: info.height }
    await document.renderSurface(area, 320, 240, { requestId: 'held', generation: 2 })
    await vi.waitFor(() => { expect(host.held).toHaveLength(1) })
    // Normal detach closes the channel while the held frame stays valid until Desktop releases it.
    await document.detachSurfaceTransport()
    await vi.waitFor(() => { expect(state()).toMatchObject({ state: 'closed', cause: 'closed' }) })
    expect(host.held[0]!.pixel).toBe(BLUE)
    host.held[0]!.release()
    await document.close()
    const replacement = await open()
    channel = await forwarder.channel()
    await replacement.attachSurfaceTransport(channel.tx, { timeoutMs: 10_000 })
    document = replacement
    await vi.waitFor(() => { expect(state()).toEqual({ state: 'connected', connectionId: 1 }) })
    await forwarder.setViewport(channel.rx, { version: 2, width: 320, height: 240, deviceScaleFactor: 1, visible: true })
    await document.renderSurface(area, 320, 240, { requestId: 'after-replace', generation: 2 })
    await vi.waitFor(() => { expect(host.held.map(entry => entry.metadata.requestId)).toEqual(['after-replace']) })
    expect(host.held[0]!.metadata).toMatchObject({ connectionId: 1, generation: 2 })
    // Crash closes the channel as failed; a successor connects to a new channel.
    const crashed = document
    const failed = new Promise<void>((resolve) => { crashed.onEvent((event) => { if (event.kind === 'failure') resolve() }) })
    process.kill(crashed.processId, 'SIGKILL')
    await failed
    await vi.waitFor(() => { expect(state()).toMatchObject({ state: 'closed', cause: 'failed' }) })
    host.held[0]!.release()
    await crashed.close().catch(() => {})
    const successor = await open()
    channel = await forwarder.channel()
    await successor.attachSurfaceTransport(channel.tx, { timeoutMs: 10_000 })
    document = successor
    await vi.waitFor(() => { expect(state()).toEqual({ state: 'connected', connectionId: 1 }) })
    await forwarder.setViewport(channel.rx, { version: 2, width: 320, height: 240, deviceScaleFactor: 1, visible: true })
    await document.renderSurface(area, 320, 240, { requestId: 'after-crash', generation: 2 })
    await vi.waitFor(() => { expect(host.held.map(entry => entry.metadata.requestId)).toEqual(['after-crash']) })
    host.held[0]!.release()
    expect(failures()).toEqual([])
  }, 90_000)

  it('renders two engines on two channels at once without crossing their frames', async () => {
    const other = await open()
    const second = await forwarder.channel()
    try {
      await other.attachSurfaceTransport(second.tx, { timeoutMs: 10_000 })
      await vi.waitFor(() => { expect(forwarder.snapshot().find(entry => entry.rx === second.rx)?.channel).toMatchObject({ state: 'connected' }) })
      const viewport = { version: 3, width: 320, height: 240, deviceScaleFactor: 1, visible: true }
      await forwarder.setViewport(channel.rx, viewport)
      await forwarder.setViewport(second.rx, { ...viewport, version: 1 })
      const info = await document.getInfo()
      const area = { x: 0, y: 0, width: info.width, height: info.height }
      await Promise.all([
        document.renderSurface(area, 320, 240, { requestId: 'first', generation: 3 }),
        other.renderSurface(area, 320, 240, { requestId: 'second', generation: 1 }),
      ])
      await vi.waitFor(() => { expect(host.held).toHaveLength(2) })
      const byRequest = Object.fromEntries(host.held.map(entry => [entry.metadata.requestId, entry]))
      expect(byRequest.first).toMatchObject({ pixel: BLUE, metadata: { rx: channel.rx, generation: 3 } })
      expect(byRequest.second).toMatchObject({ pixel: BLUE, metadata: { rx: second.rx, generation: 1 } })
      for (const entry of [...host.held]) entry.release()
    } finally {
      await other.detachSurfaceTransport().catch(() => {})
      await other.close()
      await forwarder.close(second.rx)
    }
    expect(failures()).toEqual([])
  }, 90_000)

  it('returns the idle surfaces of an engine whose viewport turns invisible to another channel waiting for budget', async () => {
    // The window budget fits one 320x240 surface, so the second engine allocates only after the first returns its own.
    const shared = desktop(read)
    const tight = new FrameForwarder(shared.sharedTexture, () => loadFrameForwardingBindings(addon),
      {
        maxFrames: MAX_FRAMES, maxBytes: () => 450 * 1024, requestTimeoutMs: 10_000, maxPendingRequests: 16 },
      { event: () => {}, warn: () => {} })
    const hidden = await open(), visible = await open()
    try {
      const [first, second] = [await tight.channel(), await tight.channel()]
      await hidden.attachSurfaceTransport(first.tx, { timeoutMs: 10_000 })
      await visible.attachSurfaceTransport(second.tx, { timeoutMs: 10_000 })
      const viewport = { version: 1, width: 320, height: 240, deviceScaleFactor: 1, visible: true }
      await tight.setViewport(first.rx, viewport)
      await tight.setViewport(second.rx, viewport)
      const info = await hidden.getInfo()
      const area = { x: 0, y: 0, width: info.width, height: info.height }
      await hidden.renderSurface(area, 320, 240, { requestId: 'hidden', generation: 1 })
      await vi.waitFor(() => { expect(shared.held.map(entry => entry.metadata.requestId)).toEqual(['hidden']) })
      shared.held[0]!.release()
      const waiting = visible.renderSurface(area, 320, 240, { requestId: 'visible', generation: 1 })
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(shared.held).toEqual([])
      await tight.setViewport(first.rx, { ...viewport, version: 2, visible: false })
      await waiting
      await vi.waitFor(() => { expect(shared.held.map(entry => entry.metadata.rx)).toEqual([second.rx]) })
      shared.held[0]!.release()
    } finally {
      for (const engine of [hidden, visible]) {
        await engine.detachSurfaceTransport().catch(() => {})
        await engine.close()
      }
      await tight.closeAll()
    }
  }, 90_000)
})
