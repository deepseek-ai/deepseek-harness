import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  bindTypertRemote,
  Remote,
  type InvocationDescriptor,
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
import { provideBrowserCredentials } from './browser-credentials.ts'
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
const browserCookies = new WeakMap<Context, string>()
const REMOTE_HOST = { home: '/home/fixture' } as const
type AgentWireId = TypertContextWire<TypertContextMap['agent']>
const agentId = (value: string): AgentWireId => value as AgentWireId

/** Exchange this test Host's process token for its WebSocket/HTTP Cookie header. */
function browserCookie(ctx: Context): string {
  const existing = browserCookies.get(ctx)
  if (existing !== undefined) return existing
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const target = new URL(ctx.connection.authenticatedUrl(origin))
  let setCookie: string | undefined
  ctx.connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host: target.host },
  }, {
    writeHead(_status, headers) { setCookie = headers?.['set-cookie'] },
    end() {},
  })
  if (setCookie === undefined) throw new Error('gateway stream fixture did not receive a browser cookie')
  const cookie = setCookie.split(';', 1)[0]!
  browserCookies.set(ctx, cookie)
  return cookie
}

class FeedService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'feed')
  readonly signals: AbortSignal[] = []
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

  unary(label: string): string {
    return label
  }
}

const roots: Context[] = []

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
  it('validates the WebSocket heartbeat timer range', () => {
    expect(TypertGatewayService.Config({})).toEqual({ websocketHeartbeatIntervalMs: 2_000 })
    expect(TypertGatewayService.Config({ websocketHeartbeatIntervalMs: MAX_TIMER_DELAY_MS }))
      .toEqual({ websocketHeartbeatIntervalMs: MAX_TIMER_DELAY_MS })
    for (const websocketHeartbeatIntervalMs of [0, 1.5, MAX_TIMER_DELAY_MS + 1]) {
      expect(() => TypertGatewayService.Config({ websocketHeartbeatIntervalMs })).toThrow()
    }
  })

  it('opens decoded carrier payloads through the in-process wire adapter', async () => {
    const { ctx } = await setup(false)
    const source = await ctx.typertGateway.wireStream.open(
      'feed/sync',
      { args: { label: 'wire' } },
      new AbortController().signal,
    )

    await expect(collect(source)).resolves.toEqual(['wire:one', 'wire:two'])
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
): Promise<{ readonly ctx: Context; readonly service: FeedService }> {
  const ctx = new Context()
  roots.push(ctx)
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

function descriptors(): InvocationDescriptor[] {
  const label = {
    name: 'label',
    wire: 'label',
    source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: '@fixture/feed#Label', schema: z.string() },
  }
  const stream = (method: string, parameters: InvocationDescriptor['parameters'], schema: z.ZodType): InvocationDescriptor => ({
    id: `@fixture/feed#feed/${method}`,
    service: 'feed',
    namespace: 'feed',
    method,
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'strict', typeSymbol: '@fixture/feed#Item', schema },
  })
  return [
    { ...stream('follow', [label], z.string()), cancellation: { parameter: 'signal' } },
    stream('sync', [label], z.string()),
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
      result: { mode: 'strict', typeSymbol: '@fixture/feed#Item', schema: z.string() },
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
  const message = Reflect.get(error, 'message') as unknown
  return typeof message === 'string' ? message : undefined
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of source) values.push(value)
  return values
}
