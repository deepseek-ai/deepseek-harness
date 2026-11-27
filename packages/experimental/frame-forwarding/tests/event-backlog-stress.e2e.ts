/**
 * Seeded stress of the built receiver's pending-event limit. Each case varies message count and length, JavaScript
 * stalls, wrong-credential connections, how the producer leaves, when a successor arrives, when the channel closes,
 * and whether frames are submitted, then checks the channel invariants:
 *
 * - no case hangs and `close()` settles within 10 s; no channel reports `failed`;
 * - each connection gets exactly one `disconnected` and one `drained`, in that order and after its producer events, so
 *   no connection and no channel ends silently; a channel closed early still disconnects every connection and drains
 *   each connection that held no frames;
 * - messages of one connection arrive once each and in order, and all of them when the connection ended without a
 *   reason; a connection the receiver ended carries the reason;
 * - while the channel is open, valid producers connect or are refused as `channel-busy`, never as unavailable, and a
 *   later producer connects;
 * - `rejected` events number at least one and at most the refusals made;
 * - the shared byte budget returns in full, so a fresh receiver on it still presents a frame.
 *
 * The suite is skipped unless `DSH_FRAME_FORWARDING_STRESS=1`. Further variables:
 * - `DSH_FRAME_FORWARDING_STRESS_CASES`: number of cases, default 40;
 * - `DSH_FRAME_FORWARDING_STRESS_SEED`: base seed, default random; case i uses `(seed + i * 7919) >>> 0`;
 * - `DSH_FRAME_FORWARDING_STRESS_SEEDS`: comma-separated case seeds to replay instead;
 * - `DSH_FRAME_FORWARDING_STRESS_MINUTES`: start no case after this many minutes, default 15.
 * Each case logs its seed and parameters when it starts and is named after its seed; replay a failure with
 * `DSH_FRAME_FORWARDING_STRESS_SEEDS=<seed>`.
 *
 * Prerequisites match `event-backlog-native.e2e.ts`: build the addon with
 * `pnpm --filter @deepseek-ai/dsh-desktop run build:native`, on Windows from a Visual Studio x64 developer
 * environment (vcvarsall); on macOS the Xcode command line tools provide clang++.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { FrameForwardingBudget, FrameForwardingReceiver } from '../src/host/native.ts'
import {
  blockFor, corruptTx, createChannel, killProducers, nativeSupported, ofConnection, pendingLimitText, sequence, setupHarness,
  startProducer, summarize, teardownHarness, within, type Channel, type ChannelOptions, type Event, type Harness, type Producer,
} from './backlog-harness.ts'

function integer(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`)
  return value
}

const enabled = process.env.DSH_FRAME_FORWARDING_STRESS === '1'
const baseSeed = enabled ? integer('DSH_FRAME_FORWARDING_STRESS_SEED', Math.floor(Math.random() * 2 ** 31)) : 0
const replay = process.env.DSH_FRAME_FORWARDING_STRESS_SEEDS?.split(',').map(seed => seed.trim()).filter(Boolean).map((seed) => {
  const value = Number(seed)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`DSH_FRAME_FORWARDING_STRESS_SEEDS has an invalid seed ${JSON.stringify(seed)}`)
  return value >>> 0
})
// A disabled run keeps one skipped case, since a file without tests fails the run.
const seeds = enabled
  ? replay ?? Array.from({ length: integer('DSH_FRAME_FORWARDING_STRESS_CASES', 40) }, (_, index) => (baseSeed + index * 7919) >>> 0)
  : [0]
const budgetMs = (enabled ? integer('DSH_FRAME_FORWARDING_STRESS_MINUTES', 15) : 0) * 60_000

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

type End = 'hold' | 'goodbye' | 'crash' | 'kill'
type CloseAt = 'after' | 'connected' | 'during'
interface Params {
  messages: number
  length: number
  /** Stall inside the first `connected` callback. */
  blockOnConnected: number
  /** Stall inside the callback of one flooded message. */
  blockAtMessage: { seq: number; ms: number } | null
  /** Stalls from timers, `at` ms after the case starts. */
  timedBlocks: { at: number; ms: number }[]
  refusals: number
  refusers: number
  end: End
  holdMs: number
  killAt: number
  /** -1 for no successor. */
  successorAt: number
  closeAt: CloseAt
  closeDelay: number
  frames: number
}

function params(seed: number): Params {
  const random = mulberry32(seed)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
  const messages = pick([0, 10, 200, 255, 256, 257, 400, 1000, 3000, 20000])
  let length = pick([16, 64, 1024, 8000, 16000])
  // Keep one case's traffic below 40 MB.
  while (messages * length > 40e6) length = Math.floor(length / 2)
  const blockOnConnected = pick([0, 0, 0, 50, 300, 1500])
  const blockAtMessage = pick([false, false, true]) ? { seq: pick([0, 100, 255]), ms: pick([100, 500, 1500]) } : null
  const timedBlocks = Array.from({ length: pick([0, 0, 1, 2, 3]) }, () => ({
    at: Math.floor(random() * 1500), ms: pick([20, 100, 500, 1500]),
  }))
  const refusals = pick([0, 0, 0, 50, 300])
  return {
    messages, length, blockOnConnected, blockAtMessage, timedBlocks, refusals, refusers: refusals ? pick([1, 2]) : 0,
    end: pick(['hold', 'goodbye', 'crash', 'kill'] as const), holdMs: 500 + Math.floor(random() * 2500), killAt: Math.floor(random() * 1500),
    successorAt: pick([-1, 0, 300, 1000, 2500]), closeAt: pick(['after', 'after', 'after', 'connected', 'during'] as const),
    closeDelay: Math.floor(random() * 500), frames: pick([0, 0, 2, 5]),
  }
}

interface Violation { kind: string; detail?: unknown }

const connectionIds = (events: readonly Event[]) => events.flatMap(event => (event.type === 'connected' ? [event.connectionId as number] : []))
const has = (events: readonly Event[], type: Event['type'], id: number) => ofConnection(events, id).some(event => event.type === type)
const unavailable = (producer: Producer | undefined) => producer?.lines.some(line => line.includes('receiver unavailable')) ?? false
/** A valid producer connected, or was refused because another producer held the channel. */
const admittedOrBusy = (producer: Producer) => producer.line('connected') !== undefined || producer.line('connect-failed')?.startsWith('connect-failed channel-busy') === true

describe.skipIf(!enabled || !nativeSupported)('seeded stress of the receiver pending-event limit', { retry: 0 }, () => {
  let harness: Harness | undefined
  /** The smallest budget with which a receiver of maxFrames 1 still presents a 64x64 frame, so a leak blocks the next. */
  let tightBudget = 0
  let started = 0
  let hung: number | undefined
  const receivers: FrameForwardingReceiver[] = []
  beforeAll(async () => {
    harness = await setupHarness()
    for (const bytes of [16384, 32768, 65536, 131072, 262144, 524288, 1048576]) {
      if ((await framesFlow(harness.bindings.createBudget(bytes), bytes)).ok) { tightBudget = bytes; break }
    }
    expect(tightBudget, 'no budget up to 1 MiB presented a frame').toBeGreaterThan(0)
    console.log(`[frame-forwarding stress] base seed ${String(baseSeed)}, ${String(seeds.length)} cases, tight budget ${String(tightBudget)} bytes`)
    started = performance.now()
  }, 300_000)
  afterEach(async () => {
    await Promise.all(receivers.splice(0).map(async receiver => within(receiver.close(), 10_000)))
    if (harness) await killProducers(harness)
  }, 30_000)
  afterAll(async () => { await teardownHarness(harness) }, 30_000)

  function open(hook: Parameters<typeof createChannel>[1], options: ChannelOptions): Channel {
    const channel = createChannel(harness!, hook, options)
    receivers.push(channel.receiver)
    return channel
  }

  /** Whether a fresh receiver on `budget` presents one frame of a new producer. */
  async function framesFlow(budget: FrameForwardingBudget, maxBytes: number): Promise<{ ok: boolean; detail: string }> {
    const channel = createChannel(harness!, undefined, { maxFrames: 1, maxBytes, budget })
    // A producer that leaves at once loses a frame the receiver has not delivered, so this one holds until asked to exit.
    const producer = startProducer(harness!, channel.receiver.tx, 'produce', { frames: 1, after: 'hold', 'hold-ms': 8000 })
    try {
      await channel.waitFor('the frame check frame', events => events.some(event => event.type === 'frame'), 6_000)
      const connected = channel.events.find(event => event.type === 'connected')
      if (connected?.type === 'connected') channel.receiver.send(connected.connectionId, 'exit')
      await within(producer.exited, 15_000)
      await channel.waitFor('the frame check to drain', events => events.some(event => event.type === 'drained'), 10_000)
      return { ok: channel.count('frame') === 1, detail: `${producer.lines.join(' | ')}; ${summarize(channel.events)}` }
    } catch (error) {
      return { ok: false, detail: `${(error as Error).message}; ${producer.lines.join(' | ')}` }
    } finally {
      await within(channel.receiver.close(), 10_000)
      await producer.kill()
    }
  }

  async function runCase(p: Params): Promise<{ violations: Violation[]; events: Event[] }> {
    const h = harness!
    const violations: Violation[] = []
    const add = (kind: string, detail?: unknown) => { violations.push({ kind, detail }) }
    const maxBytes = p.frames > 0 ? tightBudget : 1 << 20
    const budget = h.bindings.createBudget(maxBytes)
    let closing: Promise<void> | undefined
    let stalledOnConnect = false
    const channel = open((event, receiver) => {
      if (event.type === 'connected') {
        // The successor can connect first; it ignores "go".
        try {
          receiver.send(event.connectionId, 'go')
        } catch (_connectionEnded) {
          // A connection that already ended refuses the send, and its disconnected event still follows.
        }
        if (stalledOnConnect) return
        stalledOnConnect = true
        blockFor(p.blockOnConnected)
        if (p.closeAt === 'connected') closing ??= receiver.close()
      } else if (event.type === 'message' && p.blockAtMessage && sequence([event])[0] === p.blockAtMessage.seq) {
        blockFor(p.blockAtMessage.ms)
      }
    }, { maxFrames: 1, maxBytes, budget })
    const { receiver, events } = channel
    const timers: ReturnType<typeof setTimeout>[] = []
    const later = (ms: number, action: () => void) => { timers.push(setTimeout(action, ms)) }
    const refusers = Array.from({ length: p.refusers }, () => startProducer(h, corruptTx(receiver.tx), 'refuse', {
      count: Math.ceil(p.refusals / p.refusers), 'max-ms': 8000,
    }))
    const main = startProducer(h, receiver.tx, 'produce', {
      messages: p.messages, length: p.length, 'wait-go': 1, after: p.end === 'kill' ? 'hold' : p.end, 'hold-ms': p.holdMs, frames: p.frames,
    })
    for (const timed of p.timedBlocks) later(timed.at, () => { blockFor(timed.ms) })
    if (p.end === 'kill') later(p.killAt, () => { main.child.kill('SIGKILL') })
    if (p.closeAt === 'during') later(300 + p.closeDelay, () => { closing ??= receiver.close() })
    let successor: Producer | undefined
    const successorStarted = new Promise<void>((resolve) => {
      if (p.successorAt < 0) { resolve(); return }
      later(p.successorAt, () => {
        successor = startProducer(h, receiver.tx, 'produce', { after: 'hold', 'hold-ms': 300, frames: p.frames > 0 ? 1 : 0 })
        resolve()
      })
    })
    if (await within(main.exited, 30_000) === 'timeout') add('producer-hang', main.lines)
    for (const refuser of refusers) if (await within(refuser.exited, 20_000) === 'timeout') add('refuser-hang', refuser.lines)
    await successorStarted
    if (successor && await within(successor.exited, 20_000) === 'timeout') add('successor-hang', successor.lines)
    for (const timer of timers) clearTimeout(timer)

    const closedEarly = closing !== undefined
    const legit = [main, successor].filter((producer): producer is Producer => producer !== undefined)
    let probe: Producer | undefined
    if (!closedEarly) {
      const reported = legit.filter(producer => producer.line('connected') !== undefined).length
      // Every connection a producer reported is known to JavaScript and drained before the probe connects.
      const settled = (list: readonly Event[]) => connectionIds(list).length >= reported && connectionIds(list).every(id => has(list, 'drained', id))
      await channel.waitFor('every connection to drain', settled, 20_000).catch((error: unknown) => { add('missing-drained', (error as Error).message) })
      const before = connectionIds(events).length
      probe = startProducer(h, receiver.tx, 'produce', { after: 'goodbye' })
      if (await within(probe.exited, 20_000) === 'timeout') add('probe-hang', probe.lines)
      if (probe.line('connected') === undefined) add('probe-refused', probe.lines)
      else {
        await channel.waitFor('the probe to drain', list => connectionIds(list).length > before && settled(list), 20_000)
          .catch((error: unknown) => { add('probe-not-drained', (error as Error).message) })
      }
    }
    closing ??= receiver.close()
    const closeStarted = performance.now()
    if (await within(closing, 10_000) === 'timeout') add('close-timeout', Math.round(performance.now() - closeStarted))
    else if (closedEarly) {
      // Events queued before the close are still dispatched, possibly after close settles.
      const ended = (list: readonly Event[]) => connectionIds(list).every(id => has(list, 'disconnected', id) && (p.frames > 0 || has(list, 'drained', id)))
      await channel.waitFor('every connection to end after close', ended, 10_000)
        .catch((error: unknown) => { add('missing-terminal-after-close', (error as Error).message) })
    }

    // Per-connection order, uniqueness and message sequence.
    const pidOf = new Map(events.flatMap(event => (event.type === 'connected' ? [[event.connectionId as number, event.pid] as const] : [])))
    for (const id of connectionIds(events)) {
      const own = ofConnection(events, id)
      const types = own.map(event => event.type)
      if (types[0] !== 'connected' || types.lastIndexOf('connected') !== 0) add('connected-order', { id, types: summarize(own) })
      const disconnected = types.filter(type => type === 'disconnected').length, drained = types.filter(type => type === 'drained').length
      if (disconnected > 1 || drained > 1) add('duplicate-terminal', { id, disconnected, drained })
      if (!closedEarly && (disconnected !== 1 || drained !== 1)) add('missing-terminal', { id, disconnected, drained })
      if (drained === 1 && types.at(-1) !== 'drained') add('event-after-drained', { id, types: summarize(own) })
      const ending = types.indexOf('disconnected')
      if (drained === 1 && (ending < 0 || types.indexOf('drained') < ending)) add('drained-before-disconnected', { id })
      if (ending >= 0 && types.slice(ending).some(type => type === 'message' || type === 'frame' || type === 'presentation-error'))
        add('producer-event-after-disconnected', { id, types: summarize(own) })
      const seqs = sequence(own)
      const bad = seqs.findIndex((seq, index) => seq !== index)
      if (bad >= 0) add('message-order', { id, index: bad, seq: seqs[bad] })
      const text = own.find(event => event.type === 'disconnected')?.text
      if (text === pendingLimitText && pidOf.get(id) !== main.child.pid) add('overflow-without-flood', { id })
    }
    if (channel.count('failed') > 0) add('failed', events.filter(event => event.type === 'failed'))

    if (!closedEarly) {
      const mainId = [...pidOf].find(([, pid]) => pid === main.child.pid)?.[0]
      const mainEvents = mainId === undefined ? [] : ofConnection(events, mainId)
      const mainText = mainEvents.find(event => event.type === 'disconnected')?.text
      for (const producer of [...legit, probe]) if (unavailable(producer)) add('receiver-unavailable', producer!.lines)
      const killedEarly = p.end === 'kill' && main.lines.length === 0
      if (!killedEarly && !admittedOrBusy(main)) add('main-refused', main.lines)
      if (successor && !admittedOrBusy(successor)) add('successor-refused', successor.lines)
      if (main.line('connected') !== undefined && mainId === undefined) add('missing-connected', main.lines)
      // The receiver ends a connection only with a reason; a clean end delivers every message sent.
      if (main.line('closed') !== undefined && mainText === undefined) add('closed-without-reason', main.line('closed'))
      const sent = /^sent ok=(\d+)/u.exec(main.line('sent') ?? '')
      if (mainId !== undefined && mainText === undefined && (p.end === 'hold' || p.end === 'goodbye') && sent && sequence(mainEvents).length !== Number(sent[1]))
        add('lost-messages', { sent: Number(sent[1]), received: sequence(mainEvents).length })
      const frames = /^frames submitted=(\d+) failure=(.*)$/u.exec(main.line('frames') ?? '')
      const plannedStall = p.blockOnConnected + (p.blockAtMessage?.ms ?? 0) + p.timedBlocks.reduce((total, block) => total + block.ms, 0)
      if (frames && mainText === undefined && (frames[2] !== '' || (Number(frames[1]) < p.frames && plannedStall <= 2000)))
        add('frames-stalled', main.line('frames'))
      // Each refusal queues at most one rejected event, and a pending one is always delivered.
      const counts = refusers.map(refuser => /credential=(\d+) other=(\d+)/u.exec(refuser.line('refused') ?? ''))
      const credential = counts.reduce((total, match) => total + Number(match?.[1] ?? 0), 0)
      const refusals = credential + counts.reduce((total, match) => total + Number(match?.[2] ?? 0), 0)
        + [...legit, probe].filter(producer => producer?.line('connect-failed') !== undefined).length
      const rejected = channel.count('rejected')
      if (rejected > refusals || (credential > 0 && rejected === 0)) add('rejected-count', { rejected, refusals, credential })
    }
    if (p.frames > 0 && violations.every(violation => violation.kind !== 'close-timeout')) {
      const check = await framesFlow(budget, maxBytes)
      if (!check.ok) add('budget-not-returned', check.detail)
    }
    return { violations, events }
  }

  it.for(seeds)('keeps channel invariants for seed %i', { timeout: 150_000 }, async (seed, { skip }) => {
    if (hung !== undefined) skip(`seed ${String(hung)} hung, and its producers or receiver may still be running`)
    if (performance.now() - started > budgetMs) skip('the stress time budget is spent')
    const p = params(seed)
    console.log(`[frame-forwarding stress] seed ${String(seed)} ${JSON.stringify(p)}`)
    const outcome = await within(runCase(p), 120_000)
    if (outcome === 'timeout') {
      hung = seed
      expect.fail(`seed ${String(seed)} did not finish within 120 s; replay with DSH_FRAME_FORWARDING_STRESS_SEEDS=${String(seed)}`)
    }
    expect(outcome.violations, `seed ${String(seed)} ${JSON.stringify(p)}; events: ${summarize(outcome.events)}; `
      + `replay with DSH_FRAME_FORWARDING_STRESS=1 DSH_FRAME_FORWARDING_STRESS_SEEDS=${String(seed)}`).toEqual([])
  })
})
