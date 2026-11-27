/** Host receiver rejects hostile native packets without consuming another connection's credit or budget. */
import { receiverAddon } from './desktop-receiver.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadFrameForwardingBindings } from '../src/host/native.ts'
import type { FrameForwardingBindings, FrameForwardingReceiverEvent } from '../src/host/native.ts'
import { FrameForwarder } from '../src/host/forwarder.ts'
import type { SharedTextureNativeSink, SharedTextureService } from '@deepseek-ai/dsh-shared-texture'
import { buildFakeSink, type FakeSinkAddon } from './fake-sink.ts'

type Event = FrameForwardingReceiverEvent

describe.skipIf(process.platform !== 'darwin')('malicious producer over the receiver transport', { retry: 0 }, () => {
  let temporary: string
  let executable: string
  let bindings: FrameForwardingBindings
  let fakes: FakeSinkAddon
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-malicious-producer-'))
    const built = buildFakeSink(temporary)
    fakes = built.fakes
    const native = fileURLToPath(new URL('../native/', import.meta.url))
    const source = fileURLToPath(new URL('../../../../apps/desktop/tests/frame-forwarding/fixtures/malicious-producer.cc', import.meta.url))
    executable = join(temporary, 'producer')
    built.run('clang++', ['-std=c++17', `-I${native}`, source, join(native, 'transport.cc'),
      '-framework', 'IOSurface', '-framework', 'CoreFoundation', '-lbsm', '-o', executable])
    bindings = loadFrameForwardingBindings(receiverAddon)
  }, 120_000)
  afterAll(async () => { if (temporary !== undefined) await rm(temporary, { recursive: true, force: true }) })

  function peer(mode: string, tx: string) {
    const child = spawn(executable, [tx, mode], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    return { child, exited, stderr: () => stderr, async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    } }
  }
  /** Await a producer exit, so a producer that hangs fails its own test instead of stalling the suite. */
  async function exited(producer: ReturnType<typeof peer>, timeout = 30_000) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([producer.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('the producer did not exit within its deadline')) }, timeout)
      })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  function receiver() {
    const events: Event[] = []
    const value = bindings.createReceiver({ maxFrames: 3, maxBytes: 16384, budget: bindings.createBudget(16384),
      displayAdapter: null, readbackTimeoutMs: 10_000 }, (event) => {
      events.push(event)
      if (event.type === 'message' && event.text === 'armed') value.send(event.connectionId, 'go')
    })
    return { value, events, release() {
      for (const event of events) if (event.type === 'frame') value.release(event.deliveryId)
    }, async wait(type: Event['type']) {
      await expect.poll(() => events.some(event => event.type === type)).toBe(true)
    } }
  }
  it.each([
    ['MP-01 oversize', 'oversize', /Invalid frame-forwarding frame fields/],
    ['MP-02 zero', 'zero', /Invalid frame-forwarding frame fields/],
    ['MP-03 short stride', 'stride-minus', /Invalid frame-forwarding frame fields/],
    ['MP-03 mismatched stride', 'stride-plus', /IOSurface format or dimensions differ/],
    ['MP-04 wrong format', 'format', /IOSurface format or dimensions differ/],
    ['MP-05 multiplane', 'planes', /IOSurface format or dimensions differ/],
    ['MP-06 allocation over budget', 'allocation', /Invalid frame-forwarding allocation request/],
    ['MP-07 allocation reuse', 'allocation-reuse', /Invalid frame-forwarding allocation request/],
    ['MP-07 frame reuse', 'frame-reuse', /frame budget or identifier violated/],
    ['MP-08 foreign connection', 'foreign', /packet for another connection/],
    ['MP-09 deallocate in flight', 'deallocate', /in-use frame-forwarding allocation/],
    ['MP-15 unterminated metadata', 'metadata', /invalid packet/],
  ])('%s disconnects only the producer and returns the shared budget', async (_name, mode, diagnostic) => {
    const f = receiver(); const producer = peer(mode, f.value.tx)
    try {
      await f.wait('disconnected')
      expect(f.events.find(event => event.type === 'disconnected')?.text, producer.stderr()).toMatch(diagnostic)
      expect(f.events.some(event => event.type === 'failed')).toBe(false)
      if (mode !== 'frame-reuse' && mode !== 'deallocate') expect(f.events.filter(event => event.type === 'frame')).toHaveLength(0)
      f.release(); await f.wait('drained')
      const first = f.events.find(event => event.type === 'connected')!
      const delivered = f.events.filter(event => event.type === 'frame').length
      const successor = peer('valid', f.value.tx)
      try {
        await expect.poll(() => f.events.filter(event => event.type === 'frame').length).toBeGreaterThan(delivered)
        const last = f.events.findLast(event => event.type === 'connected')!
        expect(last.connectionId).toBeGreaterThan(first.connectionId)
        expect(f.events.filter(event => event.type === 'failed')).toHaveLength(0)
      } finally { await successor.stop(); f.release() }
    } finally { await producer.stop(); f.release(); await f.value.close() }
  })
  it('MP-17 an oversized Mach message to the listener leaves the channel and its producer working', async () => {
    const f = receiver(); const producer = peer('valid', f.value.tx)
    try {
      await f.wait('frame')
      const oversized = peer('mach-oversize', f.value.tx)
      await oversized.exited
      expect(oversized.child.exitCode, oversized.stderr()).toBe(0)
      // The listener reads its port in order, so a later candidate refused as busy shows it read the oversized message
      // and kept serving the channel.
      const busy = peer('valid', f.value.tx)
      try {
        await expect.poll(() => f.events.some(event => event.type === 'rejected'), { timeout: 10_000 }).toBe(true)
        expect(f.events.filter(event => event.type === 'rejected').map(event => event.type === 'rejected' && event.text)).toContain('channel-busy')
        expect(f.events.some(event => event.type === 'failed' || event.type === 'disconnected')).toBe(false)
      } finally { await busy.stop() }
    } finally { await producer.stop(); f.release(); await f.value.close() }
  })
  it.each([['MP-18 mach-move-receive', 'mach-move-receive'], ['MP-19 mach-reply-port', 'mach-reply-port'],
    ['MP-20 mach-forged-notice-channel', 'mach-forged-notice-channel']])(
    '%s destroys the message and keeps the connection', async (_name, mode) => {
      // Each mode sends a hostile message carrying an unexpected right or forged kernel notification: a transferred
      // receive right (which would leave the producer's send right alive), a send-once reply right in a protocol
      // header, or forged dead-name/no-senders notices (with and without reply rights). The producer exits 0 only
      // after observing every reply/transferred right destroyed and receiving the answer to the normal message behind it.
      const f = receiver(); const producer = peer(mode, f.value.tx)
      try {
        await exited(producer)
        expect(producer.child.signalCode).toBeNull()
        expect(producer.child.exitCode, producer.stderr()).toBe(0)
        expect(f.events.some(event => event.type === 'failed')).toBe(false)
        expect(f.events.some(event => event.type === 'message' && event.text === 'smuggled')).toBe(false)
        expect(f.events.some(event => event.type === 'message' && event.text === 'armed')).toBe(true)
      } finally { await producer.stop(); f.release(); await f.value.close() }
    }, 120_000)
  it('MP-21 forged notifications with reply rights to the listener destroy the rights and keep serving', async () => {
    const f = receiver(); const producer = peer('valid', f.value.tx)
    try {
      await f.wait('frame')
      const forged = peer('mach-forged-notice-listener', f.value.tx)
      await exited(forged)
      expect(forged.child.signalCode).toBeNull()
      expect(forged.child.exitCode, forged.stderr()).toBe(0)
      const busy = peer('valid', f.value.tx)
      try {
        await expect.poll(() => f.events.some(event => event.type === 'rejected'), { timeout: 10_000 }).toBe(true)
        expect(f.events.filter(event => event.type === 'rejected').map(event => event.type === 'rejected' && event.text)).toContain('channel-busy')
        expect(f.events.some(event => event.type === 'failed' || event.type === 'disconnected')).toBe(false)
      } finally { await busy.stop() }
    } finally { await producer.stop(); f.release(); await f.value.close() }
  }, 120_000)
  it('MP-14 crash preserves the in-flight surface until release, then admits a successor', async () => {
    const f = receiver(); const producer = peer('valid', f.value.tx)
    try {
      await f.wait('frame'); await producer.stop(); await f.wait('disconnected')
      expect(f.events.some(event => event.type === 'drained')).toBe(false)
      f.release(); await f.wait('drained')
      expect(f.events.some(event => event.type === 'failed')).toBe(false)
    } finally { await producer.stop(); f.release(); await f.value.close() }
  })
  it('MP-10 credit bounds 1000 Hz submission attempts and releases every delivery', async () => {
    const f = receiver(); const producer = peer('flood', f.value.tx)
    const timer = setInterval(() => { f.release() }, 1)
    try {
      await expect.poll(() => f.events.find(event => event.type === 'message' && event.text.includes('attempts')), { timeout: 10_000 }).toBeDefined()
      const report = f.events.find(event => event.type === 'message' && event.text.includes('attempts'))!
      expect(report.type).toBe('message')
      if (report.type !== 'message') throw new Error('Missing flood report')
      const stats = JSON.parse(report.text) as { attempts: number; submitted: number }
      expect(stats.attempts).toBe(1000); expect(stats.submitted).toBeGreaterThan(1); expect(stats.submitted).toBeLessThanOrEqual(1001)
      expect(f.events.some(event => event.type === 'disconnected' || event.type === 'failed')).toBe(false)
      await producer.stop(); f.release(); await f.wait('drained')
    } finally { clearInterval(timer); await producer.stop(); f.release(); await f.value.close() }
  })
  it.each(['metadata-deep', 'metadata-utf8', 'invisible'])('MP-15/16 Host drops %s without calling Desktop', async (mode) => {
    const events: Event[] = []
    const errors: string[] = []
    const fake = fakes.create()
    let nativeReceiver: ReturnType<FrameForwardingBindings['createReceiver']> | undefined
    const service = {
      capabilities: async () => ({ supported: true }), adapterLuid: async () => null,
      nativeSink: async () => fake.sink as SharedTextureNativeSink,
    } satisfies SharedTextureService
    const forwarder = new FrameForwarder(service, () => ({ ...bindings, createReceiver(options, listener) {
      nativeReceiver = bindings.createReceiver(options, (event) => { events.push(event); listener(event) })
      return nativeReceiver
    } }), { maxFrames: 3, maxBytes: () => 65536,
      requestTimeoutMs: 10_000, maxPendingRequests: 8 }, { event: (event) => { if (event.kind === 'error' && event.error.startsWith('Invalid native frame metadata:')) errors.push(event.error) }, warn: () => {} })
    const channel = await forwarder.channel()
    const producer = peer(mode, channel.tx)
    try {
      await expect.poll(() => events.find(event => event.type === 'message' && event.text === 'armed')).toBeDefined()
      await forwarder.setViewport(channel.rx, { version: 1, width: 64, height: 64, deviceScaleFactor: 1, visible: mode !== 'invisible' })
      const connection = events.find(event => event.type === 'connected')!
      nativeReceiver!.send(connection.connectionId, 'go')
      // Every mode's metadata is invalid: the invisible producer names an empty request.
      await expect.poll(() => errors.length).toBe(1)
      expect(fakes.presented(fake.native)).toEqual([]); expect(forwarder.isOpen(channel.rx)).toBe(true)
      expect(events.some(event => event.type === 'frame')).toBe(false)
      await producer.stop()
      await expect.poll(() => forwarder.isOpen(channel.rx)).toBe(false)
    } finally { await producer.stop(); await forwarder.closeAll() }
  })
})
