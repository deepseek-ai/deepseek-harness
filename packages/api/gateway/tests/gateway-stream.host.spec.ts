import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { queryObjects } from 'node:v8'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { Context, symbols } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { AppReady } from '@deepseek-ai/dsh-cmdline'
import {
  Remote,
  remoteErrorOf,
  TypertRemoteService,
  type InvocationDescriptor,
  type PeerScope,
  type RemoteInvocation,
  type RemoteStream,
  type TypertContextMap,
  type TypertContextWire,
  RemoteError,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'fixture/rejected': { readonly retryable: boolean }
    'fixture/broken': { readonly count: bigint }
  }
}
import { browserCookie, provideBrowserCredentials } from './browser-credentials.ts'
import TypertGatewayService, {
  TypertGatewayError,
  type Config as GatewayConfig,
  type TypertRemoteEventDispatch,
  type TypertRemoteEventInvocation,
  type TypertRemoteEventOutcome,
} from '@deepseek-ai/dsh-api-gateway'
import { z } from 'zod'
import type {
  RemoteEventClientId,
  RemoteEventInvocationFrame,
} from '../src/stream-protocol.ts'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

const randomUuid = vi.mocked(randomUUID)
const REMOTE_HOST = { home: '/home/fixture' } as const
type AgentWireId = TypertContextWire<TypertContextMap['agent']>
const agentId = (value: string): AgentWireId => value as AgentWireId

class FeedService extends TypertRemoteService {
  readonly signals: AbortSignal[] = []
  readonly peeked: unknown[] = []
  readonly peers: PeerScope[] = []
  leftover: AsyncIterator<string> | undefined
  source: Iterable<string> = []
  returns = 0

  constructor(ctx: Context) {
    super(ctx, 'feed')
  }

  @Remote({ mode: 'stream' })
  async *follow(label: string, signal: AbortSignal): AsyncIterable<string> {
    this.signals.push(signal)
    try {
      yield `${label}:ready`
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    } finally {
      this.returns += 1
    }
  }

  @Remote({ mode: 'stream' })
  *sync(label: string): Iterable<string> {
    yield `${label}:one`
    yield `${label}:two`
  }

  @Remote({ mode: 'stream' })
  items(): Iterable<string> {
    return this.source
  }

  @Remote({ mode: 'stream' })
  *invalid(): Iterable<string> {
    yield 42 as unknown as string
  }

  @Remote({ mode: 'stream' })
  *nonJson(): Iterable<unknown> {
    yield 1n
  }

  @Remote({ mode: 'stream' })
  missing(): Iterable<string> {
    return null as unknown as Iterable<string>
  }

  @Remote({ mode: 'stream' })
  *src(label: string): Iterable<string> {
    yield `${label}:src`
  }

  @Remote({ mode: 'stream' })
  abortBeforeOpen(signal: AbortSignal): Iterable<string> {
    if (signal.aborted) throw new Error('fixture observed pre-open cancellation')
    return []
  }

  @Remote({ mode: 'stream' })
  reject(): Iterable<string> {
    throw new RemoteError('fixture/rejected', 'fixture rejected the stream', { retryable: false })
  }

  @Remote({ mode: 'stream' })
  rejectWithNonJsonDetails(): Iterable<string> {
    throw new RemoteError('fixture/broken', 'fixture emitted invalid details', { count: 1n })
  }

  @Remote({ mode: 'stream' })
  async *echo(prefix: string, signal: AbortSignal): RemoteStream<string, string> {
    this.signals.push(signal)
    const invocation = this.invocation()
    this.peers.push(invocation.peer)
    try {
      for await (const item of invocation.uplink<string>()) yield `${prefix}${item}`
    } finally {
      this.returns += 1
    }
  }

  /** Hides the uplink failure so the test proves the Gateway still fails the stream. */
  @Remote({ mode: 'stream' })
  async *swallow(signal: AbortSignal): RemoteStream<string, string> {
    try {
      for await (const item of this.invocation().uplink<string>()) yield item
    } catch {
      // The fixture keeps yielding after the rejected item on purpose.
    }
    yield 'swallowed'
    await abortOf(signal)
  }

  /** Never takes its uplink. */
  @Remote({ mode: 'stream' })
  async *ignore(prefix: string): RemoteStream<string, string> {
    yield `${prefix}:one`
    yield `${prefix}:two`
  }

  /** Keeps the downlink open without reading, and retains the uplink iterator for post-stream reads. */
  @Remote({ mode: 'stream' })
  async *hold(signal: AbortSignal): RemoteStream<string, string> {
    this.leftover = this.invocation().uplink<string>()[Symbol.asyncIterator]()
    yield 'held'
    await abortOf(signal)
  }

  /** Reads before yielding so cancellation races the pending read, then reads once more after the abort. */
  @Remote({ mode: 'stream' })
  async *peek(signal: AbortSignal): RemoteStream<string, string> {
    const iterator = this.invocation().uplink<string>()[Symbol.asyncIterator]()
    const pending = iterator.next().then(result => result, (error: unknown) => error)
    yield 'ready'
    await abortOf(signal)
    this.peeked.push(await pending, await iterator.next().then(result => result, (error: unknown) => error))
  }

  /** Yields once, then blocks on the uplink until the Gateway closes it. */
  @Remote({ mode: 'stream' })
  async *drain(): RemoteStream<string, string> {
    yield 'ready'
    for await (const item of this.invocation().uplink<string>()) yield item
  }

  /** Reads the uplink to its end and then again: an ended uplink reports done on every later read. */
  @Remote({ mode: 'stream' })
  async *rereads(): RemoteStream<string, string> {
    const uplink = this.invocation().uplink<string>()
    for await (const item of uplink) yield item
    for await (const item of uplink) yield `again:${item}`
    yield 'done'
  }

  /** Reports the call context; its descriptor declares no uplink codec, so items arrive as `unknown`. */
  @Remote({ mode: 'stream' })
  async *context(label: string): RemoteStream<string> {
    const invocation = this.invocation()
    this.peers.push(invocation.peer)
    const { namespace, method, args } = invocation.request
    yield `${namespace}/${method}:${invocation.service}:${JSON.stringify(args)}:${label}`
    for await (const item of invocation.uplink()) yield `raw:${JSON.stringify(item)}`
    try {
      invocation.uplink()
    } catch (error) {
      yield error instanceof Error ? error.message : String(error)
    }
  }

  /** SRC-discovered: no descriptor, so uplink items arrive as `unknown`. */
  @Remote({ mode: 'stream' })
  async *srcEcho(prefix: string, signal: AbortSignal): RemoteStream<string, string> {
    void signal
    for await (const item of this.invocation().uplink()) yield `${prefix}${String(item)}`
  }

  unary(label: string): string {
    return label
  }

  /** Reads the uplink inside a unary call: items arrive only while the method runs. */
  async unaryUplink(): Promise<string[]> {
    const items: string[] = []
    for await (const item of this.invocation().uplink<string>()) items.push(item)
    return items
  }

  /** What `ctx.invocation` reads on the Service's own Context, outside any Remote call. */
  invocationOutsideCall(): RemoteInvocation | undefined {
    return this.ctx.invocation
  }

  private invocation(): RemoteInvocation {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('fixture method ran outside a Remote call')
    return invocation
  }
}

const roots: Context[] = []

class StartupProbe implements AppReady {
  private ready = false
  private readonly listeners = new Set<() => void>()
  lastListener: (() => void) | undefined

  get pending(): number { return this.listeners.size }

  onReady(listener: () => void): () => void {
    this.lastListener = listener
    if (this.ready) {
      listener()
      return () => {}
    }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  commit(): void {
    this.ready = true
    for (const listener of this.listeners) listener()
    this.listeners.clear()
  }
}

class RemoteEventSourceProbe {
  readonly source = (signal: AbortSignal): AsyncIterable<TypertRemoteEventDispatch> => {
    this.signal = signal
    return this.iterate(signal)
  }

  signal: AbortSignal | undefined
  private readonly dispatches: TypertRemoteEventDispatch[] = []
  private wake: (() => void) | undefined

  push(dispatch: TypertRemoteEventDispatch): void {
    this.dispatches.push(dispatch)
    this.wake?.()
    this.wake = undefined
  }

  private async *iterate(signal: AbortSignal): AsyncGenerator<TypertRemoteEventDispatch> {
    const aborted = (): void => {
      this.wake?.()
      this.wake = undefined
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      while (!signal.aborted) {
        while (this.dispatches.length > 0) {
          yield this.dispatches.shift() as TypertRemoteEventDispatch
        }
        if (signal.aborted) return
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', aborted)
    }
  }
}

interface PendingInvocationProbe {
  readonly dispatch: TypertRemoteEventInvocation
  readonly outcome: Promise<TypertRemoteEventOutcome>
  readonly resolve: (outcome: TypertRemoteEventOutcome) => void
  readonly reject: (reason: unknown) => void
}

function pendingInvocation(
  context: Context,
  signal?: AbortSignal,
  prompt = 'ship',
  identity: unknown = agentId('agent-1'),
): PendingInvocationProbe {
  const subject = { ctx: context }
  const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
  const resolve = vi.fn((outcome: TypertRemoteEventOutcome) => {
    settled.resolve(outcome)
  })
  const reject = vi.fn((reason: unknown) => {
    settled.reject(reason)
  })
  return {
    dispatch: {
      event: 'fixture/approval',
      request: { prompt, agent: subject, ...(signal === undefined ? {} : { signal }) },
      context: { value: context, subject, agentId: identity as string },
      resolve,
      reject,
    },
    outcome: settled.promise,
    resolve,
    reject,
  }
}

afterEach(async () => {
  randomUuid.mockClear()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('Typert Remote streams', () => {
  it.each([false, true])('accepts WebSockets only after application readiness (already ready: %s)', async (alreadyReady) => {
    const startup = new StartupProbe()
    if (alreadyReady) startup.commit()
    const { ctx } = await setup(true, {}, startup)
    if (!alreadyReady) {
      expect(startup.pending).toBe(1)
      expect(await acceptsSocket(ctx)).toBe(false)
      startup.commit()
    }
    expect(await acceptsSocket(ctx)).toBe(true)
    expect(startup.pending).toBe(0)
  })

  it('withdraws a pending WebSocket startup subscription when the Gateway unloads', async () => {
    const startup = new StartupProbe()
    const { ctx } = await setup(true, {}, startup)
    expect(startup.pending).toBe(1)
    await ctx.fiber.dispose()
    expect(startup.pending).toBe(0)
    // A launcher commit can already hold a copy of the cancelled listener.
    expect(() => { startup.lastListener?.() }).not.toThrow()
    expect(() => { startup.commit() }).not.toThrow()
  })

  it('validates the WebSocket heartbeat timer range and the stream inbox bound', () => {
    expect(TypertGatewayService.Config({})).toEqual({ websocketHeartbeatIntervalMs: 2_000, streamInboxBytes: 262_144 })
    expect(TypertGatewayService.Config({ websocketHeartbeatIntervalMs: MAX_TIMER_DELAY_MS, streamInboxBytes: 1 }))
      .toEqual({ websocketHeartbeatIntervalMs: MAX_TIMER_DELAY_MS, streamInboxBytes: 1 })
    for (const websocketHeartbeatIntervalMs of [0, 1.5, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => TypertGatewayService.Config({ websocketHeartbeatIntervalMs })).toThrow()
    }
    for (const streamInboxBytes of [0, 1.5]) {
      expect(() => TypertGatewayService.Config({ streamInboxBytes })).toThrow()
    }
  })

  it('opens decoded carrier payloads through the in-process wire adapter', async () => {
    const { ctx } = await setup(false)
    const source = await ctx.typertGateway.wireStream.open(
      'feed/sync',
      { args: { label: 'wire' } },
      toAsync([]),
      undefined,
      new AbortController().signal,
    )
    await expect(collect(source)).resolves.toEqual(['wire:one', 'wire:two'])

    const echoed = await ctx.typertGateway.wireStream.open(
      'feed/echo',
      { args: { prefix: 'wire:' } },
      toAsync(['a', 'b']),
      undefined,
      new AbortController().signal,
    )
    await expect(collect(echoed)).resolves.toEqual(['wire:a', 'wire:b'])
  })

  it('delivers uplink items through the in-process carrier and ends on half-close', async () => {
    const { ctx, service } = await setup(false)
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'echo', args: { prefix: '> ' }, uplink: toAsync(['a', 'b']),
    }))).resolves.toEqual(['> a', '> b'])
    expect(service.returns).toBe(1)
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'echo', args: { prefix: 'x' },
    }))).resolves.toEqual([])
    await expect(ctx.typertGateway.invoke({
      namespace: 'feed', method: 'echo', args: { prefix: 'x' },
    })).rejects.toMatchObject({
      code: 'gateway/signature-invalid',
      message: 'typert gateway: feed/echo: stream Remote methods must be opened through the stream carrier',
    })

    // The caller's iterator is released even when its own return() rejects.
    const returned = vi.fn(async (): Promise<IteratorResult<string>> => {
      throw new Error('fixture release failure')
    })
    const unread: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: returned,
      }),
    }
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'ignore', args: { prefix: 'i' }, uplink: unread,
    }))).resolves.toEqual(['i:one', 'i:two'])
    await vi.waitFor(() => { expect(returned).toHaveBeenCalledOnce() })
  })

  it('fails a stream whose uplink item fails its codec, even when the method swallows the failure', async () => {
    const { ctx, service } = await setup(false)
    const rejected = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'echo', args: { prefix: '' }, uplink: toAsync<unknown>(['ok', 1]),
    })
    const iterator = rejected[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'ok' })
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'gateway/input-invalid',
      details: { endpoint: 'feed/echo', field: 'uplink' },
    })
    const signal = service.signals.at(-1)
    expect(signal?.aborted).toBe(true)
    expect(remoteErrorOf(signal?.reason)?.code).toBe('gateway/input-invalid')
    expect(service.returns).toBe(1)

    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'swallow', args: {}, uplink: toAsync<unknown>([1]),
    }))).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  })

  it('ends a pending uplink read on cancellation and reports later reads as cancelled', async () => {
    const { ctx, service } = await setup(false)
    const abort = new AbortController()
    const source = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'peek', args: {}, uplink: neverYielding(), signal: abort.signal,
    })
    const iterator = source[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'ready' })
    const pending = iterator.next()
    abort.abort(new Error('fixture cancellation'))
    await expect(pending).rejects.toThrow('Remote invocation "feed/peek" was aborted')
    await vi.waitFor(() => { expect(service.peeked).toHaveLength(2) })
    expect(service.peeked.map(outcome => remoteErrorOf(outcome)?.code))
      .toEqual(['gateway/cancelled', 'gateway/cancelled'])
  })

  it('drops unread uplink items once the method finishes', async () => {
    const { ctx, service } = await setup(false)
    const abort = new AbortController()
    const source = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'hold', args: {}, uplink: toAsync(['unread']), signal: abort.signal,
    })
    const iterator = source[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'held' })
    const pending = iterator.next()
    abort.abort(new Error('fixture cancellation'))
    await expect(pending).rejects.toThrow('Remote invocation "feed/hold" was aborted')
    const leftover = service.leftover
    if (leftover === undefined) throw new Error('fixture did not retain its uplink iterator')
    // The unread item is gone; a cancelled stream reports the cancellation on every later read.
    await expect(leftover.next()).rejects.toMatchObject({ code: 'gateway/cancelled' })
    await expect(leftover.return?.()).resolves.toEqual({ done: true, value: undefined })
  })

  it('exposes the call as ctx.invocation, delivers codec-less uplink items as unknown, and hands the uplink out once', async () => {
    const { ctx, service } = await setup(false)
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'context', args: { label: 'ctx' }, uplink: toAsync<unknown>([1, { nested: true }]),
    }))).resolves.toEqual([
      'feed/context:feed:{"label":"ctx"}:ctx',
      'raw:1',
      'raw:{"nested":true}',
      'typert gateway: feed/context: invocation.uplink() is available once per call',
    ])
    expect(service.peers.at(-1)?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(service.invocationOutsideCall()).toBeUndefined()
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'context', args: { label: 'again' },
    }))).resolves.toHaveLength(2)
    expect(service.peers.at(-1)).toBe(service.peers.at(-2))
    await expect(service.peers.at(-1)?.dispose()).resolves.toBeUndefined()

    // Items sent to a method that never takes its uplink wait in the carrier and are dropped when the downlink ends.
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'sync', args: { label: 'closed' }, uplink: toAsync(['unread']),
    }))).resolves.toEqual(['closed:one', 'closed:two'])

    // Without a codec an item still has to be a JSON-safe value.
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'context', args: { label: 'bad' }, uplink: toAsync<unknown>([1n]),
    }))).rejects.toMatchObject({
      code: 'gateway/input-invalid',
      details: { endpoint: 'feed/context', field: 'uplink' },
    })
  })

  it('releases a taken uplink source even when its return() rejects', async () => {
    const { ctx } = await setup(false)
    const abort = new AbortController()
    const returned = vi.fn(async (): Promise<IteratorResult<string>> => {
      throw new Error('fixture release failure')
    })
    const stuck: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<string>>(() => {}),
        return: returned,
      }),
    }
    const source = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'hold', args: {}, uplink: stuck, signal: abort.signal,
    })
    const iterator = source[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'held' })
    const pending = iterator.next()
    abort.abort(new Error('fixture cancellation'))
    await expect(pending).rejects.toThrow('Remote invocation "feed/hold" was aborted')
    await vi.waitFor(() => { expect(returned).toHaveBeenCalledOnce() })
  })

  it('closes the uplink before returning a method blocked on it', async () => {
    const { ctx } = await setup(false)
    const source = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'drain', args: {}, uplink: neverYielding(),
    })
    const iterator = source[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'ready' })
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
  })

  it('finishes every pending uplink read when the downlink returns', async () => {
    const { ctx, service } = await setup(false)
    const reads = [
      Promise.withResolvers<IteratorResult<string>>(),
      Promise.withResolvers<IteratorResult<string>>(),
    ]
    let index = 0
    const returned = vi.fn(async (): Promise<IteratorResult<string>> => ({ done: true, value: undefined }))
    const source = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'hold', args: {},
      uplink: { [Symbol.asyncIterator]: () => ({ next: () => reads[index++]!.promise, return: returned }) },
    })
    const iterator = source[Symbol.asyncIterator]()
    const completed: IteratorResult<string>[] = []
    const pending: Promise<void>[] = []
    try {
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'held' })
      const uplink = service.leftover!
      pending.push(...reads.map(() => uplink.next().then((result) => { completed.push(result) })))
      await iterator.return?.()
      expect(completed).toEqual([
        { done: true, value: undefined },
        { done: true, value: undefined },
      ])
      expect(returned).toHaveBeenCalledOnce()
    } finally {
      for (const read of reads) read.resolve({ done: true, value: undefined })
      await Promise.all(pending)
      await iterator.return?.()
    }
  })

  it.each(['downlink', 'uplink'] as const)('releases consumed %s read results while the stream stays open', async (direction) => {
    class ReadResult implements IteratorYieldResult<string> {
      readonly done = false
      readonly value = 'item'
    }
    const { ctx, service } = await setup(false)
    service.source = { [Symbol.iterator]: () => ({ next: () => new ReadResult() }) }
    const source = await ctx.typertGateway.stream(direction === 'downlink'
      ? { namespace: 'feed', method: 'items', args: {} }
      : {
        namespace: 'feed', method: 'echo', args: { prefix: '' },
        uplink: { [Symbol.asyncIterator]: () => ({ next: async () => new ReadResult() }) },
      })
    const iterator = source[Symbol.asyncIterator]()
    try {
      for (const count of [64, 256]) {
        for (let index = 0; index < count; index++) {
          await expect(iterator.next()).resolves.toEqual({ done: false, value: 'item' })
        }
        // queryObjects collects garbage; the suspended read can retain its last result, not the history.
        expect(queryObjects(ReadResult, { format: 'count' })).toBeLessThanOrEqual(2)
      }
    } finally {
      await iterator.return?.()
    }
  })

  it('does not read another downlink item after cancellation between reads', async () => {
    const { ctx, service } = await setup(false)
    const abort = new AbortController()
    const next = vi.fn((): IteratorResult<string> => ({ done: false, value: 'item' }))
    service.source = { [Symbol.iterator]: () => ({ next }) }
    const source = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'items', args: {}, signal: abort.signal,
    })
    const iterator = source[Symbol.asyncIterator]()
    try {
      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'item' })
      abort.abort(new Error('caller cancelled between reads'))
      await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/cancelled' })
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await iterator.return?.()
    }
  })

  it.each(['downlink', 'uplink'] as const)('handles a synchronous %s read that aborts and throws', async (direction) => {
    const { ctx, service } = await setup(false)
    const abort = new AbortController()
    const failure = new Error('source aborted and threw')
    const next = (): never => {
      abort.abort(failure)
      throw failure
    }
    service.source = { [Symbol.iterator]: () => ({ next }) }
    const source = await ctx.typertGateway.stream(direction === 'downlink'
      ? { namespace: 'feed', method: 'items', args: {}, signal: abort.signal }
      : {
        namespace: 'feed', method: 'hold', args: {}, signal: abort.signal,
        uplink: { [Symbol.asyncIterator]: () => ({ next }) },
      })
    const iterator = source[Symbol.asyncIterator]()
    try {
      if (direction === 'uplink') {
        await expect(iterator.next()).resolves.toEqual({ done: false, value: 'held' })
      }
      await expect((direction === 'downlink' ? iterator : service.leftover!).next()).rejects.toBe(failure)
    } finally {
      await iterator.return?.()
    }
  })

  it('reports done on every read after the uplink ended', async () => {
    const { ctx } = await setup(false)
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'rereads', args: {}, uplink: toAsync(['a', 'b']),
    }))).resolves.toEqual(['a', 'b', 'done'])
  })

  it('accepts a top-level undefined uplink item where no codec applies and rejects it where one does', async () => {
    const { ctx } = await setup(false)
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'context', args: { label: 'absent' }, uplink: toAsync<unknown>([undefined, 'x']),
    }))).resolves.toEqual([
      'feed/context:feed:{"label":"absent"}:absent',
      'raw:undefined',
      'raw:"x"',
      'typert gateway: feed/context: invocation.uplink() is available once per call',
    ])
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'echo', args: { prefix: '' }, uplink: toAsync<unknown>([undefined]),
    }))).rejects.toMatchObject({ code: 'gateway/input-invalid', details: { endpoint: 'feed/echo', field: 'uplink' } })
  })

  it('releases the uplink when a unary method is opened through the stream carrier', async () => {
    const { ctx } = await setup(false)
    const returned = vi.fn(async (): Promise<IteratorResult<string>> => ({ value: undefined, done: true }))
    const unread: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => {}), return: returned }),
    }
    await expect(ctx.typertGateway.stream({
      namespace: 'feed', method: 'unary', args: { label: 'a' }, uplink: unread,
    })).rejects.toMatchObject({ code: 'gateway/signature-invalid' })
    await vi.waitFor(() => { expect(returned).toHaveBeenCalledOnce() })
  })

  it('lets a unary method read uplink items while it runs', async () => {
    const { ctx } = await setup(false)
    await expect(ctx.typertGateway.invoke({
      namespace: 'feed', method: 'unaryUplink', args: {}, uplink: toAsync(['a', 'b']),
    })).resolves.toEqual(['a', 'b'])
  })

  it('derives SRC descriptors whose uplink arrives without a codec', async () => {
    const { ctx } = await setup(false)
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'srcEcho', args: { prefix: 's:' }, uplink: toAsync<unknown>(['a', 2]),
    }))).resolves.toEqual(['s:a', 's:2'])
  })

  it('echoes uplink frames over the WebSocket carrier and fails misused uplinks per stream', async () => {
    const { ctx, service } = await setup(true)
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    await once(socket, 'open')
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })

    sendOpen(socket, 'echo', 'feed/echo', { prefix: '> ' })
    socket.send(JSON.stringify({ type: 'item', streamId: 'echo', value: 'a' }))
    socket.send(JSON.stringify({ type: 'item', streamId: 'echo', value: 'b' }))
    socket.send(JSON.stringify({ type: 'end', streamId: 'echo' }))
    await vi.waitFor(() => {
      expect(frames.filter(frame => frame.streamId === 'echo')).toEqual([
        { type: 'item', streamId: 'echo', value: '> a' },
        { type: 'item', streamId: 'echo', value: '> b' },
        { type: 'end', streamId: 'echo' },
      ])
    })
    expect(service.returns).toBe(1)
    expect(service.peers.at(-1)).toBe(ctx.connection.operator)

    sendOpen(socket, 'rejected', 'feed/echo', { prefix: '' })
    socket.send(JSON.stringify({ type: 'item', streamId: 'rejected', value: 1 }))
    await vi.waitFor(() => {
      expect(frames.find(frame => frame.streamId === 'rejected')).toMatchObject({
        type: 'error',
        error: { code: 'gateway/input-invalid', details: { endpoint: 'feed/echo', field: 'uplink' } },
      })
    })

    // An item frame without value is a top-level undefined item.
    sendOpen(socket, 'absent', 'feed/context', { label: 'w' })
    socket.send(JSON.stringify({ type: 'item', streamId: 'absent' }))
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: 'item', streamId: 'absent', value: 'raw:undefined' })
    })

    sendOpen(socket, 'late', 'feed/hold', {})
    await vi.waitFor(() => { expect(frames).toContainEqual({ type: 'item', streamId: 'late', value: 'held' }) })
    socket.send(JSON.stringify({ type: 'end', streamId: 'late' }))
    socket.send(JSON.stringify({ type: 'item', streamId: 'late', value: 'after end' }))
    await vi.waitFor(() => {
      expect(frames.find(frame => frame.streamId === 'late' && frame.type === 'error')).toMatchObject({
        error: { code: 'gateway/protocol', details: { endpoint: 'feed/hold' } },
      })
    })
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
    await once(socket, 'close')
  })

  it('fails a stream whose buffered uplink exceeds the configured inbox bytes', async () => {
    const { ctx } = await setup(true, { streamInboxBytes: 64 })
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    await once(socket, 'open')
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })

    sendOpen(socket, 'big', 'feed/hold', {})
    await vi.waitFor(() => { expect(frames).toContainEqual({ type: 'item', streamId: 'big', value: 'held' }) })
    socket.send(JSON.stringify({ type: 'item', streamId: 'big', value: 'x'.repeat(128) }))
    await vi.waitFor(() => {
      expect(frames.find(frame => frame.streamId === 'big' && frame.type === 'error')).toMatchObject({
        error: { code: 'gateway/uplink-overflow', details: { endpoint: 'feed/hold' } },
      })
    })
    socket.close()
    await once(socket, 'close')
  })

  it('passes Iterable and AsyncIterable items through and returns the iterator on cancellation', async () => {
    const { ctx, service } = await setup(false)
    const abort = new AbortController()
    const source = await ctx.typertGateway.stream({
      namespace: 'feed',
      method: 'follow',
      args: { label: 'a' },
      signal: abort.signal,
    })
    const iterator = source[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'a:ready' })
    const pending = iterator.next()
    abort.abort(new Error('fixture cancellation'))
    await expect(pending).rejects.toThrow('Remote invocation "feed/follow" was aborted')
    expect(service.signals).toEqual([abort.signal])
    expect(service.returns).toBe(1)

    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'sync', args: { label: 'b' },
    }))).resolves.toEqual(['b:one', 'b:two'])
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'invalid', args: {},
    }))).resolves.toEqual([42])
    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'nonJson', args: {},
    }))).resolves.toEqual([1n])
    await expect(ctx.typertGateway.stream({
      namespace: 'feed', method: 'missing', args: {},
    })).rejects.toMatchObject({ code: 'gateway/result-invalid' })

    await expect(collect(await ctx.typertGateway.stream({
      namespace: 'feed', method: 'src', args: { label: 'c' },
    }))).resolves.toEqual(['c:src'])

    const abortedBeforeOpen = new AbortController()
    abortedBeforeOpen.abort(new Error('cancelled before open'))
    await expect(ctx.typertGateway.stream({
      namespace: 'feed', method: 'abortBeforeOpen', args: {}, signal: abortedBeforeOpen.signal,
    })).rejects.toThrow('Remote invocation "feed/abortBeforeOpen" was aborted')

    const abortedBeforeIteration = new AbortController()
    abortedBeforeIteration.abort(new Error('cancelled before iteration'))
    const preCancelled = await ctx.typertGateway.stream({
      namespace: 'feed', method: 'sync', args: { label: 'ignored' }, signal: abortedBeforeIteration.signal,
    })
    await expect(collect(preCancelled)).rejects.toThrow('Remote invocation "feed/sync" was aborted')
  })

  it('keeps unary and stream invocation modes distinct', async () => {
    const { ctx } = await setup(false)
    await expect(ctx.typertGateway.invoke({
      namespace: 'feed', method: 'sync', args: { label: 'a' },
    })).rejects.toMatchObject({ code: 'gateway/signature-invalid' } satisfies Partial<TypertGatewayError>)
    await expect(ctx.typertGateway.stream({
      namespace: 'feed', method: 'unary', args: { label: 'a' },
    })).rejects.toMatchObject({ code: 'gateway/signature-invalid' } satisfies Partial<TypertGatewayError>)
  })

  it('uses the configured WebSocket heartbeat interval', { timeout: 1_000 }, async () => {
    const { ctx } = await setup(true, { websocketHeartbeatIntervalMs: 20 })
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    const ping = once(socket, 'ping')
    await once(socket, 'open')
    expect((await ping)[0]).toEqual(Buffer.alloc(0))

    socket.close()
    await once(socket, 'close')
  })

  it('multiplexes independent streams over one WebSocket and propagates cancellation', async () => {
    const { ctx, service } = await setup(true)
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    await once(socket, 'open')
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })

    sendOpen(socket, 'a', 'feed/follow', { label: 'a' })
    sendOpen(socket, 'b', 'feed/follow', { label: 'b' })
    await vi.waitFor(() => {
      expect(frames).toEqual(expect.arrayContaining([
        { type: 'item', streamId: 'a', value: 'a:ready' },
        { type: 'item', streamId: 'b', value: 'b:ready' },
      ]))
    })
    expect(service.signals.map(signal => signal.aborted)).toEqual([false, false])
    expect(service.returns).toBe(0)

    socket.send(JSON.stringify({ type: 'cancel', streamId: 'a' }))
    await vi.waitFor(() => { expect(service.returns).toBe(1) })
    expect(service.signals[0]?.aborted).toBe(true)
    expect(service.signals[1]?.aborted).toBe(false)

    sendOpen(socket, 'sync', 'feed/sync', { label: 's' })
    sendOpen(socket, 'invalid', 'feed/invalid', {})
    sendOpen(socket, 'non-json', 'feed/nonJson', {})
    sendOpen(socket, 'rejected', 'feed/reject', {})
    await vi.waitFor(() => {
      expect(frames.filter(frame => frame.streamId === 'sync')).toEqual([
        { type: 'item', streamId: 'sync', value: 's:one' },
        { type: 'item', streamId: 'sync', value: 's:two' },
        { type: 'end', streamId: 'sync' },
      ])
      expect(frames.filter(frame => frame.streamId === 'invalid')).toEqual([
        { type: 'item', streamId: 'invalid', value: 42 },
        { type: 'end', streamId: 'invalid' },
      ])
      expect(frames.find(frame => frame.streamId === 'non-json')).toMatchObject({
        type: 'error', error: { code: 'gateway/internal' },
      })
      expect(frames.find(frame => frame.streamId === 'rejected')).toEqual({
        type: 'error',
        streamId: 'rejected',
        error: {
          code: 'fixture/rejected',
          message: 'fixture rejected the stream',
          details: { retryable: false },
        },
      })
    })

    const closed = once(socket, 'close')
    sendOpen(socket, 'broken-error', 'feed/rejectWithNonJsonDetails', {})
    const closeEvent = await closed
    expect(closeEvent[0]).toBe(1011)
    expect(String(closeEvent[1])).toBe('Remote stream failure could not be delivered')
    await vi.waitFor(() => { expect(service.returns).toBe(2) })
    expect(service.signals[1]?.aborted).toBe(true)
  })

  it('keeps uplink frames to a Gateway-owned stream out of the bounded inbox', async () => {
    const { ctx } = await setup(true, { streamInboxBytes: 64 })
    const source = (signal: AbortSignal): AsyncIterable<{ event: string; args: readonly unknown[] }> => (async function *() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })()
    ctx.typertGateway.registerRemoteEvents(source, REMOTE_HOST)

    // An in-process carrier's uplink is returned as soon as the Gateway-owned stream opens.
    const returned = vi.fn(async (): Promise<IteratorResult<unknown>> => ({ value: undefined, done: true }))
    const idle: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}), return: returned }),
    }
    const events = await ctx.typertGateway.wireStream.open('$events', { args: {} }, idle, undefined, new AbortController().signal)
    await vi.waitFor(() => { expect(returned).toHaveBeenCalledOnce() })
    await events[Symbol.asyncIterator]().return?.()

    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    await once(socket, 'open')
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })
    sendOpen(socket, 'events', '$events', {})
    await vi.waitFor(() => { expect(frames.filter(frame => frame.streamId === 'events')).toHaveLength(1) })
    for (let index = 0; index < 4; index += 1) {
      socket.send(JSON.stringify({ type: 'item', streamId: 'events', value: 'x'.repeat(40) }))
    }
    // A Remote stream opened afterwards on the same socket shows the flood was processed and harmed nothing.
    sendOpen(socket, 'after', 'feed/sync', { label: 'after' })
    await vi.waitFor(() => { expect(frames).toContainEqual({ type: 'end', streamId: 'after' }) })
    expect(frames.filter(frame => frame.streamId === 'events').map(frame => frame.type)).toEqual(['item'])
    socket.close()
    await once(socket, 'close')
  })

  it('carries the registered Remote event source and withdraws its active stream', async () => {
    const { ctx } = await setup(true)
    let sourceSignal: AbortSignal | undefined
    const sourceClosed = vi.fn()
    const publish = Promise.withResolvers<undefined>()
    const source = (signal: AbortSignal): AsyncIterable<{ event: string; args: readonly unknown[] }> => {
      sourceSignal = signal
      return (async function *() {
        try {
          await publish.promise
          yield { event: 'fixture/changed', args: ['settings'] }
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
        } finally {
          sourceClosed()
        }
      })()
    }
    const unregister = ctx.typertGateway.registerRemoteEvents(source, REMOTE_HOST)
    expect(() => { ctx.typertGateway.registerRemoteEvents(source, REMOTE_HOST) })
      .toThrow('forwarded Remote event source is already registered')

    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    await once(socket, 'open')
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })
    sendOpen(socket, 'events', '$events', {})

    await vi.waitFor(() => {
      const eventFrames = frames.filter(frame => frame.streamId === 'events')
      expect(eventFrames).toHaveLength(1)
      expect(eventFrames[0]).toMatchObject({
        type: 'item', streamId: 'events', value: { type: 'ready', host: REMOTE_HOST },
      })
      expect(typeof Reflect.get(eventFrames[0]!.value as object, 'clientId')).toBe('string')
    })
    publish.resolve(undefined)
    await vi.waitFor(() => {
      const eventFrames = frames.filter(frame => frame.streamId === 'events').slice(0, 2)
      expect(eventFrames).toHaveLength(2)
      expect(eventFrames[0]).toMatchObject({
        type: 'item', streamId: 'events', value: { type: 'ready', host: REMOTE_HOST },
      })
      expect(typeof Reflect.get(eventFrames[0]!.value as object, 'clientId')).toBe('string')
      expect(eventFrames[1]).toEqual({
        type: 'item', streamId: 'events', value: {
          type: 'emit', event: 'fixture/changed', args: ['settings'],
        },
      })
    })
    expect(sourceSignal?.aborted).toBe(false)

    await unregister()
    expect(sourceClosed).toHaveBeenCalledOnce()
    await vi.waitFor(() => {
      expect(sourceSignal?.aborted).toBe(true)
      expect(frames).toContainEqual({ type: 'end', streamId: 'events' })
    })

    const unregisterReplacement = ctx.typertGateway.registerRemoteEvents(source, REMOTE_HOST)
    await unregister()
    expect(() => { ctx.typertGateway.registerRemoteEvents(source, REMOTE_HOST) })
      .toThrow('forwarded Remote event source is already registered')
    await unregisterReplacement()
    socket.close()
  })

  it('rejects a scoped dispatch yielded after its Remote event source is withdrawn', async () => {
    const { ctx } = await setup(false)
    const publish = Promise.withResolvers<undefined>()
    const agent = ctx.extend()
    const pending = pendingInvocation(agent)
    const source = (): AsyncIterable<TypertRemoteEventDispatch> => (async function* () {
      await publish.promise
      yield pending.dispatch
    })()
    const unregister = ctx.typertGateway.registerRemoteEvents(source, REMOTE_HOST)
    const rejected = expect(pending.outcome).rejects.toThrow(
      'forwarded Remote event source was removed',
    )

    publish.resolve(undefined)
    await unregister()

    await rejected
    expect(pending.reject).toHaveBeenCalledTimes(1)
    expect(pending.resolve).not.toHaveBeenCalled()
  })

  it('cancels a pending waterfall when its source rejects during removal', async () => {
    const { ctx } = await setup(true)
    const agent = ctx.extend()
    const pending = pendingInvocation(agent, undefined, 'ship', agentId('agent-removal'))
    const rejected = expect(pending.outcome).rejects.toThrow(
      'forwarded Remote event source was removed',
    )
    const unregister = ctx.typertGateway.registerRemoteEvents(signal => (async function* () {
      yield pending.dispatch
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      throw new Error('fixture source rejected during removal')
    })(), REMOTE_HOST)
    const client = await openEventClient(ctx, 'events-removal')
    await vi.waitFor(() => { expect(deliveredInvocation(client)).toBeDefined() })

    await unregister()
    await rejected
    expect(pending.reject).toHaveBeenCalledTimes(1)
    expect(pending.resolve).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(client.frames).toContainEqual({ type: 'end', streamId: client.streamId })
    })
    client.socket.close()
  })

  it('rejects malformed scoped invocations and delegates a released Context', async () => {
    const { ctx } = await setup(false)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)

    for (const event of [42, ''] as const) {
      const invalidName = pendingInvocation(ctx)
      const rejected = expect(invalidName.outcome).rejects.toThrow(
        'Remote event name must be a nonempty string',
      )
      source.push({
        ...invalidName.dispatch,
        event: event as unknown as string,
      })
      await rejected
    }

    let selected = ctx.extend()
    const nonJsonIdentity = pendingInvocation(selected, undefined, 'ship', 1n)
    const nonJsonRejected = expect(nonJsonIdentity.outcome).rejects.toThrow(
      'require a non-empty Agent identity',
    )
    source.push(nonJsonIdentity.dispatch)
    await nonJsonRejected

    const invalidRequest = pendingInvocation(selected, undefined, 'ship', agentId('agent-invalid-request'))
    const invalidRequestRejected = expect(invalidRequest.outcome).rejects.toThrow(
      'must carry its scoped Agent directly',
    )
    source.push({
      ...invalidRequest.dispatch,
      request: {},
    })
    await invalidRequestRejected

    const staleFiber = ctx.plugin(() => {})
    await staleFiber
    selected = staleFiber.ctx
    await staleFiber.dispose()
    const stale = pendingInvocation(selected, undefined, 'ship', agentId('agent-stale'))
    source.push(stale.dispatch)
    await expect(stale.outcome).resolves.toEqual({ kind: 'next' })
    expect(stale.reject).not.toHaveBeenCalled()

    selected = ctx.extend()
    const abort = new AbortController()
    abort.abort('fixture non-error cancellation')
    const cancelled = pendingInvocation(selected, abort.signal, 'ship', agentId('agent-cancelled'))
    const cancelledOutcome = expect(cancelled.outcome).rejects.toMatchObject({
      message: 'typert gateway: Remote event was cancelled',
      cause: 'fixture non-error cancellation',
    })
    source.push(cancelled.dispatch)
    await cancelledOutcome

    await unregister()
  })

  it('rejects notification arguments that are not lossless JSON arrays', async () => {
    const { ctx } = await setup(false)
    const frames = [
      { event: 'fixture/changed', args: {} },
      { event: 'fixture/changed', args: [1n] },
    ]
    for (const frame of frames) {
      let sourceSignal: AbortSignal | undefined
      const unregister = ctx.typertGateway.registerRemoteEvents((signal) => {
        sourceSignal = signal
        return (async function* () {
          yield frame as unknown as TypertRemoteEventDispatch
        })()
      }, REMOTE_HOST)
      await vi.waitFor(() => { expect(sourceSignal?.aborted).toBe(true) })
      const reason: unknown = sourceSignal?.reason
      if (!(reason instanceof Error)) throw new Error('Remote event source did not fail with an Error')
      expect(reason.message).toContain('arguments are not lossless JSON data')
      await unregister()
    }
  })

  it('retries a colliding Remote event id before publishing the second waterfall', async () => {
    const { ctx } = await setup(false)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const agent = ctx.extend()
    const firstId = '00000000-0000-4000-8000-000000000001' as ReturnType<typeof randomUUID>
    const secondId = '00000000-0000-4000-8000-000000000002' as ReturnType<typeof randomUUID>
    randomUuid.mockReturnValueOnce(firstId).mockReturnValueOnce(firstId).mockReturnValueOnce(secondId)
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = pendingInvocation(agent, firstAbort.signal, 'first', agentId('agent-collision'))
    const second = pendingInvocation(agent, secondAbort.signal, 'second', agentId('agent-collision'))

    source.push(first.dispatch)
    await vi.waitFor(() => { expect(randomUuid).toHaveBeenCalledTimes(1) })
    source.push(second.dispatch)
    await vi.waitFor(() => { expect(randomUuid).toHaveBeenCalledTimes(3) })

    const firstReason = new Error('cancel first collision fixture')
    const secondReason = new Error('cancel second collision fixture')
    const firstRejected = expect(first.outcome).rejects.toBe(firstReason)
    const secondRejected = expect(second.outcome).rejects.toBe(secondReason)
    firstAbort.abort(firstReason)
    secondAbort.abort(secondReason)
    await firstRejected
    await secondRejected
    await unregister()
  })

  it('retries a colliding Remote event Client id before opening the second generation', async () => {
    const { ctx } = await setup(true)
    // Connection minted the operator Peer id above; only the event Client ids are counted below.
    randomUuid.mockClear()
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const firstId = '00000000-0000-4000-8000-000000000011' as ReturnType<typeof randomUUID>
    const secondId = '00000000-0000-4000-8000-000000000012' as ReturnType<typeof randomUUID>
    randomUuid.mockReturnValueOnce(firstId).mockReturnValueOnce(firstId).mockReturnValueOnce(secondId)

    const first = await openEventClient(ctx, 'events-client-id-a')
    const second = await openEventClient(ctx, 'events-client-id-b')

    expect(first.clientId).toBe(firstId)
    expect(second.clientId).toBe(secondId)
    expect(randomUuid).toHaveBeenCalledTimes(3)
    first.socket.close()
    second.socket.close()
    await unregister()
  })

  it('fans one scoped waterfall out and accepts the first Client result', async () => {
    const { ctx } = await setup(true)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const agent = ctx.extend()
    const first = await openEventClient(ctx, 'events-a')
    const second = await openEventClient(ctx, 'events-b')
    const pending = pendingInvocation(agent)
    source.push(pending.dispatch)

    await vi.waitFor(() => {
      expect(deliveredInvocation(first)).toBeDefined()
      expect(deliveredInvocation(second)).toBeDefined()
    })
    const firstFrame = deliveredInvocation(first)!
    const secondFrame = deliveredInvocation(second)!
    expect(firstFrame.eventId).toBe(secondFrame.eventId)
    expect(firstFrame).toMatchObject({
      type: 'waterfall',
      event: 'fixture/approval',
      agentId: 'agent-1',
      request: { prompt: 'ship' },
    })
    expect(firstFrame).not.toHaveProperty('deliveryId')
    expect(secondFrame).not.toHaveProperty('deliveryId')

    await sendEventResult(second, secondFrame, {
      kind: 'result', value: 'allowed',
    })
    await expect(pending.outcome).resolves.toEqual({ kind: 'result', value: 'allowed' })
    await vi.waitFor(() => {
      expect(first.frames).toContainEqual({
        type: 'item',
        streamId: first.streamId,
        value: { type: 'cancel', eventId: firstFrame.eventId },
      })
    })

    await sendEventResult(first, firstFrame, {
      kind: 'result', value: 'rejected',
    })
    expect(pending.resolve).toHaveBeenCalledTimes(1)
    expect(pending.reject).not.toHaveBeenCalled()
    first.socket.close()
    second.socket.close()
    await unregister()
  })

  it('rejects the Host waterfall with the first Client listener rejection', async () => {
    const { ctx } = await setup(true)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const agent = ctx.extend()
    const client = await openEventClient(ctx, 'events-rejected')
    const pending = pendingInvocation(agent, undefined, 'ship', agentId('agent-rejected'))
    source.push(pending.dispatch)
    await vi.waitFor(() => { expect(deliveredInvocation(client)).toBeDefined() })
    const frame = deliveredInvocation(client)!
    const rejected = expect(pending.outcome).rejects.toMatchObject({
      name: 'UserQuestionError',
      message: 'the user cancelled ask_user_question',
      code: 'ASK_CANCELLED',
      details: { questionId: 'question-1' },
    })

    await sendEventResult(client, frame, {
      kind: 'rejected',
      error: {
        name: 'UserQuestionError',
        message: 'the user cancelled ask_user_question',
        code: 'ASK_CANCELLED',
        details: { questionId: 'question-1' },
      },
    })
    await rejected
    expect(pending.reject).toHaveBeenCalledTimes(1)
    expect(pending.resolve).not.toHaveBeenCalled()

    client.socket.close()
    await unregister()
  })

  it('delegates to the Host only after every active Client returns next', async () => {
    const { ctx } = await setup(true)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const agent = ctx.extend()
    const first = await openEventClient(ctx, 'events-next-a')
    const second = await openEventClient(ctx, 'events-next-b')
    const pending = pendingInvocation(agent)
    source.push(pending.dispatch)
    await vi.waitFor(() => {
      expect(deliveredInvocation(first)).toBeDefined()
      expect(deliveredInvocation(second)).toBeDefined()
    })
    const firstFrame = deliveredInvocation(first)!
    const secondFrame = deliveredInvocation(second)!

    await sendEventResult(first, firstFrame, { kind: 'next' })
    expect(pending.resolve).not.toHaveBeenCalled()
    await sendEventResult(second, secondFrame, { kind: 'next' })
    await expect(pending.outcome).resolves.toEqual({ kind: 'next' })
    expect(pending.resolve).toHaveBeenCalledTimes(1)
    expect(pending.reject).not.toHaveBeenCalled()
    first.socket.close()
    second.socket.close()
    await unregister()
  })

  it('delivers a pending waterfall to the first Client that connects', async () => {
    const { ctx } = await setup(true)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const agent = ctx.extend()
    const pending = pendingInvocation(agent, undefined, 'before-connect', agentId('agent-late-client'))

    source.push(pending.dispatch)
    await vi.waitFor(() => { expect(randomUuid).toHaveBeenCalledTimes(1) })

    const client = await openEventClient(ctx, 'events-first-client')
    await vi.waitFor(() => { expect(deliveredInvocation(client)).toBeDefined() })
    const frame = deliveredInvocation(client)!
    expect(frame).toMatchObject({
      type: 'waterfall',
      event: 'fixture/approval',
      agentId: 'agent-late-client',
      request: { prompt: 'before-connect' },
    })

    await sendEventResult(client, frame, { kind: 'result', value: 'allowed' })
    await expect(pending.outcome).resolves.toEqual({ kind: 'result', value: 'allowed' })

    client.socket.close()
    await unregister()
  })

  it('replays a pending event id to a replacement Client generation', async () => {
    const { ctx } = await setup(true)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const agent = ctx.extend()
    const original = await openEventClient(ctx, 'events-original')
    const pending = pendingInvocation(agent)
    source.push(pending.dispatch)
    await vi.waitFor(() => { expect(deliveredInvocation(original)).toBeDefined() })
    const originalFrame = deliveredInvocation(original)!
    const closed = once(original.socket, 'close')
    original.socket.close()
    await closed

    const replacement = await openEventClient(ctx, 'events-replacement')
    await vi.waitFor(() => { expect(deliveredInvocation(replacement)).toBeDefined() })
    const replayed = deliveredInvocation(replacement)!
    expect(replayed.eventId).toBe(originalFrame.eventId)
    expect(replayed).not.toHaveProperty('deliveryId')
    await sendEventResult(replacement, replayed, {
      kind: 'result', value: 'allowed',
    })
    await expect(pending.outcome).resolves.toEqual({ kind: 'result', value: 'allowed' })

    replacement.socket.close()
    await unregister()
  })

  it('cancels pending deliveries when the Host signal or Context ends', async () => {
    const { ctx } = await setup(true)
    const source = new RemoteEventSourceProbe()
    const unregister = ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
    const signalAgent = ctx.extend()
    const contextFiber = ctx.plugin(() => {})
    await contextFiber
    const contextAgent = contextFiber.ctx
    const client = await openEventClient(ctx, 'events-cancel')

    const abort = new AbortController()
    const signalPending = pendingInvocation(signalAgent, abort.signal, 'signal', agentId('agent-signal'))
    source.push(signalPending.dispatch)
    await vi.waitFor(() => { expect(deliveredInvocation(client)).toBeDefined() })
    const signalFrame = deliveredInvocation(client)!
    expect(signalFrame).toMatchObject({
      type: 'waterfall',
      agentId: 'agent-signal',
      request: { prompt: 'signal' },
    })
    const signalReason = new Error('Host caller cancelled')
    const signalOutcome = expect(signalPending.outcome).rejects.toBe(signalReason)
    abort.abort(signalReason)
    await signalOutcome
    await vi.waitFor(() => {
      expect(client.frames).toContainEqual({
        type: 'item',
        streamId: client.streamId,
        value: { type: 'cancel', eventId: signalFrame.eventId },
      })
    })

    const contextPending = pendingInvocation(contextAgent, undefined, 'context', agentId('agent-context'))
    source.push(contextPending.dispatch)
    let contextFrame: RemoteEventInvocationFrame | undefined
    await vi.waitFor(() => {
      contextFrame = client.frames
        .filter(frame => frame.type === 'item' && frame.streamId === client.streamId)
        .map(frame => frame.value)
        .find(value => typeof value === 'object'
          && value !== null
          && Reflect.get(value, 'event') === 'fixture/approval'
          && Reflect.get(value, 'eventId') !== signalFrame.eventId) as RemoteEventInvocationFrame | undefined
      expect(contextFrame).toBeDefined()
    })
    const contextOutcome = expect(contextPending.outcome).rejects.toThrow('Agent Context was released')
    await contextFiber.dispose()
    await contextOutcome
    await vi.waitFor(() => {
      expect(client.frames).toContainEqual({
        type: 'item',
        streamId: client.streamId,
        value: { type: 'cancel', eventId: contextFrame!.eventId },
      })
    })

    client.socket.close()
    await unregister()
  })

  it('validates the internal Remote event request and reports an absent source', async () => {
    const { ctx } = await setup(true)
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
      headers: { cookie: browserCookie(ctx) },
    })
    await once(socket, 'open')
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })

    sendOpen(socket, 'missing', '$events', {})
    await vi.waitFor(() => {
      expect(frames.find(frame => frame.streamId === 'missing')?.type).toBe('error')
      expect(streamErrorMessage(frames, 'missing')).toContain('source is unavailable')
    })

    let sourceCalls = 0
    const unregister = ctx.typertGateway.registerRemoteEvents(() => {
      sourceCalls += 1
      return (async function *(): AsyncIterable<never> {})()
    }, REMOTE_HOST)
    const invalidPayloads: readonly unknown[] = [
      null,
      [],
      {},
      { other: {} },
      { args: null },
      { args: [] },
      { args: { extra: true } },
    ]
    invalidPayloads.forEach((payload, index) => {
      socket.send(JSON.stringify({
        type: 'open', streamId: `invalid-${String(index)}`, endpoint: '$events', payload,
      }))
    })
    await vi.waitFor(() => {
      expect(frames.filter(frame => String(frame.streamId).startsWith('invalid-'))).toHaveLength(invalidPayloads.length)
    })
    for (const [index] of invalidPayloads.entries()) {
      const streamId = `invalid-${String(index)}`
      expect(frames.find(frame => frame.streamId === streamId)?.type).toBe('error')
      expect(streamErrorMessage(frames, streamId)).toContain('requires an empty args object')
    }
    expect(sourceCalls).toBe(1)

    await unregister()
    socket.close()
  })

  it('applies Connection trusted-host policy before accepting the Gateway socket', async () => {
    const { ctx } = await setup(true)
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`,
      { headers: { host: 'untrusted.example' } },
    )
    socket.on('error', () => {})
    const responseEvent: unknown[] = await once(socket, 'unexpected-response')
    const request = responseEvent[0]
    const response = responseEvent[1]
    const rejected = response as { statusCode?: number; resume(): void }
    expect(rejected.statusCode).toBe(403)
    rejected.resume()
    ;(request as { abort(): void }).abort()
  })

  it('answers an unauthenticated trusted Host with 401 before opening a stream', async () => {
    const { ctx } = await setup(true)
    const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`)
    socket.on('error', () => {})
    const responseEvent: unknown[] = await once(socket, 'unexpected-response')
    const request = responseEvent[0]
    const response = responseEvent[1]
    const rejected = response as { statusCode?: number; resume(): void }
    expect(rejected.statusCode).toBe(401)
    rejected.resume()
    ;(request as { abort(): void }).abort()
  })
})

async function setup(
  transport: boolean,
  gatewayConfig: GatewayConfig = {},
  ready?: AppReady,
): Promise<{ readonly ctx: Context; readonly service: FeedService }> {
  const ctx = new Context()
  roots.push(ctx)
  if (ready !== undefined) ctx.provide('appReady', ready)
  if (transport) {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
  }
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, gatewayConfig)
  if (transport) {
    await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  }
  await ctx.plugin(FeedService)
  ctx.typert.register({
    package: '@fixture/feed',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: descriptors(),
  })
  const receiver = ctx.get('feed') as unknown as FeedService & { [symbols.original]?: FeedService }
  return { ctx, service: receiver[symbols.original] ?? receiver }
}

async function acceptsSocket(ctx: Context): Promise<boolean> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
    headers: { cookie: browserCookie(ctx) },
  })
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  const opened = await once(socket, 'open').then(() => true, () => false)
  if (opened) socket.close()
  await closed
  return opened
}

function descriptors(): InvocationDescriptor[] {
  const label = {
    name: 'label',
    wire: 'label',
    source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: '@fixture/feed#Label', create: () => z.string() },
  }
  const prefix = { ...label, name: 'prefix', wire: 'prefix' }
  const stream = (method: string, parameters: InvocationDescriptor['parameters'], schema: z.ZodType): InvocationDescriptor => ({
    id: `@fixture/feed#feed/${method}`,
    service: 'feed',
    namespace: 'feed',
    method,
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'strict', typeSymbol: '@fixture/feed#Item', create: () => schema },
  })
  const withUplink = (method: string, parameters: InvocationDescriptor['parameters'], cancellable = true): InvocationDescriptor => ({
    ...stream(method, parameters, z.string()),
    uplink: { codec: { mode: 'strict', typeSymbol: '@fixture/feed#Item', create: () => z.string() } },
    ...(cancellable ? { cancellation: { parameter: 'signal' } } : {}),
  })
  return [
    withUplink('echo', [prefix]),
    withUplink('swallow', []),
    withUplink('ignore', [prefix], false),
    withUplink('hold', []),
    withUplink('peek', []),
    withUplink('drain', [], false),
    withUplink('rereads', [], false),
    stream('context', [label], z.string()),
    { ...stream('follow', [label], z.string()), cancellation: { parameter: 'signal' } },
    stream('sync', [label], z.string()),
    stream('items', [], z.string()),
    stream('invalid', [], z.string()),
    stream('nonJson', [], z.unknown()),
    stream('missing', [], z.string()),
    { ...stream('abortBeforeOpen', [], z.string()), cancellation: { parameter: 'signal' } },
    stream('reject', [], z.string()),
    stream('rejectWithNonJsonDetails', [], z.string()),
    {
      id: '@fixture/feed#feed/unary',
      service: 'feed',
      namespace: 'feed',
      method: 'unary',
      invocation: { kind: 'direct' },
      parameters: [label],
      result: { mode: 'strict', typeSymbol: '@fixture/feed#Item', create: () => z.string() },
    },
    {
      id: '@fixture/feed#feed/unaryUplink',
      service: 'feed',
      namespace: 'feed',
      method: 'unaryUplink',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: '@fixture/feed#Items', create: () => z.array(z.string()) },
    },
  ]
}

interface RemoteEventTestClient {
  readonly socket: WebSocket
  readonly frames: Record<string, unknown>[]
  readonly streamId: string
  readonly clientId: RemoteEventClientId
  readonly origin: string
  readonly cookie: string
}

async function openEventClient(ctx: Context, streamId: string): Promise<RemoteEventTestClient> {
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const cookie = browserCookie(ctx)
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, {
    headers: { cookie },
  })
  await once(socket, 'open')
  const frames: Record<string, unknown>[] = []
  socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })
  sendOpen(socket, streamId, '$events', {})
  let clientId: RemoteEventClientId | undefined
  await vi.waitFor(() => {
    const ready = frames.find(frame => frame.type === 'item'
      && frame.streamId === streamId
      && typeof frame.value === 'object'
      && frame.value !== null
      && Reflect.get(frame.value, 'type') === 'ready')
    const candidate: unknown = ready === undefined ? undefined : Reflect.get(ready.value as object, 'clientId')
    expect(typeof candidate).toBe('string')
    if (typeof candidate === 'string') clientId = candidate as RemoteEventClientId
  })
  if (clientId === undefined) throw new Error('Remote event stream omitted its Client id')
  return { socket, frames, streamId, clientId, origin, cookie }
}

function deliveredInvocation(client: RemoteEventTestClient): RemoteEventInvocationFrame | undefined {
  for (const frame of client.frames) {
    if (frame.type !== 'item' || frame.streamId !== client.streamId) continue
    const value = frame.value
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'eventId')) continue
    return value as RemoteEventInvocationFrame
  }
  return undefined
}

async function sendEventResult(
  client: RemoteEventTestClient,
  frame: RemoteEventInvocationFrame,
  outcome:
    | { readonly kind: 'next' }
    | { readonly kind: 'result'; readonly value?: unknown }
    | {
      readonly kind: 'rejected'
      readonly error: {
        readonly name: string
        readonly message: string
        readonly code?: string
        readonly details?: unknown
      }
    },
): Promise<void> {
  const rpcId = `remote-event-result-${client.streamId}`
  const response = await fetch(`${client.origin}/api/$events/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: '$events/result',
      payload: {
        args: { clientId: client.clientId, eventId: frame.eventId, outcome },
      },
    }),
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { readonly result?: { readonly ok?: boolean; readonly error?: { message?: string } } }
  if (body.result?.ok !== true) {
    throw new Error(body.result?.error?.message ?? 'Remote event result failed')
  }
}

function sendOpen(socket: WebSocket, streamId: string, endpoint: string, args: object): void {
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function streamErrorMessage(frames: readonly Record<string, unknown>[], streamId: string): string | undefined {
  const error = frames.find(frame => frame.streamId === streamId)?.error
  if (typeof error !== 'object' || error === null) return undefined
  const message: unknown = Reflect.get(error, 'message')
  return typeof message === 'string' ? message : undefined
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of source) values.push(value)
  return values
}

async function *toAsync<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) yield value
}

function neverYielding(): AsyncIterable<string> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => {}) }) }
}

function abortOf(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}
