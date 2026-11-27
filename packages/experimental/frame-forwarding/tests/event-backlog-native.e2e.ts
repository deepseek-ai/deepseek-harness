/**
 * Pending-event limit of the built receiver. One connection may have at most 256 producer events (messages,
 * presentation errors and frames for JavaScript) awaiting the JavaScript thread. A connection that exceeds it ends
 * with one `disconnected` carrying the reason, after the events already queued, and then one `drained` once its frames
 * are released; the channel stays open for a successor. Lifecycle notices take no quota, and refusals coalesce to one
 * pending `rejected` event. On Windows, valid producers keep connecting while other processes present a wrong
 * credential.
 *
 * Each case stalls the JavaScript thread with `Atomics.wait` inside a receiver callback, so native threads queue events
 * that nothing dispatches, and ends the stall on a producer's signal file rather than after a fixed time.
 *
 * Prerequisites: build the addon with `pnpm --filter @deepseek-ai/dsh-desktop run build:native`, on Windows
 * from a Visual Studio x64 developer environment (vcvarsall); on macOS the Xcode command line tools provide clang++.
 * The suite compiles its producer with the same toolchain and skips itself when the addon is missing.
 */
import type { SharedTextureNativeSink, SharedTextureService } from '@deepseek-ai/dsh-shared-texture'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FrameForwarder } from '../src/host/forwarder.ts'
import type { FrameForwardingReceiver } from '../src/host/native.ts'
import type { FrameChannelState, FrameConnectionId, FrameForwardingEvent } from '../src/types.ts'
import {
  blockUntil, corruptTx, createChannel, killProducers, nativeSupported, ofConnection, pendingLimit, pendingLimitText, sequence,
  setupHarness, signalled, signalPrefix, startProducer, teardownHarness, within,
  type Channel, type ChannelOptions, type Event, type Harness, type Producer,
} from './backlog-harness.ts'

const connection = (value: number) => value as FrameConnectionId
const range = (length: number) => Array.from({ length }, (_, index) => index)
const types = (events: readonly Event[]) => events.map(event => event.type)
const indexOf = (events: readonly Event[], type: Event['type'], connectionId: number) =>
  events.findIndex(event => event.type === type && 'connectionId' in event && event.connectionId === connectionId)

describe.skipIf(!nativeSupported)('pending-event limit of the built frame-forwarding receiver', () => {
  let harness: Harness | undefined
  const receivers: FrameForwardingReceiver[] = []
  beforeAll(async () => { harness = await setupHarness() }, 180_000)
  afterEach(async () => {
    await Promise.all(receivers.splice(0).map(async receiver => within(receiver.close(), 10_000)))
    if (harness) await killProducers(harness)
  }, 30_000)
  afterAll(async () => { await teardownHarness(harness) }, 30_000)

  function open(hook?: (event: Event, receiver: FrameForwardingReceiver) => void, options?: ChannelOptions): Channel {
    const channel = createChannel(harness!, hook, options)
    receivers.push(channel.receiver)
    return channel
  }

  /**
   * Send `messages` control messages while JavaScript stays blocked in the first `connected` callback. A successor
   * started there retries while the first connection is current, so its connection ends the stall only after the
   * receiver ended and drained the first one. The successor then sends three messages and leaves when asked.
   */
  async function stalledFlood(messages: number, after: 'goodbye' | 'hold') {
    const h = harness!
    const successorSignal = signalPrefix(h)
    let successor: Producer | undefined
    let stalled: boolean | undefined
    const channel = open((event, receiver) => {
      if (event.type === 'connected') {
        receiver.send(event.connectionId, 'go')
        if (event.connectionId !== 1) return
        successor = startProducer(h, receiver.tx, 'produce', {
          messages: 3, 'wait-go': 1, after: 'hold', 'hold-ms': 30_000, 'retry-busy': 1, signal: successorSignal,
        })
        stalled = blockUntil(() => signalled(successorSignal, 'connected') || signalled(successorSignal, 'connect-failed'), 30_000)
      } else if (event.type === 'message' && event.connectionId === 2 && sequence([event])[0] === 2) {
        receiver.send(event.connectionId, 'exit')
      }
    })
    const main = startProducer(h, channel.receiver.tx, 'produce', { messages, 'wait-go': 1, after, 'hold-ms': 30_000 })
    await channel.waitFor('the successor to drain',
      events => indexOf(events, 'drained', 2) >= 0 || events.some(event => event.type === 'failed'), 60_000)
    return { channel, main, successor: successor!, stalled }
  }

  /** The successor of `stalledFlood` exchanged its messages and left normally after the first connection drained. */
  async function expectSuccessor(channel: Channel, successor: Producer) {
    await successor.exited
    expect(successor.line('connected'), successor.lines.join('\n')).toBeDefined()
    const second = ofConnection(channel.events, 2)
    expect(types(second)).toEqual(['connected', 'message', 'message', 'message', 'disconnected', 'drained'])
    expect(sequence(second)).toEqual([0, 1, 2])
    expect(second.at(-2)).toEqual({ type: 'disconnected', connectionId: 2 })
    expect(indexOf(channel.events, 'drained', 1)).toBeLessThan(indexOf(channel.events, 'connected', 2))
    // The successor's busy refusals all happened during the stall, so at most one was pending.
    const rejected = channel.events.filter(event => event.type === 'rejected')
    expect(rejected.length).toBeLessThanOrEqual(1)
    for (const event of rejected) expect(event).toEqual({ type: 'rejected', text: 'channel-busy' })
    expect(channel.count('failed')).toBe(0)
  }

  it.each([200, pendingLimit])('delivers %i messages queued behind a stalled JavaScript thread and ends the connection without a reason', async (messages) => {
    const { channel, main, successor, stalled } = await stalledFlood(messages, 'goodbye')
    expect(stalled, successor.lines.join('\n')).toBe(true)
    const first = ofConnection(channel.events, 1)
    expect(types(first)).toEqual(['connected', ...Array<string>(messages).fill('message'), 'disconnected', 'drained'])
    expect(sequence(first)).toEqual(range(messages))
    expect(first.at(-2)).toEqual({ type: 'disconnected', connectionId: 1 })
    expect(await main.waitLine(['sent'], 10_000)).toBe(`sent ok=${String(messages)} failed=0`)
    await expectSuccessor(channel, successor)
  })

  it.each([pendingLimit + 1, 2000])('ends a connection whose %i messages exceed the limit after delivering the first 256, and admits a successor', async (messages) => {
    const { channel, main, successor, stalled } = await stalledFlood(messages, 'hold')
    expect(stalled, successor.lines.join('\n')).toBe(true)
    const first = ofConnection(channel.events, 1)
    expect(types(first)).toEqual(['connected', ...Array<string>(pendingLimit).fill('message'), 'disconnected', 'drained'])
    expect(sequence(first)).toEqual(range(pendingLimit))
    expect(first.at(-2)).toEqual({ type: 'disconnected', connectionId: 1, text: pendingLimitText })
    // The receiver ended the producer's connection; the producer did not leave on its own.
    expect(await main.waitLine(['closed', 'hold-timeout'], 10_000)).toMatch(/^closed\b/u)
    expect(() => { channel.receiver.send(connection(1), 'exit') }).toThrow('Frame-forwarding connection is not active')
    await expectSuccessor(channel, successor)
  })

  it('sends drained for a connection ended at the limit only after JavaScript releases its frame', async () => {
    const h = harness!
    const signal = signalPrefix(h)
    let held: Extract<Event, { type: 'frame' }> | undefined
    let stalled: boolean | undefined
    // The frame was dispatched before the flood started and JavaScript still holds it, so drained waits for its release.
    // Its event keeps a queue slot until the callback that blocked returns, so 255 messages fit.
    const channel = open((event, receiver) => {
      if (event.type !== 'frame') return
      held = event
      receiver.send(event.connectionId, 'go')
      stalled = blockUntil(() => signalled(signal, 'closed'), 30_000)
    }, { releaseFrames: false })
    startProducer(h, channel.receiver.tx, 'produce', {
      frames: 1, 'frames-first': 1, 'wait-go': 1, messages: 2000, after: 'hold', 'hold-ms': 30_000, signal,
    })
    await channel.waitFor('the disconnect', events => events.some(event => event.type === 'disconnected'), 30_000)
    expect(stalled).toBe(true)
    expect(types(channel.events)).toEqual(['connected', 'frame', ...Array<string>(pendingLimit - 1).fill('message'), 'disconnected'])
    expect(channel.events.at(-1)).toEqual({ type: 'disconnected', connectionId: 1, text: pendingLimitText })
    expect(channel.receiver.release(held!.deliveryId)).toBe(true)
    await channel.waitFor('the drain', events => events.some(event => event.type === 'drained'), 10_000)
    expect(channel.events.slice(-1)).toEqual([{ type: 'drained', connectionId: 1 }])
    expect(channel.count('failed')).toBe(0)
  })

  it('closes a FrameForwarder channel as failed after its producer exceeds the limit', async () => {
    const h = harness!
    const signal = signalPrefix(h)
    const states: FrameChannelState[] = []
    const warnings: string[] = []
    let stalled: boolean | undefined
    const service = {
      capabilities: async () => ({ supported: true }),
      adapterLuid: async () => h.displayAdapter,
      nativeSink: async () => h.fakes.create().sink as SharedTextureNativeSink,
    } satisfies SharedTextureService
    const forwarder = new FrameForwarder(service, () => ({
      ...h.bindings,
      createReceiver(options, listener) {
        const receiver = h.bindings.createReceiver(options, (event) => {
          listener(event)
          if (event.type !== 'connected' || event.connectionId !== 1) return
          receiver.send(event.connectionId, 'go')
          stalled = blockUntil(() => signalled(signal, 'closed'), 30_000)
        })
        return receiver
      },
    }), { maxFrames: 2, maxBytes: () => 1 << 20, requestTimeoutMs: 5000, maxPendingRequests: 8 }, {
      event: (event: Exclude<FrameForwardingEvent, { kind: 'snapshot' }>) => { if (event.kind === 'state') states.push(event.channel) },
      warn: (message) => { warnings.push(message) },
    })
    try {
      const channel = await forwarder.channel()
      const main = startProducer(h, channel.tx, 'produce', { messages: 2000, 'wait-go': 1, after: 'hold', 'hold-ms': 30_000, signal })
      await vi.waitFor(() => {
        expect(states.some(state => state.state === 'closed')).toBe(true)
      }, { timeout: 60_000, interval: 20 })
      expect(stalled).toBe(true)
      expect(states).toEqual([
        { state: 'idle' }, { state: 'connected', connectionId: 1 },
        { state: 'closed', cause: 'failed', reason: `Native producer disconnected: ${pendingLimitText}` },
      ])
      expect(forwarder.isOpen(channel.rx)).toBe(false)
      expect(warnings).toContain(`Native producer 1 disconnected: ${pendingLimitText}`)
      expect(await main.waitLine(['closed', 'hold-timeout'], 10_000)).toMatch(/^closed\b/u)
    } finally {
      expect(await within(forwarder.closeAll().then(() => 'closed' as const), 10_000)).toBe('closed')
    }
  })

  it('coalesces credential refusals made while JavaScript is blocked into one rejected event, then admits a producer', async () => {
    const h = harness!
    const channel = open()
    const bad = corruptTx(channel.receiver.tx)
    const signals = [signalPrefix(h), signalPrefix(h)]
    const refusers = signals.map(signal => startProducer(h, bad, 'refuse', { count: 40, 'max-ms': 30_000, signal }))
    // Nothing is dispatched between starting the refusers and blocking, so every refusal happens during the stall. The
    // receiver admits candidates one at a time, so the producer connects only after every refusal was queued.
    const refused = blockUntil(() => signals.every(signal => signalled(signal, 'refused') || signalled(signal, 'device-failed')), 45_000)
    const producerSignal = signalPrefix(h)
    startProducer(h, channel.receiver.tx, 'produce', { after: 'goodbye', signal: producerSignal })
    const admitted = blockUntil(() => signalled(producerSignal, 'connected') || signalled(producerSignal, 'connect-failed'), 30_000)
    expect({ refused, admitted }).toEqual({ refused: true, admitted: true })
    await Promise.all(refusers.map(async refuser => refuser.exited))
    for (const refuser of refusers) expect(refuser.line('refused')).toMatch(/^refused credential=40 other=0 accepted=0\b/u)
    await channel.waitFor('the producer to drain', events => events.some(event => event.type === 'drained'), 30_000)
    expect(channel.events).toEqual([
      { type: 'rejected', text: 'invalid-credential' },
      { type: 'connected', connectionId: 1, pid: expect.any(Number) as number },
      { type: 'disconnected', connectionId: 1 },
      { type: 'drained', connectionId: 1 },
    ])
  })

  it('delivers between one and N rejected events for N refusals while JavaScript keeps dispatching', async () => {
    const h = harness!
    const channel = open()
    const refuser = startProducer(h, corruptTx(channel.receiver.tx), 'refuse', { count: 20, 'max-ms': 30_000 })
    await refuser.exited
    expect(refuser.line('refused')).toMatch(/^refused credential=20 other=0 accepted=0\b/u)
    startProducer(h, channel.receiver.tx, 'produce', { after: 'goodbye' })
    await channel.waitFor('the producer to drain', events => events.some(event => event.type === 'drained'), 30_000)
    // Every refusal was queued before the producer connected, so its rejected events all come first.
    const rejected = channel.events.filter(event => event.type === 'rejected')
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    expect(rejected.length).toBeLessThanOrEqual(20)
    expect(new Set(rejected.map(event => event.text))).toEqual(new Set(['invalid-credential']))
    expect(types(channel.events.slice(rejected.length))).toEqual(['connected', 'disconnected', 'drained'])
  })

  it.each([
    { messages: 2000, barrier: 'closed' },
    { messages: 200, barrier: 'sent' },
  ])('closes promptly while JavaScript has not dispatched the events of $messages messages', async ({ messages, barrier }) => {
    const h = harness!
    const signal = signalPrefix(h)
    let stalled: boolean | undefined
    let closing: Promise<void> | undefined
    const channel = open((event, receiver) => {
      if (event.type !== 'connected') return
      receiver.send(event.connectionId, 'go')
      // With 2000 messages the receiver has already ended the connection; with 200 it is still current.
      stalled = blockUntil(() => signalled(signal, barrier), 30_000)
      closing = receiver.close()
    })
    const producer = startProducer(h, channel.receiver.tx, 'produce', { messages, 'wait-go': 1, after: 'hold', 'hold-ms': 30_000, signal })
    await channel.waitFor('the connection', events => events.some(event => event.type === 'connected'), 30_000)
    expect(stalled).toBe(true)
    expect(await within(closing!.then(() => 'closed' as const), 10_000)).toBe('closed')
    expect(await producer.waitLine(['closed', 'hold-timeout'], 10_000)).toMatch(/^closed\b/u)
    const first = ofConnection(channel.events, 1)
    expect(sequence(first)).toEqual(range(sequence(first).length))
    expect(channel.count('failed')).toBe(0)
    expect(channel.count('disconnected')).toBeLessThanOrEqual(1)
  })

  it.runIf(process.platform === 'win32')('connects valid producers, or refuses them as busy, while other processes keep presenting a wrong credential', async () => {
    const h = harness!
    const channel = open()
    const bad = corruptTx(channel.receiver.tx)
    const refusers = [0, 1].map(() => startProducer(h, bad, 'refuse', { count: 0, 'max-ms': 150_000 }))
    for (const refuser of refusers) expect(await refuser.waitLine(['refusing', 'refused', 'device-failed'], 30_000)).toBe('refusing')
    const outcomes: string[] = []
    for (let round = 0; round < 20; round++) {
      const probe = startProducer(h, channel.receiver.tx, 'produce', { after: 'goodbye' })
      await probe.exited
      outcomes.push(probe.lines[0] ?? `no output: ${probe.stderr()}`)
    }
    // Both refusers were still presenting the wrong credential when the last probe finished.
    expect(refusers.map(refuser => refuser.child.exitCode)).toEqual([null, null])
    expect(outcomes.filter(outcome => !/^connected\b/u.test(outcome) && !outcome.startsWith('connect-failed channel-busy'))).toEqual([])
    expect(outcomes.some(outcome => /^connected\b/u.test(outcome))).toBe(true)
    expect(channel.count('failed')).toBe(0)
  }, 240_000)
})
