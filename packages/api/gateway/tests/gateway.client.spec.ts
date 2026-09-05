import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import {
  apply as applyConnection,
  type ConnectionGeneration,
  type ConnectionGenerationSource,
  type ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertContextMap,
  TypertContextWire,
  TypertContext,
  TypertLookup,
  TypertRemoteScopeApi,
  TypertRemoteNamespace,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ClientRemote } from '../src/client/index.ts'
import { apply, inject, RemoteStream } from '../src/client/index.ts'
import {
  RemoteStreamCarrierError,
  RemoteStreamMuxClient,
} from '../src/client/stream-client.ts'

type FixtureApprovalOutcome = 'allowed' | 'unavailable'
const fixtureContextTag = Symbol('fixture-context-tag')
type AgentWireId = TypertContextWire<TypertContextMap['agent']>
const agentId = (value: string): AgentWireId => value as AgentWireId

interface FixtureAgent {
  readonly agentId: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only forwarded Host event.
     * @param namespace - marker payload recorded by listeners.
     */
    'fixture/changed'(namespace: string): void
    /**
     * Test-only forwarded Host event nobody subscribes to.
     * @param count - marker payload never observed.
     */
    'fixture/idle'(count: number): void
    /**
     * Test-only scoped waterfall forwarded through the existing Remote Event stream.
     * @param request - JSON-safe request payload.
     * @param next - delegates to the next Client listener or Host waterfall.
     * @returns the claimed or delegated outcome.
     */
    'fixture/approval'(
      this: Context,
      request: {
        readonly prompt: string
        readonly agent: FixtureAgent
        readonly signal?: AbortSignal
      },
      next: () => Promise<FixtureApprovalOutcome>,
    ): Promise<FixtureApprovalOutcome>
    /**
     * Test-only event the Host assembly does not forward.
     * @param flag - marker payload never delivered.
     */
    'fixture/unselected'(flag: boolean): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteEventSelection extends
    Record<'fixture/changed' | 'fixture/idle' | 'fixture/approval', true> {}

  interface TypertContextMap {
    fixture: TypertContext<string>
  }

  interface TypertLookupMap {
    fixture: TypertLookup<FixtureAgent, string>
  }

  interface TypertRemoteMap {
    'probe/create': (
      agentId: string,
      request: { readonly objective: string },
      signal?: AbortSignal,
    ) => Promise<RemoteResult<{ readonly ref: string }>>
    'probe/maybe': (value: string | null | undefined) => Promise<RemoteResult<string | null | undefined>>
    'probe/watch': (topic: string, signal?: AbortSignal) => AsyncIterable<string>
  }

  interface TypertRemoteScopeMap {
    'fixture:probe/create': (
      request: { readonly objective: string },
      signal?: AbortSignal,
    ) => Promise<RemoteResult<{ readonly ref: string }>>
    'fixture:probe/rename': (
      request: { readonly objective: string },
    ) => Promise<RemoteResult<{ readonly renamed: boolean }>>
  }

  interface TypertRemoteNamespaceMap {
    probe: TypertRemoteNamespace<'probe'>
  }

}

type FixtureContext = Omit<Context, 'remote'> & {
  readonly remote: ClientRemote & TypertRemoteScopeApi<'fixture'>
}

// Compile-time contract of `$on`: the key face is the forwarding selection and
// the listener signature is the owning package's own Cordis declaration.
function remoteEventContracts(remote: ClientRemote): void {
  remote.$on('fixture/changed', (namespace) => { void namespace })
  remote.$on('fixture/approval', async function (request, next) {
    expectTypeOf(this).toEqualTypeOf<Context>()
    expectTypeOf(request.agent).toEqualTypeOf<Context>()
    expectTypeOf(request.signal).toEqualTypeOf<AbortSignal | undefined>()
    return request.prompt === '' ? next() : 'allowed'
  })
  // @ts-expect-error -- declared in Events but outside the forwarding selection.
  remote.$on('fixture/unselected', () => {})
  // @ts-expect-error -- not declared in Events at all.
  remote.$on('fixture/absent', () => {})
  // @ts-expect-error -- the listener signature comes from the event declaration.
  remote.$on('fixture/changed', (count: number) => { void count })
}
void remoteEventContracts

const idSchema = z.string().min(1)
const requestSchema = z.object({ objective: z.string().min(1) })
const createResultSchema = z.object({ ref: z.string().min(1) })
const renameResultSchema = z.object({ renamed: z.boolean() })

function directDescriptor(): InvocationDescriptor {
  return {
    id: '@fixture/probe#probe/create',
    service: 'probe',
    namespace: 'probe',
    method: 'create',
    invocation: { kind: 'direct' },
    scope: { context: 'fixture', wire: 'agentId' },
    parameters: [{
      name: 'agent',
      wire: 'agentId',
      source: 'lookup',
      lookup: 'fixture',
      codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', schema: idSchema },
    }, {
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#CreateRequest', schema: requestSchema },
    }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@fixture#CreateResult', schema: createResultSchema },
  }
}

function contextDescriptor(): InvocationDescriptor {
  return {
    id: '@fixture/probe#probe/rename',
    service: 'probe',
    namespace: 'probe',
    method: 'rename',
    invocation: {
      kind: 'context',
      context: 'fixture',
      wire: 'agentId',
      codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', schema: idSchema },
    },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#RenameRequest', schema: requestSchema },
    }],
    result: { mode: 'strict', typeSymbol: '@fixture#RenameResult', schema: renameResultSchema },
  }
}

function maybeDescriptor(): InvocationDescriptor {
  const schema = z.union([z.string(), z.null(), z.undefined()])
  return {
    id: '@fixture/probe#probe/maybe',
    service: 'probe',
    namespace: 'probe',
    method: 'maybe',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'value',
      wire: 'value',
      source: 'json',
      acceptsUndefined: true,
      codec: { mode: 'strict', typeSymbol: '@fixture#MaybeValue', schema },
    }],
    result: { mode: 'strict', typeSymbol: '@fixture#MaybeValue', schema },
  }
}

function streamDescriptor(): InvocationDescriptor {
  return {
    id: '@fixture/probe#probe/watch',
    service: 'probe',
    namespace: 'probe',
    method: 'watch',
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'topic',
      wire: 'topic',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: '@fixture#Topic', schema: z.string().min(1) },
    }],
    cancellation: { parameter: 'signal' },
    result: { mode: 'strict', typeSymbol: '@fixture#WatchItem', schema: z.string().min(1) },
  }
}

type WebSocketGlobal = { WebSocket?: typeof WebSocket }

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly sockets: FakeWebSocket[] = []
  static autoOpen = true
  static dispatchClose = true

  readonly url: string
  readonly sent: string[] = []
  readonly closedWith: { readonly code?: number; readonly reason?: string }[] = []
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    FakeWebSocket.sockets.push(this)
    queueMicrotask(() => {
      if (FakeWebSocket.autoOpen) this.open()
    })
  }

  open(): void {
    if (this.readyState !== FakeWebSocket.CONNECTING) return
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  fail(): void {
    this.dispatchEvent(new Event('error'))
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('fixture socket is not open')
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closedWith.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    })
    if (this.readyState === FakeWebSocket.CLOSED) return
    if (!FakeWebSocket.dispatchClose) {
      this.readyState = FakeWebSocket.CLOSING
      return
    }
    this.drop()
  }

  drop(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(value: unknown): void {
    this.receiveRaw(typeof value === 'string' ? value : JSON.stringify(value))
  }

  receiveRaw(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', {
      data,
    }))
  }
}

async function bench(
  call: ConnectionHandle['rpc']['call'],
  carrier: 'in-process' | 'web' = 'in-process',
): Promise<Context> {
  const { ctx } = await benchFiber(call, carrier)
  return ctx
}

async function benchFiber(
  call: ConnectionHandle['rpc']['call'],
  carrier: 'in-process' | 'web' = 'in-process',
  open: NonNullable<ConnectionHandle['rpc']['open']> = () => unexpectedInProcessStream(),
): Promise<{
  readonly ctx: Context
  readonly client: Fiber
  readonly generation: GenerationHarness
  readonly start: ReturnType<typeof vi.fn<ConnectionHandle['start']>>
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const rpc = carrier === 'web'
    ? { call }
    : { call, open }
  const generation = new GenerationHarness()
  const start = vi.fn<ConnectionHandle['start']>(() => ({ stop: () => {} }))
  ctx.provide('connection', {
    rpc,
    registerGenerationSource: generation.register,
    start,
  } as unknown as ConnectionHandle)
  const client = ctx.plugin({ inject, apply })
  await client
  return { ctx, client, generation, start }
}

async function *unexpectedInProcessStream(): AsyncGenerator<never> {
  throw new Error('fixture did not install an in-process stream')
}

interface GenerationRun {
  readonly signal: AbortSignal
  readonly ready: Promise<void>
  readonly done: Promise<void>
  abort(reason?: unknown): void
}

class GenerationHarness {
  private source: ConnectionGenerationSource | undefined
  private active: AbortController | undefined

  readonly register = (source: ConnectionGenerationSource): (() => void) => {
    if (this.source !== undefined) throw new Error('fixture generation source already registered')
    this.source = source
    return () => {
      if (this.source !== source) return
      this.source = undefined
      this.active?.abort(new Error('fixture generation source removed'))
      this.active = undefined
    }
  }

  start(): GenerationRun {
    if (this.source === undefined) throw new Error('fixture generation source is not registered')
    if (this.active !== undefined) throw new Error('fixture generation is already active')
    const source = this.source
    const controller = new AbortController()
    this.active = controller
    let reportReady!: () => void
    const ready = new Promise<void>((resolve) => { reportReady = resolve })
    const done = Promise.resolve()
      .then(() => source(controller.signal, reportReady))
      .finally(() => {
        if (this.active === controller) this.active = undefined
      })
    void done.catch(() => undefined)
    return {
      signal: controller.signal,
      ready,
      done,
      abort: (reason) => { controller.abort(reason) },
    }
  }

  startOverlapping(): GenerationRun {
    if (this.source === undefined) throw new Error('fixture generation source is not registered')
    const controller = new AbortController()
    let reportReady!: () => void
    const ready = new Promise<void>((resolve) => { reportReady = resolve })
    const done = Promise.resolve().then(() => this.source?.(controller.signal, reportReady))
      .then(() => undefined)
    void done.catch(() => undefined)
    return {
      signal: controller.signal,
      ready,
      done,
      abort: (reason) => { controller.abort(reason) },
    }
  }
}

function deferredReadiness(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

async function loaderReadinessBench(
  readiness: Promise<unknown>,
  carrier: 'in-process' | 'web' = 'in-process',
): Promise<{
  readonly client: Fiber
  readonly start: ReturnType<typeof vi.fn<ConnectionHandle['start']>>
  readonly stop: ReturnType<typeof vi.fn<() => void>>
}> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const generation = new GenerationHarness()
  const stop = vi.fn<() => void>()
  const start = vi.fn<ConnectionHandle['start']>(() => ({ stop }))
  const call = vi.fn<ConnectionHandle['rpc']['call']>()
  ctx.provide('connection', {
    rpc: carrier === 'web' ? { call } : { call, open: () => unexpectedInProcessStream() },
    registerGenerationSource: generation.register,
    start,
  } as unknown as ConnectionHandle)
  ctx.provide('loader', { await: () => readiness })
  const client = ctx.plugin({ inject, apply })
  await client
  return { client, start, stop }
}

type EventStreamItem =
  | { readonly kind: 'frame'; readonly value: unknown }
  | { readonly kind: 'end' }
  | { readonly kind: 'fail'; readonly error: unknown }

interface EventStreamConnection {
  readonly items: EventStreamItem[]
  wake: (() => void) | undefined
}

class RemoteEventCarrier {
  readonly calls: {
    readonly channel: string
    readonly endpoint: string
    readonly payload: unknown
    readonly signal: AbortSignal
  }[] = []
  private readonly connections = new Set<EventStreamConnection>()
  private nextClient = 1

  get activeConnections(): number {
    return this.connections.size
  }

  readonly open: NonNullable<ConnectionHandle['rpc']['open']> = (channel, endpoint, payload, signal) => {
    this.calls.push({ channel, endpoint, payload, signal })
    return this.iterate(signal)
  }

  emit(value: unknown): void {
    this.feed({ kind: 'frame', value })
  }

  end(): void {
    this.feed({ kind: 'end' })
  }

  fail(error: unknown): void {
    this.feed({ kind: 'fail', error })
  }

  private feed(item: EventStreamItem): void {
    for (const connection of this.connections) {
      connection.items.push(item)
      connection.wake?.()
    }
  }

  private async *iterate(signal: AbortSignal): AsyncGenerator {
    signal.throwIfAborted()
    const clientId = `event-client-${String(this.nextClient++)}`
    const connection: EventStreamConnection = { items: [], wake: undefined }
    this.connections.add(connection)
    const abort = (): void => { connection.wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      yield { type: 'ready', clientId, host: { home: '/home/fixture' } }
      while (!signal.aborted) {
        while (connection.items.length > 0) {
          const item = connection.items.shift() as EventStreamItem
          if (item.kind === 'end') return
          if (item.kind === 'fail') throw item.error
          yield item.value
        }
        if (signal.aborted) return
        await new Promise<void>((resolve) => { connection.wake = resolve })
        connection.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      this.connections.delete(connection)
    }
  }
}

async function eventBench(
  call: ConnectionHandle['rpc']['call'] = vi.fn<ConnectionHandle['rpc']['call']>()
    .mockResolvedValue({ ok: true, value: undefined }),
): Promise<{
  readonly ctx: Context
  readonly client: Fiber
  readonly carrier: RemoteEventCarrier
  readonly generation: GenerationHarness
  readonly run: GenerationRun
  readonly call: ConnectionHandle['rpc']['call']
}> {
  const carrier = new RemoteEventCarrier()
  const { ctx, client, generation } = await benchFiber(
    call,
    'in-process',
    carrier.open,
  )
  const run = generation.start()
  await run.ready
  return { ctx, client, carrier, generation, run, call }
}

function approvalFrame(eventId: string, agentId: string, prompt: string): object {
  return {
    type: 'waterfall',
    event: 'fixture/approval',
    eventId,
    agentId,
    request: { prompt },
  }
}

describe('Client Remote transport readiness', () => {
  it('creates logical stream supervisors against the installed Connection', async () => {
    const { ctx, client } = await benchFiber(vi.fn<ConnectionHandle['rpc']['call']>())
    const stream = ctx.remote.$stream({
      name: 'fixture stream',
      open: () => unexpectedInProcessStream(),
      ended: () => new Error('fixture stream ended'),
    })

    expect(stream).toBeInstanceOf(RemoteStream)
    await stream.dispose()
    await client.dispose()
  })

  it('reports Host facts as plain reads and keeps them through Connection withdrawal', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const generation = new GenerationHarness()
    const live: { snapshot: ConnectionGeneration | undefined } = { snapshot: undefined }
    const handle = {
      isLoopback: true,
      generation: { getSnapshot: () => live.snapshot, subscribe: () => () => {} },
      rpc: {
        call: vi.fn<ConnectionHandle['rpc']['call']>(),
        open: () => unexpectedInProcessStream(),
      },
      registerGenerationSource: generation.register,
      start: () => ({ stop: () => {} }),
    } as unknown as ConnectionHandle
    const withdraw = ctx.provide('connection', handle)
    const client = ctx.plugin({ inject, apply })
    await client
    const remote = ctx.remote

    const beforeReady = remote.$host
    expect(beforeReady).toEqual({ home: undefined, isLoopback: true })
    expect(remote.$host).toBe(beforeReady)

    live.snapshot = { id: 1, host: { home: '/hosts/primary' } }
    const afterReady = remote.$host
    expect(afterReady).toEqual({ home: '/hosts/primary', isLoopback: true })
    expect(afterReady).not.toBe(beforeReady)
    expect(remote.$host).toBe(afterReady)

    withdraw()
    expect(ctx.get('connection')).toBeUndefined()
    expect(remote.$host).toBe(afterReady)
  })

  it('forwards each connection retry to the browser WebSocket owner', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      FakeWebSocket.autoOpen = false
      const { client, start } = await benchFiber(
        vi.fn<ConnectionHandle['rpc']['call']>(),
        'web',
      )
      try {
        expect(FakeWebSocket.sockets).toHaveLength(1)
        start.mock.calls[0]![0].onReconnectRequested?.()
        await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
      } finally {
        await client.dispose()
      }
    })
  })

  it.each([false, true])('replaces a stalled carrier and restores events (socket opened: %s)', async (autoOpen) => {
    await withFakeWebSocket('https://harness.example', async () => {
      vi.useFakeTimers()
      vi.stubGlobal('__DSH_CONNECTION_RECOVERY__', {
        backoffBaseMs: 10, backoffMaxMs: 10, generationReadyTimeoutMs: 100,
      })
      Object.assign(globalThis.location, { hostname: 'harness.example', search: '' })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      FakeWebSocket.autoOpen = autoOpen
      const ctx = new Context()
      const reset = vi.fn()
      ctx.on('connection/reset', reset)
      try {
        await ctx.plugin(TypertRegistry)
        await ctx.plugin({ inject: [], apply: applyConnection })
        await ctx.plugin({ inject, apply })
        await vi.advanceTimersByTimeAsync(0)
        const connection = ctx.get('connection') as ConnectionHandle
        expect(FakeWebSocket.sockets).toHaveLength(1)
        expect(connection.generation.getSnapshot()).toBeUndefined()
        await vi.advanceTimersByTimeAsync(110)
        expect(FakeWebSocket.sockets).toHaveLength(2)
        expect(FakeWebSocket.sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED)
        expect(FakeWebSocket.sockets[0]?.closedWith).toHaveLength(1)
        expect(reset).not.toHaveBeenCalled()
        const replacement = FakeWebSocket.sockets[1]!
        replacement.open()
        await vi.advanceTimersByTimeAsync(0)
        const opening = JSON.parse(replacement.sent[0]!) as { streamId: string }
        replacement.receive({
          type: 'item', streamId: opening.streamId,
          value: { type: 'ready', clientId: 'recovered-client', host: { home: '/recovered' } },
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(connection.state.getSnapshot()).toBe('connected')
        expect(connection.generation.getSnapshot()?.host.home).toBe('/recovered')
        expect(reset).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        await ctx.fiber.dispose()
        await vi.advanceTimersByTimeAsync(0)
        warnSpy.mockRestore()
        vi.unstubAllGlobals()
        vi.useRealTimers()
      }
    })
  })

  it('does not replace an in-process carrier when Connection retries', async () => {
    const { client, start } = await benchFiber(
      vi.fn<ConnectionHandle['rpc']['call']>(),
      'in-process',
    )
    try {
      expect(() => { start.mock.calls[0]![0].onReconnectRequested?.() }).not.toThrow()
    } finally {
      await client.dispose()
    }
  })

  it('starts after Loader settlement and stops the owned loop on disposal', async () => {
    const readiness = deferredReadiness()
    const { client, start, stop } = await loaderReadinessBench(readiness.promise)
    expect(start).not.toHaveBeenCalled()

    readiness.resolve()
    await vi.waitFor(() => { expect(start).toHaveBeenCalledTimes(1) })

    await client.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh WebSocket attempt when Loader settles after the eager attempt failed', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      FakeWebSocket.autoOpen = false
      const readiness = deferredReadiness()
      const { client, start } = await loaderReadinessBench(readiness.promise, 'web')
      expect(FakeWebSocket.sockets).toHaveLength(1)
      FakeWebSocket.sockets[0]!.fail()
      readiness.resolve()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
      expect(start).toHaveBeenCalledOnce()
      await client.dispose()
    })
  })

  it('does not start when disposal wins the Loader-settlement race', async () => {
    const readiness = deferredReadiness()
    const { client, start, stop } = await loaderReadinessBench(readiness.promise)

    await client.dispose()
    readiness.resolve()
    await Promise.resolve()

    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('leaves the transport stopped when Loader settlement rejects', async () => {
    const readiness = deferredReadiness()
    const { client, start, stop } = await loaderReadinessBench(readiness.promise)

    readiness.reject(new Error('fixture Loader failed'))
    await Promise.resolve()
    await Promise.resolve()

    expect(start).not.toHaveBeenCalled()
    await client.dispose()
    expect(stop).not.toHaveBeenCalled()
  })
})

describe('Client Typert API', () => {
  it('mounts concrete direct methods, validates inputs, and withdraws retained handles', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-1' } })
    const ctx = await bench(call)
    const businessProbe = { owner: 'host business service' }
    const disposeBusinessProbe = ctx.provide('probe', businessProbe)
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => scope.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] }),
      { inject: ['remote'] },
    ))
    await assembly
    const retained = ctx.remote.probe.create

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' }))
      .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    expect(call).toHaveBeenCalledWith(
      '/api',
      'probe/create',
      { args: { agentId: 'agent-1', request: { objective: 'ship' } } },
      expect.any(AbortSignal),
    )
    const callerAbort = new AbortController()
    await expect(ctx.remote.probe.create(
      'agent-1',
      { objective: 'cancel me' },
      callerAbort.signal,
    )).resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    const combinedSignal = call.mock.calls.at(-1)?.[3]
    expect(combinedSignal).toBeInstanceOf(AbortSignal)
    expect(combinedSignal).not.toBe(callerAbort.signal)
    const cancellation = new Error('caller cancelled')
    callerAbort.abort(cancellation)
    expect(combinedSignal?.aborted).toBe(true)
    expect(combinedSignal?.reason).toBe(cancellation)
    await expect(ctx.remote.probe.create('', { objective: 'ship' })).rejects.toThrow('rejected "agentId"')

    call.mockResolvedValueOnce({ ok: true, value: { ref: 1 } })
    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).resolves.toEqual({
      ok: true,
      value: { ref: 1 },
    })

    await assembly.dispose()
    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    expect(ctx.get('remote.probe')).toBeUndefined()
    expect(ctx.get('probe')).toBe(businessProbe)
    expect(ctx.typert.remotes.list()).toEqual([])
    await expect(retained?.('agent-1', { objective: 'ship' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: Remote method probe/create is no longer mounted',
        details: {},
      },
    })
    disposeBusinessProbe()
  })

  it('encodes declared undefined as an omitted argument and distinguishes it from null results', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValueOnce({ ok: true, value: undefined })
      .mockResolvedValueOnce({ ok: true, value: null })
    const ctx = await bench(call)
    const dispose = await ctx.remote.$mount({
      package: '@fixture/maybe',
      descriptors: [maybeDescriptor()],
    })

    await expect(ctx.remote.probe.maybe(undefined)).resolves.toStrictEqual({ ok: true, value: undefined })
    expect(call).toHaveBeenNthCalledWith(
      1,
      '/api',
      'probe/maybe',
      { args: {} },
      expect.any(AbortSignal),
    )
    await expect(ctx.remote.probe.maybe(null)).resolves.toStrictEqual({ ok: true, value: null })
    expect(call).toHaveBeenNthCalledWith(
      2,
      '/api',
      'probe/maybe',
      { args: { value: null } },
      expect.any(AbortSignal),
    )

    await dispose()
  })

  it('projects one direct lookup descriptor onto an Agent-scoped alias', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-2' } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-2' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
      resolve: id => id === 'agent-2' ? agentCtx : undefined,
    })
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => scope.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] }),
      { inject: ['remote'] },
    ))
    await assembly

    await expect(agentCtx.remote.probe.create({ objective: 'ship scoped' }))
      .resolves.toEqual({ ok: true, value: { ref: 'goal-2' } })
    expect(call).toHaveBeenCalledWith(
      '/api',
      'probe/create',
      { args: { agentId: 'agent-2', request: { objective: 'ship scoped' } } },
      expect.any(AbortSignal),
    )
    await expect((ctx as FixtureContext).remote.probe.create({ objective: 'wrong scope' }))
      .rejects.toThrow('expected 2 business argument(s)')

    await assembly.dispose()
    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    expect(ctx.get('remote.probe')).toBeUndefined()
  })

  it('uses the caller Context identity for scoped namespace methods', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { renamed: true } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-2' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
      resolve: id => id === 'agent-2' ? agentCtx : undefined,
    })
    const assembly = ctx.plugin(Object.assign(
      (scope: Context) => scope.remote.$mount({ package: '@fixture/probe', descriptors: [contextDescriptor()] }),
      { inject: ['remote'] },
    ))
    await assembly

    await expect(agentCtx.remote.probe.rename({ objective: 'land' }))
      .resolves.toEqual({ ok: true, value: { renamed: true } })
    expect(call).toHaveBeenCalledWith(
      '/api',
      'probe/rename',
      { args: { agentId: 'agent-2', request: { objective: 'land' } } },
      expect.any(AbortSignal),
    )
    await expect((ctx as FixtureContext).remote.probe.rename({ objective: 'land' }))
      .rejects.toThrow('requires a "fixture" Context')

    await assembly.dispose()
    expect(ctx.get('remote.probe')).toBeUndefined()
  })

  it('accepts weak result codecs and rejects namespace collisions before registration', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const weak: InvocationDescriptor = {
      ...directDescriptor(),
      result: { mode: 'src-json' },
    }

    const disposeWeak = await ctx.remote.$mount({ package: '@fixture/weak', descriptors: [weak] })
    await disposeWeak()
    await expect(ctx.remote.$mount({
      package: '@fixture/conflict',
      descriptors: [{ ...directDescriptor(), namespace: '$mount' }],
    })).rejects.toThrow('conflicts with the Remote service')
    expect(ctx.typert.remotes.list()).toEqual([])
  })

  it('rejects duplicate, live, scoped-service, and Context namespace collisions', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { renamed: true } })
    const ctx = await bench(call)
    const agentCtx = ctx.extend({ fixtureId: 'agent-remounted' }) as FixtureContext
    ctx.typert.contexts.registerClient('fixture', {
      identity: candidate => (candidate as Context & { fixtureId?: string }).fixtureId,
      resolve: id => id === 'agent-remounted' ? agentCtx : undefined,
    })
    const direct = directDescriptor()
    const context = contextDescriptor()

    await expect(ctx.remote.$mount({
      package: '@fixture/direct-duplicates',
      descriptors: [direct, { ...direct, id: '@fixture/probe#probe/create-again' }],
    })).rejects.toThrow('repeats direct method')
    await expect(ctx.remote.$mount({
      package: '@fixture/scoped-duplicates',
      descriptors: [context, { ...context, id: '@fixture/probe#probe/rename-again' }],
    })).rejects.toThrow('repeats scoped method')

    const disposeDirect = await ctx.remote.$mount({ package: '@fixture/direct-live', descriptors: [direct] })
    await expect(ctx.remote.$mount({
      package: '@fixture/direct-conflict', descriptors: [{ ...direct, id: '@fixture/other#probe/create' }],
    })).rejects.toThrow('direct method probe/create is already mounted')
    await disposeDirect()

    const disposeScoped = await ctx.remote.$mount({ package: '@fixture/scoped-live', descriptors: [context] })
    await expect(ctx.remote.$mount({
      package: '@fixture/scoped-conflict', descriptors: [{ ...context, id: '@fixture/other#probe/rename' }],
    })).rejects.toThrow('scoped method probe/rename is already mounted')
    await expect(ctx.remote.$mount({
      package: '@fixture/service-method-conflict',
      descriptors: [{ ...context, id: '@fixture/probe#probe/remove', method: 'remove' }],
    })).rejects.toThrow('conflicts with its namespace service')
    const scopedService = ctx.get('remote.probe') as unknown as object
    Object.defineProperty(scopedService, 'custom', { configurable: true, value: () => undefined })
    await expect(ctx.remote.$mount({
      package: '@fixture/service-own-property-conflict',
      descriptors: [{ ...direct, id: '@fixture/probe#probe/custom', method: 'custom' }],
    })).rejects.toThrow('conflicts with its namespace service')
    Reflect.deleteProperty(scopedService, 'custom')
    await disposeScoped()

    const disposeRemoteTypert = ctx.reflect.provide('remote.typert', { owner: 'fixture' })
    await expect(ctx.remote.$mount({
      package: '@fixture/context-property-conflict',
      descriptors: [{ ...context, namespace: 'typert' }],
    })).rejects.toThrow('conflicts with an existing Remote namespace')
    await disposeRemoteTypert()

    const disposeMultipleScoped = await ctx.remote.$mount({
      package: '@fixture/multiple-scoped',
      descriptors: [directDescriptor(), contextDescriptor()],
    })
    await expect(agentCtx.remote.probe.rename({ objective: 'remounted' }))
      .resolves.toEqual({ ok: true, value: { renamed: true } })
    expect(call).toHaveBeenLastCalledWith(
      '/api',
      'probe/rename',
      { args: { agentId: 'agent-remounted', request: { objective: 'remounted' } } },
      expect.any(AbortSignal),
    )
    await disposeMultipleScoped()
  })

  it('rolls back earlier descriptors when a later descriptor fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const { scope: _scope, ...first } = directDescriptor()
    const second: InvocationDescriptor = {
      ...first,
      id: '@fixture/probe#probe/archive',
      method: 'archive',
    }
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'archive') throw new Error('fixture later-descriptor failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({ package: '@fixture/failing-batch', descriptors: [first, second] }))
        .rejects.toThrow('fixture later-descriptor failure')
    } finally {
      spy.mockRestore()
    }

    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    const retry = await ctx.remote.$mount({ package: '@fixture/retry-batch', descriptors: [first, second] })
    expect(ctx.remote.probe.create).toBeTypeOf('function')
    expect((ctx.remote.probe as unknown as Record<string, unknown>).archive).toBeTypeOf('function')
    await retry()
  })

  it('rolls back earlier namespaces when a later namespace fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const { scope: _scope, ...first } = directDescriptor()
    const second: InvocationDescriptor = {
      ...first,
      id: '@fixture/archive#archive/store',
      namespace: 'archive',
      method: 'store',
    }
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'store') throw new Error('fixture later-namespace failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({
        package: '@fixture/failing-namespaces',
        descriptors: [first, second],
      })).rejects.toThrow('fixture later-namespace failure')
    } finally {
      spy.mockRestore()
    }

    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    expect((ctx.remote as unknown as Record<string, unknown>).archive).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })

    const retry = await ctx.remote.$mount({
      package: '@fixture/retry-namespaces',
      descriptors: [first, second],
    })
    expect(ctx.remote.probe.create).toBeTypeOf('function')
    expect((ctx.remote as unknown as Record<string, Record<string, unknown>>).archive?.store).toBeTypeOf('function')
    await retry()
  })

  it('rolls back a direct projection when its scoped projection fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const disposeContext = await ctx.remote.$mount({
      package: '@fixture/context-anchor',
      descriptors: [contextDescriptor()],
    })
    const namespace = ctx.get('remote.probe') as unknown as {
      installScoped: (...args: unknown[]) => void
      readonly create?: unknown
    }
    const installScoped = vi.spyOn(namespace, 'installScoped').mockImplementation(() => {
      throw new Error('fixture scoped projection failure')
    })
    try {
      await expect(ctx.remote.$mount({
        package: '@fixture/direct-projection-failure',
        descriptors: [directDescriptor()],
      })).rejects.toThrow('fixture scoped projection failure')
    } finally {
      installScoped.mockRestore()
    }

    expect(namespace.create).toBeUndefined()
    await disposeContext()
  })

  it('unwinds an already-installed namespace when a later namespace fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const { scope: _scope, ...probe } = directDescriptor()
    const vault: InvocationDescriptor = {
      ...probe,
      id: '@fixture/vault#vault/seal',
      service: 'vault',
      namespace: 'vault',
      method: 'seal',
    }
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'seal') throw new Error('fixture later-namespace failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({ package: '@fixture/two-namespaces', descriptors: [probe, vault] }))
        .rejects.toThrow('fixture later-namespace failure')
    } finally {
      spy.mockRestore()
    }

    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    expect((ctx.remote as unknown as Record<string, unknown>).vault).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
  })

  it('rolls back an earlier scoped projection when a later descriptor fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const { scope: _scope, ...direct } = directDescriptor()
    const failing: InvocationDescriptor = {
      ...direct,
      id: '@fixture/probe#probe/archive',
      method: 'archive',
    }
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'archive') throw new Error('fixture trailing failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({
        package: '@fixture/scoped-then-failing',
        descriptors: [contextDescriptor(), failing],
      })).rejects.toThrow('fixture trailing failure')
    } finally {
      spy.mockRestore()
    }

    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
  })

  it('keeps a namespace another contribution still populates when a group leaves', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { renamed: true } })
    const ctx = await bench(call)
    const { scope: _scope, ...direct } = directDescriptor()
    const disposeDirect = await ctx.remote.$mount({ package: '@fixture/direct-owner', descriptors: [direct] })
    const disposeScoped = await ctx.remote.$mount({ package: '@fixture/scoped-owner', descriptors: [contextDescriptor()] })

    await disposeDirect()
    // The namespace survives its first group: the second contribution still owns methods on it.
    const surviving = ctx.get('remote.probe') as unknown as Record<string, unknown> | undefined
    expect(surviving).toBeDefined()
    expect(surviving?.create).toBeUndefined()
    await disposeScoped()
    expect(ctx.get('remote.probe')).toBeUndefined()
  })

  it('unparks a namespace dependent only after its contribution methods exist', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const { scope: _scope, ...direct } = directDescriptor()
    let observed: string | undefined
    // Parked before the mount: the unpark moment is the observation — the
    // atomic-visibility guarantee says the service never appears methodless.
    const parked = ctx.inject(['remote.probe'], (probeCtx) => {
      observed = typeof (probeCtx.get('remote.probe') as { create?: unknown } | undefined)?.create
    })
    const dispose = await ctx.remote.$mount({ package: '@fixture/atomic-visibility', descriptors: [direct] })
    await parked
    expect(observed).toBe('function')
    await dispose()
  })

  it('rejects weak parameter and Context codecs plus malformed scope projections', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const direct = directDescriptor()
    const context = contextDescriptor()
    await expect(ctx.remote.$mount({
      package: '@fixture/weak-parameter',
      descriptors: [{
        ...direct,
        parameters: direct.parameters.map((parameter, index) => index === 0
          ? { ...parameter, codec: { mode: 'src-json' } }
          : parameter),
      }],
    })).rejects.toThrow('has no strict codec')
    await expect(ctx.remote.$mount({
      package: '@fixture/weak-context',
      descriptors: [{
        ...context,
        invocation: { ...context.invocation, codec: { mode: 'src-json' } },
      } as InvocationDescriptor],
    })).rejects.toThrow('has no strict codec')
    await expect(ctx.remote.$mount({
      package: '@fixture/malformed-scope',
      descriptors: [{ ...direct, scope: { context: 'fixture', wire: 'missingId' } }],
    })).rejects.toThrow('scope must select its only lookup parameter')
    await expect(ctx.remote.$mount({
      package: '@fixture/ambiguous-scope',
      descriptors: [{
        ...direct,
        parameters: [...direct.parameters, {
          name: 'other', wire: 'otherId', source: 'lookup', lookup: 'fixture',
          codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', schema: idSchema },
        }],
      }],
    })).rejects.toThrow('scope must select its only lookup parameter')
  })

  it('validates invocation arity, required adapters, live Connection, and mutable descriptor codecs', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-1' } })
    const ctx = await bench(call)
    const descriptor = directDescriptor()
    const dispose = await ctx.remote.$mount({
      package: '@fixture/probe',
      descriptors: [descriptor, contextDescriptor()],
    })
    const create = ctx.remote.probe.create as unknown as (...args: unknown[]) => Promise<unknown>
    const probe = (ctx as FixtureContext).remote.probe
    const rename = probe.rename as unknown as (...args: unknown[]) => Promise<unknown>

    await expect(create('agent-1')).rejects.toThrow('expected 2 business argument(s) plus an optional AbortSignal, got 1')
    await expect(create('agent-1', { objective: 'ship' }, undefined, 'extra'))
      .rejects.toThrow('got 4')
    await expect(rename.call(probe)).rejects.toThrow('expected 1 argument(s), got 0')
    await expect((ctx as FixtureContext).remote.probe.create({ objective: 'ship' }))
      .rejects.toThrow('expected 2 business argument(s)')
    await expect((ctx as FixtureContext).remote.probe.rename({ objective: 'ship' }))
      .rejects.toThrow('no Client Context adapter')

    ;(descriptor.parameters[0] as { codec: { mode: string } }).codec.mode = 'src-json'
    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).rejects.toThrow('has no strict codec')
    ;(descriptor.parameters[0] as { codec: { mode: string } }).codec.mode = 'strict'

    ctx.set('connection', undefined)
    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).rejects.toThrow('no active Connection')
    await dispose()
  })

  it('withdraws a pending invocation and preserves a direct namespace until its last method leaves', async () => {
    let resolveCall!: (result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>) => void
    const pending = new Promise<Awaited<ReturnType<ConnectionHandle['rpc']['call']>>>((resolve) => {
      resolveCall = resolve
    })
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockReturnValue(pending)
    const ctx = await bench(call)
    const { scope: _scope, ...first } = directDescriptor()
    const second: InvocationDescriptor = {
      ...first,
      id: '@fixture/probe#probe/archive',
      method: 'archive',
    }
    const dispose = await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [first, second] })
    const invocation = ctx.remote.probe.create('agent-1', { objective: 'ship' })
    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
    await dispose()
    resolveCall({ ok: true, value: { ref: 'goal-1' } })

    await expect(invocation).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: Remote method probe/create is no longer mounted',
        details: {},
      },
    })
    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
  })

  it('keeps a namespace while another contribution still owns a method', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const disposeCreate = await ctx.remote.$mount({
      package: '@fixture/create-contribution',
      descriptors: [directDescriptor()],
    })
    const disposeMaybe = await ctx.remote.$mount({
      package: '@fixture/maybe-contribution',
      descriptors: [maybeDescriptor()],
    })
    const namespace = ctx.get('remote.probe') as unknown as Record<string, unknown>

    await disposeCreate()

    expect(ctx.get('remote.probe') !== undefined).toBe(true)
    expect(namespace.create).toBeUndefined()
    expect(namespace.maybe).toBeTypeOf('function')

    await disposeMaybe()
    expect(ctx.get('remote.probe')).toBeUndefined()
  })

  it('fails a method obtained from a withdrawn namespace getter', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const dispose = await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })
    const namespace = ctx.get('remote.probe') as unknown as object
    const getWithdrawn = Object.getOwnPropertyDescriptor(namespace, 'create')?.get?.bind(namespace)

    await dispose()

    expect(getWithdrawn).toBeTypeOf('function')
    const withdrawn = getWithdrawn?.() as (...args: unknown[]) => Promise<unknown>
    expect(() => withdrawn('agent-1', { objective: 'ship' }))
      .toThrow('Remote method is no longer mounted')
  })

  it('preserves a __proto__ wire parameter as an own named argument', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: { ref: 'goal-1' } })
    const ctx = await bench(call)
    const { scope: _scope, ...base } = directDescriptor()
    const descriptor: InvocationDescriptor = {
      ...base,
      id: '@fixture/probe#probe/prototype',
      method: 'prototype',
      parameters: [{
        name: 'value',
        wire: '__proto__',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: '@fixture#PrototypeValue', schema: z.string() },
      }],
    }
    const dispose = await ctx.remote.$mount({ package: '@fixture/prototype', descriptors: [descriptor] })

    const method = (ctx.remote.probe as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).prototype
    await expect(method?.('wire-value')).resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    const payload = call.mock.calls[0]?.[2] as { readonly args: Record<string, unknown> }
    expect(Object.getPrototypeOf(payload.args)).toBeNull()
    expect(Object.hasOwn(payload.args, '__proto__')).toBe(true)
    expect(payload.args.__proto__).toBe('wire-value')
    await dispose()
  })

  it('rolls back Remote registration when namespace Service startup fails', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === Service.tracker) throw new Error('fixture namespace startup failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] }))
        .rejects.toThrow('fixture namespace startup failure')
      await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    } finally {
      spy.mockRestore()
    }

    const retry = await ctx.remote.$mount({ package: '@fixture/probe-retry', descriptors: [directDescriptor()] })
    expect(ctx.remote.probe.create).toBeTypeOf('function')
    await retry()
  })

  it('withdraws a fresh direct namespace when its first method fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'create') throw new Error('fixture direct method installation failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({
        package: '@fixture/direct-method-failure',
        descriptors: [directDescriptor()],
      })).rejects.toThrow('fixture direct method installation failure')
    } finally {
      spy.mockRestore()
    }

    expect((ctx.remote as unknown as Record<string, unknown>).probe).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    const retry = await ctx.remote.$mount({
      package: '@fixture/direct-method-retry',
      descriptors: [directDescriptor()],
    })
    expect(ctx.remote.probe.create).toBeTypeOf('function')
    await retry()
  })

  it('withdraws a fresh scoped Service when its first method fails to install', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const defineProperty = Object.defineProperty
    const spy = vi.spyOn(Object, 'defineProperty').mockImplementation((target, key, attributes) => {
      if (key === 'rename') throw new Error('fixture scoped installation failure')
      return defineProperty(target, key, attributes)
    })
    try {
      await expect(ctx.remote.$mount({ package: '@fixture/scoped-failure', descriptors: [contextDescriptor()] }))
        .rejects.toThrow('fixture scoped installation failure')
    } finally {
      spy.mockRestore()
    }

    expect(ctx.get('remote.probe')).toBeUndefined()
    await vi.waitFor(() => { expect(ctx.typert.remotes.list()).toEqual([]) })
    const retry = await ctx.remote.$mount({ package: '@fixture/scoped-retry', descriptors: [contextDescriptor()] })
    expect((ctx.get('remote.probe') as unknown as Record<string, unknown>).rename).toBeTypeOf('function')
    await retry()
  })

  it('unregisters an empty scoped namespace so another provider can claim its name', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    const dispose = await ctx.remote.$mount({ package: '@fixture/scoped', descriptors: [contextDescriptor()] })
    expect(ctx.get('remote.probe')).toBeDefined()

    await dispose()

    expect(ctx.get('remote.probe')).toBeUndefined()
    const replacement = { owner: 'replacement' }
    const disposeReplacement = ctx.reflect.provide('remote.probe', replacement)
    expect(ctx.get('remote.probe')).toBe(replacement)
    await disposeReplacement()
  })

  it('delivers an RPC failure in the error branch with the Host error verbatim', async () => {
    const rpcError = { code: 'gateway/internal' as const, message: 'host failed', details: {} }
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({ ok: false, error: rpcError }))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    const outcome = await ctx.remote.probe.create('agent-1', { objective: 'ship' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected the Client API invocation to report a failure')
    expect(outcome.error).toMatchObject(rpcError)
  })

  it('folds a transport throw into the error branch', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>()
      .mockRejectedValue(new Error('carrier offline')))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: probe/create failed: carrier offline',
        details: {},
      },
    })
  })

  it('folds a carrier throw that is not an Error into the error branch', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>()
      .mockRejectedValue('carrier exploded'))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'gateway/internal',
        message: 'client api: probe/create failed: carrier exploded',
        details: {},
      },
    })
  })

  it('classifies a carrier throw under a caller-aborted signal as gateway/cancelled', async () => {
    const controller = new AbortController()
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>().mockImplementation(async () => {
      controller.abort()
      throw new Error('carrier aborted mid-flight')
    }))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' }, controller.signal))
      .resolves.toMatchObject({
        ok: false,
        error: {
          code: 'gateway/cancelled',
          message: 'client api: Remote invocation "probe/create" was aborted',
          details: {},
        },
      })
  })

  it('keeps a carrier throw under an unaborted caller signal in the internal branch', async () => {
    const controller = new AbortController()
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>()
      .mockRejectedValue(new Error('carrier offline')))
    await ctx.remote.$mount({ package: '@fixture/probe', descriptors: [directDescriptor()] })

    await expect(ctx.remote.probe.create('agent-1', { objective: 'ship' }, controller.signal))
      .resolves.toMatchObject({
        ok: false,
        error: {
          code: 'gateway/internal',
          message: 'client api: probe/create failed: carrier offline',
          details: {},
        },
      })
  })

  it('owns each $on subscription in the calling fiber', async () => {
    const { ctx, client, carrier } = await eventBench()
    const seen: string[] = []
    const subscriber = ctx.plugin(Object.assign(
      (scope: Context) => { scope.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) }) },
      { inject: ['remote'] },
    ))
    await subscriber

    expect(carrier.calls).toEqual([expect.objectContaining({
      channel: '/api', endpoint: '$events', payload: { args: {} },
    })])
    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['settings'] })
    await vi.waitFor(() => { expect(seen).toEqual(['settings']) })

    await subscriber.dispose()
    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['after fiber disposal'] })
    await Promise.resolve()
    expect(seen).toEqual(['settings'])

    await client.dispose()
    expect(ctx.get('remote')).toBeUndefined()
  })

  it('isolates throwing and rejected notification listeners', async () => {
    const { ctx, client, carrier } = await eventBench()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: string[] = []
    const failingListener = (namespace: string): unknown => {
      if (namespace === 'sync') throw new Error('fixture listener failure')
      return Promise.reject(new Error('fixture async failure'))
    }
    const disposeThrowing = ctx.remote.$on('fixture/changed', failingListener)
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })
    try {
      carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['sync'] })
      await vi.waitFor(() => { expect(seen).toEqual(['sync']) })
      carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['async'] })
      await vi.waitFor(() => { expect(seen).toEqual(['sync', 'async']) })
      expect(consoleError).toHaveBeenCalledTimes(2)

      disposeThrowing()
      carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['survivor'] })
      await vi.waitFor(() => { expect(seen).toEqual(['sync', 'async', 'survivor']) })
    } finally {
      consoleError.mockRestore()
      await client.dispose()
    }
  })

  it('retires only its own registration when one listener subscribes twice', async () => {
    const { ctx, client, carrier } = await eventBench()
    const seen: string[] = []
    const listener = (namespace: string): void => { seen.push(namespace) }
    const disposeFirst = ctx.remote.$on('fixture/changed', listener)
    ctx.remote.$on('fixture/changed', listener)

    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['both'] })
    await vi.waitFor(() => { expect(seen).toEqual(['both', 'both']) })

    disposeFirst()
    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['survivor'] })
    await vi.waitFor(() => { expect(seen).toEqual(['both', 'both', 'survivor']) })

    disposeFirst()
    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['still here'] })
    await vi.waitFor(() => {
      expect(seen).toEqual(['both', 'both', 'survivor', 'still here'])
    })
    await client.dispose()
  })

  it('keeps the carrier handoff private', () => {
    expectTypeOf<ClientRemote>().toHaveProperty('$on')
    expectTypeOf<'$dispatch' extends keyof ClientRemote ? true : false>().toEqualTypeOf<false>()
  })

  it('drops an unobserved notification and accepts a null-prototype frame', async () => {
    const { ctx, client, carrier } = await eventBench()
    const seen: string[] = []
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })

    carrier.emit({ type: 'emit', event: 'fixture/idle', args: [1] })
    carrier.emit(Object.assign(Object.create(null) as Record<string, unknown>, {
      type: 'emit',
      event: 'fixture/changed',
      args: ['null prototype'],
    }))

    await vi.waitFor(() => { expect(seen).toEqual(['null prototype']) })
    await client.dispose()
  })

  it('delegates immediately when the Agent adapter or Context is unavailable', async () => {
    const { ctx, client, carrier, call } = await eventBench()
    carrier.emit(approvalFrame('event-no-adapter', 'agent-late', 'no adapter'))
    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })

    const target = ctx.extend()
    const resolve = vi.fn((id: unknown) => id === 'agent-found' ? target : undefined)
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-found') : undefined,
      resolve,
    })
    carrier.emit(approvalFrame('event-missing-context', 'agent-missing', 'missing'))
    carrier.emit(approvalFrame('event-no-listener', 'agent-found', 'delegate'))

    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(3) })
    expect(resolve).toHaveBeenCalledTimes(2)
    for (const eventId of ['event-no-adapter', 'event-missing-context', 'event-no-listener']) {
      expect(call).toHaveBeenCalledWith(
        '/api',
        '$events/result',
        { args: { clientId: 'event-client-1', eventId, outcome: { kind: 'next' } } },
        expect.any(AbortSignal),
      )
    }
    await client.dispose()
  })

  it('reports Agent Context resolution failures and delegates', async () => {
    const { ctx, client, carrier, call } = await eventBench()
    ctx.typert.contexts.registerClient('agent', {
      identity: () => undefined,
      resolve: () => { throw new Error('fixture Context lookup failed') },
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      carrier.emit(approvalFrame('event-resolve-error', 'agent-error', 'resolve'))
      await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
      expect(consoleError).toHaveBeenCalledWith(
        'client api: Remote event "fixture/approval" listener threw:',
        expect.objectContaining({ message: 'fixture Context lookup failed' }),
      )
      expect(call).toHaveBeenCalledWith(
        '/api',
        '$events/result',
        {
          args: {
            clientId: 'event-client-1',
            eventId: 'event-resolve-error',
            outcome: { kind: 'next' },
          },
        },
        expect.any(AbortSignal),
      )
    } finally {
      consoleError.mockRestore()
      await client.dispose()
    }
  })

  it('normalizes undefined waterfall results and rejects non-JSON results', async () => {
    const { ctx, client, carrier, call } = await eventBench()
    const target = ctx.extend()
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-results') : undefined,
      resolve: id => id === 'agent-results' ? target : undefined,
    })
    target.remote.$on('fixture/approval', async request => request.prompt === 'undefined'
      ? undefined as unknown as FixtureApprovalOutcome
      : Symbol('not JSON') as unknown as FixtureApprovalOutcome)

    carrier.emit(approvalFrame('event-undefined', 'agent-results', 'undefined'))
    carrier.emit(approvalFrame('event-invalid', 'agent-results', 'invalid'))

    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(2) })
    expect(call).toHaveBeenCalledWith(
      '/api',
      '$events/result',
      { args: { clientId: 'event-client-1', eventId: 'event-undefined', outcome: { kind: 'result' } } },
      expect.any(AbortSignal),
    )
    expect(call).toHaveBeenCalledWith(
      '/api',
      '$events/result',
      {
        args: {
          clientId: 'event-client-1',
          eventId: 'event-invalid',
          outcome: {
            kind: 'rejected',
            error: {
              name: 'TypeError',
              message: 'Remote event listener result is not lossless JSON data',
            },
          },
        },
      },
      expect.any(AbortSignal),
    )
    await client.dispose()
  })

  it('fails the Connection generation when a result RPC is rejected', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockResolvedValue({
      ok: false,
      error: { code: 'gateway/internal', message: 'fixture result rejected', details: {} },
    })
    const { client, carrier, run } = await eventBench(call)

    carrier.emit(approvalFrame('event-result-rejected', 'agent-missing', 'respond'))

    await expect(run.done).rejects.toThrow('fixture result rejected')
    await client.dispose()
  })

  it('filters scoped waterfall listeners and returns the first claimed result', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: undefined })
    const { ctx, client, carrier } = await eventBench(call)
    const target = ctx.extend({
      [Context.filter](candidate: Context): boolean {
        const tag = (candidate as Context & { [fixtureContextTag]?: string })[fixtureContextTag]
        return tag === undefined || tag === 'agent-1'
      },
    })
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-1') : undefined,
      resolve: id => id === 'agent-1' ? target : undefined,
    })
    const matching = ctx.extend({ [fixtureContextTag]: 'agent-1' })
    const excluded = ctx.extend({ [fixtureContextTag]: 'agent-2' })
    const seen: string[] = []
    ctx.remote.$on('fixture/approval', async function (request, next) {
      expect(this).toBe(target)
      expect(request.agent).toBe(target)
      expect(request.signal).toBeInstanceOf(AbortSignal)
      seen.push('root')
      return next()
    })
    matching.remote.$on('fixture/approval', async (_request, next) => {
      seen.push('matching-next')
      return next()
    })
    excluded.remote.$on('fixture/approval', async () => {
      seen.push('excluded')
      return 'unavailable'
    })
    matching.remote.$on('fixture/approval', async () => {
      seen.push('matching-result')
      return 'allowed'
    })

    carrier.emit(approvalFrame('event-1', 'agent-1', 'ship'))

    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
    expect(seen).toEqual(['root', 'matching-next', 'matching-result'])
    expect(call).toHaveBeenCalledWith(
      '/api',
      '$events/result',
      {
        args: {
          clientId: 'event-client-1',
          eventId: 'event-1',
          outcome: { kind: 'result', value: 'allowed' },
        },
      },
      expect.any(AbortSignal),
    )
    await client.dispose()
  })

  it('returns a scoped listener rejection to the Host', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: undefined })
    const { ctx, client, carrier } = await eventBench(call)
    const target = ctx.extend()
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-rejected') : undefined,
      resolve: id => id === 'agent-rejected' ? target : undefined,
    })
    const rejection = Object.assign(new Error('the user cancelled ask_user_question'), {
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
      details: { questionId: 'question-1' },
    })
    target.remote.$on('fixture/approval', () => Promise.reject(rejection))

    carrier.emit(approvalFrame('event-rejected', 'agent-rejected', 'gateway/cancelled'))

    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
    expect(call).toHaveBeenCalledWith(
      '/api',
      '$events/result',
      {
        args: {
          clientId: 'event-client-1',
          eventId: 'event-rejected',
          outcome: {
            kind: 'rejected',
            error: {
              name: 'UserQuestionError',
              message: 'the user cancelled ask_user_question',
              code: 'ASK_CANCELLED',
              details: { questionId: 'question-1' },
            },
          },
        },
      },
      expect.any(AbortSignal),
    )
    await client.dispose()
  })

  it('returns Context-filter failures as rejections', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
      .mockResolvedValue({ ok: true, value: undefined })
    const { ctx, client, carrier } = await eventBench(call)
    const target = ctx.extend({
      [Context.filter](): boolean {
        throw new Error('fixture Context filter failed')
      },
    })
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-filter-failure') : undefined,
      resolve: id => id === 'agent-filter-failure' ? target : undefined,
    })
    ctx.remote.$on('fixture/approval', async (_request, next) => next())

    carrier.emit(approvalFrame('event-filter-failure', 'agent-filter-failure', 'filter'))

    await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
    expect(call).toHaveBeenCalledWith(
      '/api',
      '$events/result',
      {
        args: {
          clientId: 'event-client-1',
          eventId: 'event-filter-failure',
          outcome: {
            kind: 'rejected',
            error: {
              name: 'Error',
              message: 'fixture Context filter failed',
            },
          },
        },
      },
      expect.any(AbortSignal),
    )
    await client.dispose()
  })

  it('cancels a pending Client listener without returning a late result', async () => {
    const { ctx, client, carrier, call } = await eventBench()
    const target = ctx.extend()
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-cancel') : undefined,
      resolve: id => id === 'agent-cancel' ? target : undefined,
    })
    const entered = Promise.withResolvers<AbortSignal>()
    target.remote.$on('fixture/approval', async (request) => {
      const signal = request.signal as AbortSignal
      entered.resolve(signal)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return 'allowed'
    })
    carrier.emit(approvalFrame('event-cancel', 'agent-cancel', 'wait'))
    const deliverySignal = await entered.promise

    carrier.emit({ type: 'cancel', eventId: 'event-cancel' })
    await vi.waitFor(() => { expect(deliverySignal.aborted).toBe(true) })
    await Promise.resolve()
    expect(call).not.toHaveBeenCalled()

    await client.dispose()
  })

  it('drops a settled listener result when cancellation wins before reply', async () => {
    const { ctx, client, carrier, call } = await eventBench()
    const target = ctx.extend()
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-cancel-race') : undefined,
      resolve: id => id === 'agent-cancel-race' ? target : undefined,
    })
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<undefined>()
    target.remote.$on('fixture/approval', async (request) => {
      entered.resolve(request.signal as AbortSignal)
      await release.promise
      return 'allowed'
    })
    carrier.emit(approvalFrame('event-cancel-race', 'agent-cancel-race', 'wait'))
    const deliverySignal = await entered.promise

    release.resolve(undefined)
    carrier.emit({ type: 'cancel', eventId: 'event-cancel-race' })
    await vi.waitFor(() => { expect(deliverySignal.aborted).toBe(true) })
    await Promise.resolve()
    expect(call).not.toHaveBeenCalled()

    await client.dispose()
  })

  it('cancels pending listener work when the generation ends', async () => {
    const { ctx, client, carrier, run, call } = await eventBench()
    const target = ctx.extend()
    ctx.typert.contexts.registerClient('agent', {
      identity: candidate => candidate === target ? agentId('agent-generation') : undefined,
      resolve: id => id === 'agent-generation' ? target : undefined,
    })
    const entered = Promise.withResolvers<AbortSignal>()
    target.remote.$on('fixture/approval', async (request) => {
      const signal = request.signal as AbortSignal
      entered.resolve(signal)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return 'allowed'
    })
    carrier.emit(approvalFrame('event-generation', 'agent-generation', 'wait'))
    const deliverySignal = await entered.promise

    run.abort(new Error('fixture generation ended'))
    await expect(run.done).resolves.toBeUndefined()
    expect(deliverySignal.aborted).toBe(true)
    expect(call).not.toHaveBeenCalled()

    await client.dispose()
  })

  it('contains a result transport failure after the generation is cancelled', async () => {
    const response = Promise.withResolvers<never>()
    const call = vi.fn<ConnectionHandle['rpc']['call']>(() => response.promise)
    const { client, carrier, run } = await eventBench(call)
    carrier.emit(approvalFrame('event-late-result', 'agent-missing', 'respond'))
    await vi.waitFor(() => { expect(call).toHaveBeenCalledOnce() })

    run.abort(new Error('fixture generation cancelled'))
    response.reject(new Error('fixture late result failure'))
    await expect(run.done).resolves.toBeUndefined()

    await client.dispose()
  })

  it('normalizes a non-Error result transport failure', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>().mockRejectedValue('fixture transport failure')
    const { client, carrier, run } = await eventBench(call)

    carrier.emit(approvalFrame('event-result-throw', 'agent-missing', 'respond'))

    await expect(run.done).rejects.toMatchObject({
      message: 'client api: Remote event result delivery failed',
      cause: 'fixture transport failure',
    })
    await client.dispose()
  })

  it('keeps the newer generation tracked when an overlapping generation settles', async () => {
    const { client, generation, run } = await eventBench()
    const overlapping = generation.startOverlapping()
    await overlapping.ready

    run.abort(new Error('fixture older generation ended'))
    await expect(run.done).resolves.toBeUndefined()
    overlapping.abort(new Error('fixture newer generation ended'))
    await expect(overlapping.done).resolves.toBeUndefined()
    await client.dispose()
  })

  it('opens the forwarded-event stream on the browser Remote mux', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      const call = vi.fn<ConnectionHandle['rpc']['call']>()
        .mockResolvedValue({ ok: true, value: undefined })
      const { ctx, client, generation } = await benchFiber(call, 'web')
      const seen: string[] = []
      const target = ctx.extend()
      ctx.typert.contexts.registerClient('agent', {
        identity: candidate => candidate === target ? agentId('agent-browser') : undefined,
        resolve: id => id === 'agent-browser' ? target : undefined,
      })
      ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })
      target.remote.$on('fixture/approval', async function (request) {
        expect(this).toBe(target)
        expect(request.agent).toBe(this)
        expect(request.signal).toBeInstanceOf(AbortSignal)
        return 'allowed'
      })
      const run = generation.start()

      await vi.waitFor(() => { expect(FakeWebSocket.sockets[0]?.sent).toHaveLength(1) })
      const socket = FakeWebSocket.sockets[0]!
      const opened = JSON.parse(socket.sent[0]!) as { streamId: string }
      expect(opened).toMatchObject({
        type: 'open', endpoint: '$events', payload: { args: {} },
      })
      socket.receive({
        type: 'item',
        streamId: opened.streamId,
        value: { type: 'ready', clientId: 'browser-client', host: { home: '/home/browser' } },
      })
      await run.ready
      socket.receive({
        type: 'item',
        streamId: opened.streamId,
        value: { type: 'emit', event: 'fixture/changed', args: ['browser'] },
      })
      await vi.waitFor(() => { expect(seen).toEqual(['browser']) })

      socket.receive({
        type: 'item',
        streamId: opened.streamId,
        value: {
          type: 'waterfall',
          event: 'fixture/approval',
          eventId: 'event-browser',
          agentId: 'agent-browser',
          request: { prompt: 'browser approval' },
        },
      })
      await vi.waitFor(() => { expect(call).toHaveBeenCalledTimes(1) })
      expect(socket.sent).toHaveLength(1)
      expect(call).toHaveBeenCalledWith(
        '/api',
        '$events/result',
        {
          args: {
            clientId: 'browser-client',
            eventId: 'event-browser',
            outcome: { kind: 'result', value: 'allowed' },
          },
        },
        expect.any(AbortSignal),
      )

      await client.dispose()
    })
  })

  it('publishes the Fixture Host facts after Remote events report ready', async () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hostname: '127.0.0.1', search: '?fixture' },
    })
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin({ inject: [], apply: applyConnection })
      await ctx.plugin({ inject, apply })
      const connection = ctx.get('connection') as ConnectionHandle | undefined
      if (connection === undefined) throw new Error('fixture Connection service is unavailable')

      await vi.waitFor(() => {
        expect(connection.generation.getSnapshot()?.host.home).toBe('/home/fixture')
      })
    } finally {
      await ctx.fiber.dispose()
      if (locationDescriptor === undefined) Reflect.deleteProperty(globalThis, 'location')
      else Object.defineProperty(globalThis, 'location', locationDescriptor)
    }
  })

  it.each([
    null,
    [],
    {},
    { type: 'pending' },
    { type: 'ready' },
    { type: 'ready', clientId: '' },
    { type: 'ready', clientId: 'client', extra: true },
    { type: 'ready', clientId: 'client', host: null },
    { type: 'ready', clientId: 'client', host: {} },
    { type: 'ready', clientId: 'client', host: { home: 1 } },
    { type: 'ready', clientId: 'client', host: { home: '/home', extra: true } },
    { type: 'emit', event: 'fixture/changed', args: ['too early'] },
  ])('rejects malformed forwarded-event readiness item %#', async (opening) => {
    const open: NonNullable<ConnectionHandle['rpc']['open']> = () => (async function *() {
      yield opening
    })()
    const { client, generation } = await benchFiber(
      vi.fn<ConnectionHandle['rpc']['call']>(),
      'in-process',
      open,
    )
    const run = generation.start()
    try {
      await expect(run.done).rejects.toThrow('forwarded Remote event stream did not begin with ready')
    } finally {
      await client.dispose()
    }
  })

  it('propagates physical carrier failure and opens events for the replacement generation', async () => {
    const { ctx, client, carrier, generation, run } = await eventBench()
    const seen: string[] = []
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })
    expect(carrier.calls).toHaveLength(1)

    carrier.fail(new RemoteStreamCarrierError('fixture generation lost'))
    await expect(run.done).rejects.toThrow('fixture generation lost')
    const replacement = generation.start()
    await replacement.ready
    await vi.waitFor(() => { expect(carrier.calls).toHaveLength(2) })
    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['replacement'] })
    await vi.waitFor(() => { expect(seen).toEqual(['replacement']) })

    await client.dispose()
  })

  it.each([
    {
      name: 'Host failure',
      stop: (carrier: RemoteEventCarrier) => {
        carrier.fail(new RemoteError('gateway/internal', 'fixture Host failed', {}))
      },
      message: 'fixture Host failed',
    },
    {
      name: 'normal end',
      stop: (carrier: RemoteEventCarrier) => { carrier.end() },
      message: 'forwarded Remote event stream ended unexpectedly',
    },
  ])('fails the active generation after $name', async ({ stop, message }) => {
    const { ctx, client, carrier, run } = await eventBench()
    const seen: string[] = []
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })
    stop(carrier)
    await expect(run.done).rejects.toThrow(message)
    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['too late'] })
    await Promise.resolve()
    expect(carrier.calls).toHaveLength(1)
    expect(seen).toEqual([])
    await client.dispose()
  })

  it.each([
    'not an object',
    null,
    [],
    {},
    { type: 'unknown' },
    { type: 'emit', event: 'fixture/changed' },
    { type: 'emit', event: 'fixture/changed', args: [], extra: true },
    { type: 'emit', event: 1, args: [] },
    { type: 'emit', event: '', args: [] },
    { type: 'emit', event: 'fixture/changed', args: {} },
    { type: 'emit', event: 'fixture/changed', args: [1n] },
    { type: 'waterfall', event: 'fixture/approval', eventId: '', agentId: 'agent-1', request: {} },
    { type: 'waterfall', event: 'fixture/approval', eventId: 'event-1', agentId: '', request: {} },
    {
      type: 'waterfall', event: 'fixture/approval', eventId: 'event-1', agentId: 'agent-1', request: { agent: null },
    },
    {
      type: 'waterfall', event: 'fixture/approval', eventId: 'event-1', agentId: 'agent-1', request: { signal: null },
    },
    { type: 'cancel', eventId: '' },
    { type: 'cancel', eventId: 'event-1', extra: true },
  ])('rejects malformed forwarded-event frame %# and stops that stream', async (frame) => {
    const { ctx, client, carrier, run } = await eventBench()
    const seen: string[] = []
    ctx.remote.$on('fixture/changed', (namespace) => { seen.push(namespace) })
    carrier.emit(frame)
    await expect(run.done).rejects.toThrow('client api: invalid forwarded Remote event frame')
    carrier.emit({ type: 'emit', event: 'fixture/changed', args: ['too late'] })
    await Promise.resolve()
    expect(carrier.calls).toHaveLength(1)
    expect(seen).toEqual([])
    await client.dispose()
  })

  it('aborts and awaits forwarded-event delivery during disposal', async () => {
    const { ctx, client, carrier, run } = await eventBench()
    ctx.remote.$on('fixture/changed', () => {})
    expect(carrier.activeConnections).toBe(1)
    const signal = carrier.calls[0]?.signal

    await client.dispose()
    await expect(run.done).resolves.toBeUndefined()

    expect(signal?.aborted).toBe(true)
    expect(carrier.activeConnections).toBe(0)
    expect(ctx.get('remote')).toBeUndefined()
  })

  it('rejects a generation when its Connection has been withdrawn', async () => {
    const carrier = new RemoteEventCarrier()
    const { ctx, client, generation } = await benchFiber(
      vi.fn<ConnectionHandle['rpc']['call']>(),
      'in-process',
      carrier.open,
    )
    ctx.set('connection', undefined)
    const run = generation.start()
    await expect(run.done).rejects.toThrow('$events has no active Connection')
    expect(carrier.calls).toEqual([])
    await client.dispose()
  })

  it('guards stream iteration across mount and Connection withdrawal', async () => {
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
    const ctx = await bench(call)
    const firstDispose = await ctx.remote.$mount({
      package: '@fixture/stream-first', descriptors: [streamDescriptor()],
    })
    const withdrawn = ctx.remote.probe.watch('withdrawn')[Symbol.asyncIterator]()
    await firstDispose()
    await expect(withdrawn.next()).rejects.toThrow('Remote method probe/watch is no longer mounted')

    const secondDispose = await ctx.remote.$mount({
      package: '@fixture/stream-second', descriptors: [streamDescriptor()],
    })
    ctx.set('connection', undefined)
    await expect(ctx.remote.probe.watch('offline')[Symbol.asyncIterator]().next())
      .rejects.toThrow('probe/watch has no active Connection')

    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const source = async function *(): AsyncIterable<string> {
      markStarted()
      await released
      yield 'late item'
    }
    ctx.set('connection', {
      rpc: { call, open: () => source() },
    } as unknown as ConnectionHandle)
    const active = ctx.remote.probe.watch('active')[Symbol.asyncIterator]()
    const pending = active.next()
    await started
    await secondDispose()
    release()
    await expect(pending).rejects.toThrow('Remote method probe/watch is no longer mounted')
  })

  it('publishes a namespace only after every contributed method is installed', async () => {
    const ctx = await bench(vi.fn<ConnectionHandle['rpc']['call']>())
    let visible: string[] | undefined
    const consumer = ctx.plugin({
      inject: ['remote.probe'],
      apply(scope) {
        const namespace = scope.get('remote.probe') as unknown as Record<string, unknown>
        visible = [typeof namespace.watch, typeof namespace.archive]
      },
    })
    const archive: InvocationDescriptor = {
      ...streamDescriptor(),
      id: '@fixture/probe#probe/archive',
      method: 'archive',
    }

    const dispose = await ctx.remote.$mount({
      package: '@fixture/atomic-namespace',
      descriptors: [streamDescriptor(), archive],
    })
    await consumer.await()

    expect(visible).toEqual(['function', 'function'])
    await dispose()
  })

  it('normalizes worker-local structural stream failures without sharing class identity', async () => {
    const cases = [{
      failure: Object.assign(new Error('fixture Host rejected the stream'), {
        dshRemoteStreamFailure: {
          kind: 'remote' as const,
          code: 'fixture/rejected',
          details: { retry: false },
        },
      }),
      assert: (error: unknown) => {
        expect(error).toBeInstanceOf(RemoteError)
        expect(error).toMatchObject({
          code: 'fixture/rejected',
          message: 'fixture Host rejected the stream',
          details: { retry: false },
        })
      },
    }, {
      failure: Object.assign(new Error('worker carrier stopped'), {
        dshRemoteStreamFailure: { kind: 'carrier' as const },
      }),
      assert: (error: unknown) => {
        expect(error).toBeInstanceOf(RemoteStreamCarrierError)
        expect(error).toMatchObject({ message: 'worker carrier stopped' })
      },
    }, {
      failure: 'caller abort sentinel',
      assert: (error: unknown) => { expect(error).toBe('caller abort sentinel') },
    }]

    for (const testCase of cases) {
      const open: NonNullable<ConnectionHandle['rpc']['open']> = () => (async function *(): AsyncGenerator {
        throw testCase.failure
      })()
      const { ctx, client } = await benchFiber(
        vi.fn<ConnectionHandle['rpc']['call']>(),
        'in-process',
        open,
      )
      const dispose = await ctx.remote.$mount({ package: '@fixture/worker-stream', descriptors: [streamDescriptor()] })
      try {
        const error = await ctx.remote.probe.watch('failure')[Symbol.asyncIterator]().next()
          .then(() => undefined, (reason: unknown) => reason)
        testCase.assert(error)
      } finally {
        await dispose()
        await client.dispose()
      }
    }
  })

  it('multiplexes Remote streams without using the Connection RPC caller', async () => {
    const originalWebSocket = globalThis.WebSocket
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://harness.example' },
    })
    FakeWebSocket.sockets.length = 0
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
    const ctx = await bench(call, 'web')
    expect(FakeWebSocket.sockets).toHaveLength(1)
    const dispose = await ctx.remote.$mount({ package: '@fixture/stream', descriptors: [streamDescriptor()] })
    try {
      const first = ctx.remote.probe.watch('alpha')[Symbol.asyncIterator]()
      const firstItem = first.next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets[0]?.sent).toHaveLength(1) })
      const socket = FakeWebSocket.sockets[0]!
      expect(socket.url).toBe('wss://harness.example/api/remote.mux')
      const opened = JSON.parse(socket.sent[0]!) as { streamId: string }
      expect(opened).toMatchObject({
        type: 'open',
        endpoint: 'probe/watch',
        payload: { args: { topic: 'alpha' } },
      })
      socket.receive({ type: 'item', streamId: opened.streamId, value: 'alpha:one' })
      await expect(firstItem).resolves.toEqual({ done: false, value: 'alpha:one' })
      const firstEnd = first.next()
      socket.receive({ type: 'end', streamId: opened.streamId })
      await expect(firstEnd).resolves.toEqual({ done: true, value: undefined })

      const failed = ctx.remote.probe.watch('failure')[Symbol.asyncIterator]()
      const failedItem = failed.next()
      await vi.waitFor(() => { expect(socket.sent).toHaveLength(2) })
      const failedOpen = JSON.parse(socket.sent[1]!) as { streamId: string }
      socket.receive({
        type: 'error',
        streamId: failedOpen.streamId,
        error: {
          code: 'gateway/lookup-unavailable',
          message: 'fixture stream failed',
          details: { lookup: 'missing' },
        },
      })
      await expect(failedItem).rejects.toMatchObject({
        name: 'RemoteError',
        code: 'gateway/lookup-unavailable',
        message: 'fixture stream failed',
        details: { lookup: 'missing' },
      })

      const abort = new AbortController()
      const cancelled = ctx.remote.probe.watch('cancel', abort.signal)[Symbol.asyncIterator]()
      const cancelledItem = cancelled.next()
      await vi.waitFor(() => { expect(socket.sent).toHaveLength(3) })
      const cancelledOpen = JSON.parse(socket.sent[2]!) as { streamId: string }
      const cancellation = new Error('caller cancelled')
      socket.receive({ type: 'item', streamId: cancelledOpen.streamId, value: 'already queued' })
      abort.abort(cancellation)
      socket.receive({ type: 'item', streamId: cancelledOpen.streamId, value: 'after cancellation' })
      await expect(cancelledItem).rejects.toBe(cancellation)
      await vi.waitFor(() => {
        expect(socket.sent.map(text => JSON.parse(text) as unknown)).toContainEqual({
          type: 'cancel', streamId: cancelledOpen.streamId,
        })
      })
      expect(call).not.toHaveBeenCalled()
    } finally {
      await dispose()
      await ctx.fiber.dispose()
      FakeWebSocket.sockets.length = 0
      FakeWebSocket.autoOpen = true
      FakeWebSocket.dispatchClose = true
      if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
      else globalThis.WebSocket = originalWebSocket
      if (locationDescriptor === undefined) Reflect.deleteProperty(globalThis, 'location')
      else Object.defineProperty(globalThis, 'location', locationDescriptor)
    }
  })
})

describe('Remote stream client carrier lifecycle', () => {
  it('requires the transport owner to start the physical carrier', async () => {
    const client = new RemoteStreamMuxClient()
    await expect(client.open('feed/follow', {}, new AbortController().signal)
      [Symbol.asyncIterator]().next()).rejects.toThrow('Remote stream client not started')
    await client.close()
  })

  it('connects without a logical stream, waits for owner-driven retries, and stops permanently', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      FakeWebSocket.autoOpen = false
      const client = new RemoteStreamMuxClient()
      client.start()
      client.start()
      expect(FakeWebSocket.sockets).toHaveLength(1)

      const failed = FakeWebSocket.sockets[0]!
      failed.fail()
      await Promise.resolve()
      expect(FakeWebSocket.sockets).toHaveLength(1)

      client.reconnect()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
      const connected = FakeWebSocket.sockets[1]!
      connected.open()
      await Promise.resolve()
      client.start()
      expect(FakeWebSocket.sockets).toHaveLength(2)
      expect(connected.sent).toEqual([])
      connected.fail()
      await Promise.resolve()
      expect(FakeWebSocket.sockets).toHaveLength(2)

      client.reconnect()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(3) })
      const final = FakeWebSocket.sockets[2]!
      final.open()
      await client.close()
      await client.close()
      client.start()
      await expect(client.open('feed/follow', {}, new AbortController().signal)
        [Symbol.asyncIterator]().next()).rejects.toThrow('Remote stream client disposed')

      expect(FakeWebSocket.sockets).toHaveLength(3)
      expect(final.closedWith).toContainEqual({ code: 1000, reason: 'disposed' })

      const stopping = new RemoteStreamMuxClient()
      stopping.start()
      const racing = FakeWebSocket.sockets[3]!
      racing.open()
      racing.drop()
      await stopping.close()
      expect(FakeWebSocket.sockets).toHaveLength(4)
    })
  })

  it('mints a new wire stream id when the same endpoint opens on a replacement socket', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      const client = new RemoteStreamMuxClient()
      client.start()
      const first = client.open('feed/follow', { label: 'same' }, new AbortController().signal)
        [Symbol.asyncIterator]()
      const firstPending = first.next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets[0]?.sent).toHaveLength(1) })
      const firstSocket = FakeWebSocket.sockets[0]!
      const firstOpen = JSON.parse(firstSocket.sent[0]!) as { streamId: string }
      firstSocket.receive({ type: 'end', streamId: firstOpen.streamId })
      await expect(firstPending).resolves.toEqual({ done: true, value: undefined })

      client.reconnect()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
      const second = client.open('feed/follow', { label: 'same' }, new AbortController().signal)
        [Symbol.asyncIterator]()
      const secondPending = second.next()
      const secondSocket = FakeWebSocket.sockets[1]!
      await vi.waitFor(() => { expect(secondSocket.sent).toHaveLength(1) })
      const secondOpen = JSON.parse(secondSocket.sent[0]!) as { streamId: string }
      expect(secondOpen.streamId).not.toBe(firstOpen.streamId)
      secondSocket.receive({ type: 'end', streamId: secondOpen.streamId })
      await expect(secondPending).resolves.toEqual({ done: true, value: undefined })
      await client.close()
    })
  })

  it('replaces an in-flight candidate and an open socket on reconnect', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      FakeWebSocket.autoOpen = false
      const client = new RemoteStreamMuxClient()
      client.start()
      const candidate = FakeWebSocket.sockets[0]!

      client.reconnect()
      const replacementPending = client.open(
        'feed/follow',
        { label: 'replacement' },
        new AbortController().signal,
      )[Symbol.asyncIterator]().next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
      expect(candidate.closedWith).toContainEqual({})
      const connected = FakeWebSocket.sockets[1]!
      connected.open()
      await vi.waitFor(() => { expect(connected.sent).toHaveLength(1) })
      const opened = JSON.parse(connected.sent[0]!) as { streamId: string }
      connected.receive({ type: 'end', streamId: opened.streamId })
      await expect(replacementPending).resolves.toEqual({ done: true, value: undefined })

      client.reconnect()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(3) })
      expect(connected.closedWith).toContainEqual({ code: 4000, reason: 'reconnect requested' })

      await client.close()
      client.reconnect()
      await Promise.resolve()
      expect(FakeWebSocket.sockets).toHaveLength(3)
    })
  })

  it('coalesces repeated candidate replacements and drops one queued after close', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      FakeWebSocket.autoOpen = false
      const client = new RemoteStreamMuxClient()
      client.start()
      const first = FakeWebSocket.sockets[0]!

      client.reconnect()
      client.reconnect()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
      expect(first.closedWith).toContainEqual({})

      client.reconnect()
      await client.close()
      await Promise.resolve()
      expect(FakeWebSocket.sockets).toHaveLength(2)
    })
  })

  it('shares an in-flight connection and uses the internal ws URL without a browser origin', async () => {
    await withFakeWebSocket(undefined, async () => {
      FakeWebSocket.autoOpen = false
      const client = new RemoteStreamMuxClient()
      client.start()
      const first = client.open('feed/follow', { label: 'first' }, new AbortController().signal)
        [Symbol.asyncIterator]()
      const second = client.open('feed/follow', { label: 'second' }, new AbortController().signal)
        [Symbol.asyncIterator]()
      const firstPending = first.next()
      const secondPending = second.next()
      expect(FakeWebSocket.sockets).toHaveLength(1)
      const socket = FakeWebSocket.sockets[0]!
      expect(socket.url).toBe('ws://dsh.internal/api/remote.mux')

      socket.open()
      await vi.waitFor(() => { expect(socket.sent).toHaveLength(2) })
      const streamIds = socket.sent.map(text => (JSON.parse(text) as { streamId: string }).streamId)
      socket.receive({ type: 'end', streamId: streamIds[0] })
      socket.receive({ type: 'end', streamId: streamIds[1] })
      await expect(firstPending).resolves.toEqual({ done: true, value: undefined })
      await expect(secondPending).resolves.toEqual({ done: true, value: undefined })
      await client.close()
    })
  })

  it('fails waiters with one socket attempt and lets the owner start the next attempt', async () => {
    await withFakeWebSocket('null', async () => {
      FakeWebSocket.autoOpen = false
      const closedClient = new RemoteStreamMuxClient()
      closedClient.start()
      const closed = closedClient.open('feed/follow', {}, new AbortController().signal)
        [Symbol.asyncIterator]().next()
      FakeWebSocket.sockets[0]!.drop()
      await expect(closed).rejects.toThrow('Remote stream WebSocket closed before opening')

      closedClient.reconnect()
      const replacementStream = closedClient.open('feed/follow', {}, new AbortController().signal)
        [Symbol.asyncIterator]().next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets).toHaveLength(2) })
      const replacement = FakeWebSocket.sockets[1]!
      replacement.open()
      await vi.waitFor(() => { expect(replacement.sent).toHaveLength(1) })
      const { streamId } = JSON.parse(replacement.sent[0]!) as { streamId: string }
      replacement.receive({ type: 'end', streamId })
      await expect(replacementStream).resolves.toEqual({ done: true, value: undefined })
      await closedClient.close()

      const disposedClient = new RemoteStreamMuxClient()
      disposedClient.start()
      const disposed = disposedClient.open('feed/follow', {}, new AbortController().signal)
        [Symbol.asyncIterator]().next()
      await disposedClient.close()
      await expect(disposed).rejects.toThrow('Remote stream client disposed')

      const abortedClient = new RemoteStreamMuxClient()
      abortedClient.start()
      const abort = new AbortController()
      const aborted = abortedClient.open('feed/follow', {}, abort.signal)[Symbol.asyncIterator]().next()
      abort.abort('cancelled while connecting')
      await expect(aborted).rejects.toBe('cancelled while connecting')
      await abortedClient.close()
      expect(FakeWebSocket.sockets[3]?.url).toBe('ws://dsh.internal/api/remote.mux')
    })
  })

  it('fails active streams on an invalid frame and ignores later frames', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      const client = new RemoteStreamMuxClient()
      client.start()
      const stream = client.open('feed/follow', {}, new AbortController().signal)[Symbol.asyncIterator]()
      const pending = stream.next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets[0]?.sent).toHaveLength(1) })
      const socket = FakeWebSocket.sockets[0]!
      const { streamId } = JSON.parse(socket.sent[0]!) as { streamId: string }
      FakeWebSocket.dispatchClose = false
      socket.receiveRaw(new Uint8Array([1, 2, 3]))
      socket.receive({ type: 'item', streamId, value: 'too late' })
      socket.drop()

      await expect(pending).rejects.toMatchObject({
        name: 'RemoteStreamCarrierError', message: 'api gateway: invalid Remote stream frame',
      })
      expect(socket.closedWith).toContainEqual({ code: 4002, reason: 'invalid Remote stream frame' })
      await client.close()
    })
  })

  it('completes a stream and drops a frame racing with cancellation', async () => {
    await withFakeWebSocket('https://harness.example', async () => {
      const client = new RemoteStreamMuxClient()
      client.start()
      const completed = client.open('feed/follow', {}, new AbortController().signal)
        [Symbol.asyncIterator]()
      const completedPending = completed.next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets[0]?.sent).toHaveLength(1) })
      const socket = FakeWebSocket.sockets[0]!
      const completedOpen = JSON.parse(socket.sent[0]!) as { streamId: string }
      socket.receive({ type: 'end', streamId: completedOpen.streamId })
      await expect(completedPending).resolves.toEqual({ done: true, value: undefined })

      const abort = new AbortController()
      const cancelled = client.open('feed/follow', {}, abort.signal)[Symbol.asyncIterator]().next()
      await vi.waitFor(() => { expect(socket.sent).toHaveLength(2) })
      const cancelledOpen = JSON.parse(socket.sent[1]!) as { streamId: string }
      const reason = new Error('fixture cancellation race')
      abort.abort(reason)
      socket.receive({ type: 'item', streamId: cancelledOpen.streamId, value: 'too late' })
      await expect(cancelled).rejects.toBe(reason)
      await client.close()
    })
  })

  it('contains non-Error cancellation reasons and late socket close events', async () => {
    await withFakeWebSocket('http://harness.example', async () => {
      const cancelledClient = new RemoteStreamMuxClient()
      cancelledClient.start()
      const abort = new AbortController()
      const cancelled = cancelledClient.open('feed/follow', {}, abort.signal)[Symbol.asyncIterator]().next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets[0]?.sent).toHaveLength(1) })
      abort.abort('caller cancelled')
      await expect(cancelled).rejects.toThrow('caller cancelled')
      await cancelledClient.close()

      FakeWebSocket.dispatchClose = false
      const disposedClient = new RemoteStreamMuxClient()
      disposedClient.start()
      const disposed = disposedClient.open('feed/follow', {}, new AbortController().signal)
        [Symbol.asyncIterator]().next()
      await vi.waitFor(() => { expect(FakeWebSocket.sockets[1]?.sent).toHaveLength(1) })
      const disposedSocket = FakeWebSocket.sockets[1]!
      await disposedClient.close()
      disposedSocket.receive({ type: 'end', streamId: 'stale' })
      disposedSocket.drop()
      await expect(disposed).rejects.toThrow('Remote stream client disposed')
    })
  })
})

async function withFakeWebSocket(
  origin: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const originalWebSocket = globalThis.WebSocket
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
  ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
  if (origin === undefined) Reflect.deleteProperty(globalThis, 'location')
  else Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } })
  FakeWebSocket.sockets.length = 0
  FakeWebSocket.autoOpen = true
  FakeWebSocket.dispatchClose = true
  try {
    await run()
  } finally {
    FakeWebSocket.sockets.length = 0
    FakeWebSocket.autoOpen = true
    FakeWebSocket.dispatchClose = true
    if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
    else globalThis.WebSocket = originalWebSocket
    if (locationDescriptor === undefined) Reflect.deleteProperty(globalThis, 'location')
    else Object.defineProperty(globalThis, 'location', locationDescriptor)
  }
}
