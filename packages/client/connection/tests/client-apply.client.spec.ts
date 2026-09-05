/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and single-consumer connection-loop ownership.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  type ClientTransportHooks,
  type ConnectionGenerationSource,
  type ConnectionHandle,
  type ConnectionState,
} from '../src/client/index.ts'

type Win = {
  location?: { hostname: string; search: string; origin?: string }
  __DSH_TRANSPORT__?: ClientTransportHooks
}

afterEach(() => {
  delete (globalThis as Win).location
  delete (globalThis as Win).__DSH_TRANSPORT__
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

class BrowserNetworkProbe extends EventTarget {
  readonly navigator = { onLine: true }

  setOnline(online: boolean): void {
    this.navigator.onLine = online
    this.dispatchEvent(new Event(online ? 'online' : 'offline'))
  }
}

class GenerationProbe {
  private readonly active = new Set<() => void>()

  readonly source: ConnectionGenerationSource = (signal, ready) => new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', finish)
      this.active.delete(finish)
      resolve()
    }
    this.active.add(finish)
    signal.addEventListener('abort', finish, { once: true })
    ready({ home: '/h' })
    if (signal.aborted) finish()
  })

  end(): void {
    for (const finish of [...this.active]) finish()
  }
}

function installGeneration(handle: ConnectionHandle): GenerationProbe {
  const probe = new GenerationProbe()
  handle.registerGenerationSource(probe.source)
  return probe
}

async function mount(): Promise<ConnectionHandle> {
  const ctx = new Context()
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('uses Host bootstrap timing when Gateway starts without overrides', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('__DSH_CONNECTION_RECOVERY__', {
      backoffBaseMs: 10, backoffMaxMs: 10, generationReadyTimeoutMs: 20,
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const handle = await mount()
    const signals: AbortSignal[] = []
    handle.registerGenerationSource(signal => new Promise<void>((resolve) => {
      signals.push(signal)
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    }))
    const loop = handle.start({})
    try {
      await vi.advanceTimersByTimeAsync(20)
      expect(signals[0]?.aborted).toBe(true)
      expect(handle.state.getSnapshot()).toBe('connecting')
      await vi.advanceTimersByTimeAsync(10)
      expect(signals).toHaveLength(2)
    } finally {
      loop.stop()
      await vi.advanceTimersByTimeAsync(0)
      warnSpy.mockRestore()
    }
  })

  it.each([{ generationReadyTimeoutMs: 0 }, { backoffFactor: NaN }])('rejects malformed bootstrap recovery before publishing the service: %j', (recovery) => {
    vi.stubGlobal('__DSH_CONNECTION_RECOVERY__', recovery)
    const ctx = new Context()
    expect(() => { apply(ctx) }).toThrow()
    expect(ctx.get('connection')).toBeUndefined()
  })

  it('rejects a NaN start override without acquiring the generation source', async () => {
    const handle = await mount()
    const source = vi.fn<ConnectionGenerationSource>()
    const unregister = handle.registerGenerationSource(source)
    try {
      expect(() => handle.start({}, { backoffFactor: NaN })).toThrow(/backoffFactor.*finite/)
      expect(source).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('treats a runtime without browser location as local', async () => {
    delete (globalThis as Win).location
    expect((await mount()).isLoopback).toBe(true)
  })

  it('mounts ctx.connection and identifies a loopback page', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    expect(handle.isLoopback).toBe(true)
  })

  it('selects the fixture RPC transport under ?fixture', async () => {
    ;(globalThis as Win).location = { hostname: '127.0.0.1', search: '?fixture' }
    const handle = await mount()
    await expect(handle.rpc.call('/api', 'settings/describe', { args: {} }))
      .resolves.toMatchObject({ ok: true })
  })

  it('reports non-loopback page authority through the connection handle', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20', search: '' }
    expect((await mount()).isLoopback).toBe(false)
  })

  it('requires one generation source and ignores a stale source disposer', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const first = new GenerationProbe()
    const second = new GenerationProbe()

    expect(() => handle.start({})).toThrow('no generation source is registered')
    const unregisterFirst = handle.registerGenerationSource(first.source)
    expect(() => { handle.registerGenerationSource(second.source) })
      .toThrow('a generation source is already registered')
    unregisterFirst()
    const unregisterSecond = handle.registerGenerationSource(second.source)
    unregisterFirst()

    const loop = handle.start({})
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    unregisterSecond()
    expect(handle.generation.getSnapshot()).toBeUndefined()
    loop.stop()
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    installGeneration(handle)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const generations: Array<string | undefined> = []
    const stopThrowing = handle.generation.subscribe(() => { throw new Error('subscriber bug') })
    const stopGeneration = handle.generation.subscribe(() => {
      generations.push(handle.generation.getSnapshot()?.host.home)
    })
    expect(handle.generation.getSnapshot()).toBeUndefined()
    let connected = 0
    const loop = handle.start({ onConnected: () => { connected++ } })
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    loop.stop() // teardown must not throw; the fixture streams abort quietly
    expect(handle.generation.getSnapshot()).toBeUndefined()
    expect(generations).toEqual(['/h', undefined])
    expect(connected).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    stopThrowing()
    stopGeneration()
    errorSpy.mockRestore()
  })

  it('does not notify state subscribers when a pre-ready loop stops', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    handle.registerGenerationSource(signal => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    }))
    const listener = vi.fn()
    const unsubscribe = handle.state.subscribe(listener)
    const loop = handle.start({})

    loop.stop()

    expect(handle.state.getSnapshot()).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('allows a replacement owner and ignores the previous owner handle', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const generation = installGeneration(handle)

    const first = handle.start({})
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    first.stop()
    expect(handle.generation.getSnapshot()).toBeUndefined()

    const second = handle.start({})
    await vi.waitFor(() => {
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    })
    first.stop()
    expect(handle.generation.getSnapshot()?.host.home).toBe('/h')

    second.stop()
    generation.end()
  })

  it('lets the connection service force only its current owner to reconnect', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    installGeneration(handle)
    const requested = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({ onReconnectRequested: requested }, {
      backoffBaseMs: 60_000,
      backoffFactor: 2,
      backoffMaxMs: 120_000,
      generationReadyTimeoutMs: 500,
    })
    try {
      await vi.waitFor(() => { expect(handle.generation.getSnapshot()?.id).toBe(1) })
      handle.reconnect()
      await vi.waitFor(() => { expect(handle.generation.getSnapshot()?.id).toBe(2) })
      expect(requested).toHaveBeenCalledOnce()
      loop.stop()
      handle.reconnect()
      expect(requested).toHaveBeenCalledOnce()
    } finally {
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('ignores a non-browser window shim without navigator state', async () => {
    vi.stubGlobal('window', new EventTarget())
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    installGeneration(handle)
    const loop = handle.start({})
    try {
      await vi.waitFor(() => { expect(handle.state.getSnapshot()).toBe('connected') })
    } finally {
      loop.stop()
    }
  })

  it('feeds browser offline and online events into the owned retry loop', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const browser = new BrowserNetworkProbe()
    vi.stubGlobal('window', browser)
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    let calls = 0
    const source: ConnectionGenerationSource = (signal, ready) => new Promise<void>((resolve) => {
      calls++
      ready({ home: '/h' })
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    handle.registerGenerationSource(source)
    const states: Array<ConnectionState | undefined> = []
    const unsubscribe = handle.state.subscribe(() => { states.push(handle.state.getSnapshot()) })
    const loop = handle.start({}, {
      backoffBaseMs: 100,
      backoffFactor: 2,
      backoffMaxMs: 1_000,
      generationReadyTimeoutMs: 500,
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(handle.state.getSnapshot()).toBe('connected')
      expect(calls).toBe(1)

      browser.setOnline(false)
      expect(handle.state.getSnapshot()).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls).toBe(1)

      browser.setOnline(true)
      expect(handle.state.getSnapshot()).toBe('connecting')
      await vi.advanceTimersByTimeAsync(49)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
      expect(handle.state.getSnapshot()).toBe('connected')
      expect(states).toEqual(['connected', 'disconnected', 'connecting', 'connected'])
    } finally {
      unsubscribe()
      loop.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('does not announce a generation synchronously stopped by a generation subscriber', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    installGeneration(handle)
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let sawGeneration = false
    const stopGeneration = handle.generation.subscribe(() => {
      if (handle.generation.getSnapshot() === undefined) return
      sawGeneration = true
      owner.loop?.stop()
    })
    const connected = vi.fn()
    const loop = handle.start({ onConnected: connected })
    owner.loop = loop
    try {
      await vi.waitFor(() => { expect(sawGeneration).toBe(true) })
      expect(handle.generation.getSnapshot()).toBeUndefined()
      expect(connected).not.toHaveBeenCalled()
    } finally {
      stopGeneration()
      loop.stop()
    }
  })

  it('retracts the generation while connecting and publishes the next generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const generations: Array<string | undefined> = []
    const reconnectSnapshots: Array<string | undefined> = []
    const stopGeneration = handle.generation.subscribe(() => {
      generations.push(handle.generation.getSnapshot()?.host.home)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => {
        if (state === 'connecting') {
          reconnectSnapshots.push(handle.generation.getSnapshot()?.host.home)
        }
      },
    }, { backoffBaseMs: 10, backoffFactor: 2, backoffMaxMs: 80, generationReadyTimeoutMs: 500 })
    try {
      await vi.waitFor(() => {
        expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
      })
      generation.end()

      await vi.waitFor(() => { expect(reconnectSnapshots).toEqual([undefined]) })
      await vi.waitFor(() => { expect(generations).toEqual(['/h', undefined, '/h']) })
      expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
    } finally {
      stopGeneration()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('publishes connection state directly on the service and isolates subscribers', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const snapshots: Array<ConnectionState | undefined> = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unsubscribe = handle.state.subscribe(() => { snapshots.push(handle.state.getSnapshot()) })
    const stopThrowing = handle.state.subscribe(() => { throw new Error('state subscriber failed') })
    expect(handle.state.getSnapshot()).toBeUndefined()

    const loop = handle.start({}, {
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffMaxMs: 80,
      generationReadyTimeoutMs: 500,
    })
    try {
      await vi.waitFor(() => { expect(handle.state.getSnapshot()).toBe('connected') })
      const connected = handle.state.getSnapshot()
      expect(handle.state.getSnapshot()).toBe(connected)
      generation.end()
      await vi.waitFor(() => {
        expect(snapshots).toEqual([
          'connected',
          'connecting',
          'connected',
        ])
      })
      expect(errorSpy).toHaveBeenCalledWith('[connection] state listener threw:', expect.any(Error))
    } finally {
      unsubscribe()
      stopThrowing()
      loop.stop()
      errorSpy.mockRestore()
    }
    expect(handle.state.getSnapshot()).toBeUndefined()
  })

  it('does not announce disconnection after a generation subscriber stops the loop', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const generation = installGeneration(handle)
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let stoppedOnRetraction = false
    const stopGeneration = handle.generation.subscribe(() => {
      if (handle.generation.getSnapshot() !== undefined || owner.loop === undefined) return
      stoppedOnRetraction = true
      owner.loop.stop()
    })
    const states: ConnectionState[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => { states.push(state) },
    }, { backoffBaseMs: 10, backoffFactor: 2, backoffMaxMs: 80, generationReadyTimeoutMs: 500 })
    owner.loop = loop
    try {
      await vi.waitFor(() => {
        expect(handle.generation.getSnapshot()?.host.home).toBe('/h')
      })
      generation.end()

      await vi.waitFor(() => { expect(stoppedOnRetraction).toBe(true) })
      expect(handle.generation.getSnapshot()).toBeUndefined()
      expect(states).toEqual(['connected'])
    } finally {
      stopGeneration()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('carries RPC calls without requiring secure-context randomUUID', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        return bytes.fill(0)
      },
    })
    const handle = await mount()
    const original = globalThis.fetch
    const seen: { url: string; body: unknown }[] = []
    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const body = JSON.parse(init.body) as { rpcId: string }
      seen.push({ url, body })
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { ref: 'goal-1' } },
      })
    }
    try {
      await expect(handle.rpc.call('/api', 'goals/create', { args: { agentId: 'agent-1' } }))
        .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    } finally {
      globalThis.fetch = original
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://dsh.internal/api/goals/create')
    expect(seen[0]?.body).toMatchObject({
      type: 'client-request',
      rpcId: '00000000-0000-4000-8000-000000000000',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    })
  })

  it('exposes a worker-local Gateway stream through connection.rpc.open', async () => {
    ;(globalThis as Win).location = { hostname: 'preview.example', search: '' }
    const openStream = vi.fn<NonNullable<ClientTransportHooks['openStream']>>(
      (endpoint, payload, signal) => (async function *(): AsyncGenerator {
        signal.throwIfAborted()
        yield { endpoint, payload }
      })(),
    )
    ;(globalThis as Win).__DSH_TRANSPORT__ = {
      fetch: vi.fn<ClientTransportHooks['fetch']>(),
      openStream,
      ownsHost: true,
    }
    const handle = await mount()
    const abort = new AbortController()
    const open = handle.rpc.open
    if (open === undefined) throw new Error('worker-local stream carrier was not installed')

    const values = []
    for await (const value of open('/api', 'session/follow', { args: { sessionId: 'session-1' } }, abort.signal)) {
      values.push(value)
    }
    expect(values).toEqual([{
      endpoint: 'session/follow', payload: { args: { sessionId: 'session-1' } },
    }])
    expect(openStream).toHaveBeenCalledWith(
      'session/follow',
      { args: { sessionId: 'session-1' } },
      abort.signal,
    )
    expect(handle.isLoopback).toBe(true)
    expect(() => open('/rpc', 'session/follow', {}, abort.signal))
      .toThrow('worker-local streams require the /api channel')
    expect(() => open('/api/path', 'session/follow', {}, abort.signal))
      .toThrow('invalid RPC target')
  })

  it('validates generic RPC transport failures, correlation, and targets', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    const handle = await mount()
    const original = globalThis.fetch
    const abort = new AbortController()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    try {
      await expect(handle.rpc.call('/api', 'goals/create', {}, abort.signal))
        .rejects.toThrow('HTTP 503')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        new URL('https://harness.example/api/goals/create'),
        expect.objectContaining({ signal: abort.signal }),
      )

      ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'null' }
      globalThis.fetch = vi.fn().mockResolvedValue(Response.json({
        type: 'server-response',
        rpcId: 'different-rpc',
        result: { ok: true, value: null },
      }))
      await expect(handle.rpc.call('/api', 'goals/create', {})).rejects.toThrow('rpcId mismatch')
      const fetch = vi.mocked(globalThis.fetch)
      expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('http://dsh.internal/api/goals/create'))
      expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('signal')

      const respond = (result: unknown): void => {
        globalThis.fetch = async (_input: URL | RequestInfo, init?: RequestInit) => {
          if (typeof init?.body !== 'string') throw new TypeError('expected a JSON request body')
          const request = JSON.parse(init.body) as { rpcId: string }
          return Response.json({ type: 'server-response', rpcId: request.rpcId, result })
        }
      }
      for (const envelope of [
        null,
        { type: 'other', rpcId: 'rpc', result: { ok: true } },
        { type: 'server-response', rpcId: 1, result: { ok: true } },
      ]) {
        globalThis.fetch = vi.fn().mockResolvedValue(Response.json(envelope))
        await expect(handle.rpc.call('/api', 'goals/create', {}))
          .rejects.toThrow('invalid server-response envelope')
      }

      respond(null)
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')
      respond({ ok: 'yes' })
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')
      respond({ ok: false, error: null })
      await expect(handle.rpc.call('/api', 'goals/create', {}))
        .rejects.toThrow('invalid server-response result')

      for (const error of [
        { code: 1, message: 'failed', details: {} },
        { code: 'failed', message: 1, details: {} },
        { code: 'failed', message: 'failed', details: [] },
      ]) {
        respond({ ok: false, error })
        await expect(handle.rpc.call('/api', 'goals/create', {}))
          .rejects.toThrow('invalid server-response failure')
      }
      respond({
        ok: false,
        error: { code: 'fixture-failed', message: 'fixture rejected the call', details: { retry: false } },
      })
      await expect(handle.rpc.call('/api', 'goals/create', {})).resolves.toEqual({
        ok: false,
        error: { code: 'fixture-failed', message: 'fixture rejected the call', details: { retry: false } },
      })
    } finally {
      globalThis.fetch = original
    }

    for (const [channel, endpoint] of [
      ['api2', 'goals/create'],
      ['/api/path', 'goals/create'],
      ['/api', ''],
      ['/api', '.'],
      ['/api', '..'],
      ['/api', 'goals//create'],
      ['/api', 'goals/create?unsafe'],
    ] as const) {
      await expect(handle.rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })

  it('carries Goal Remotes over the client-only fixture state', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const created = await handle.rpc.call('/api', 'goals/create', {
      args: { agentId: 'fx-alpha', request: { objective: 'fixture remote' } },
    })
    expect(created).toMatchObject({ ok: true, value: { ref: { revision: 1 } } })
    if (!created.ok) throw new Error('fixture Goal create failed')
    const ref = (created.value as { ref: { id: string; revision: number } }).ref
    const edited = await handle.rpc.call('/api', 'goals/edit', {
      args: { agentId: 'fx-alpha', ref, request: { objective: 'edited fixture remote' } },
    })
    expect(edited).toMatchObject({ ok: true, value: { objective: 'edited fixture remote', revision: 2 } })
    const editedRef = { id: ref.id, revision: 2 }
    const paused = await handle.rpc.call('/api', 'goals/pause', {
      args: { agentId: 'fx-alpha', ref: editedRef },
    })
    expect(paused).toMatchObject({ ok: true, value: { phase: 'paused', activation: 'disarmed', revision: 3 } })
    const resumed = await handle.rpc.call('/api', 'goals/resume', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 3 } },
    })
    expect(resumed).toMatchObject({ ok: true, value: { phase: 'active', activation: 'armed', revision: 4 } })
    const completed = await handle.rpc.call('/api', 'goals/complete', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 4 } },
    })
    expect(completed).toMatchObject({ ok: true, value: { phase: 'complete', activation: 'disarmed', revision: 5 } })
    await expect(handle.rpc.call('/api', 'goals/clear', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 5 } },
    })).resolves.toEqual({ ok: true, value: { id: ref.id, revision: 6 } })
    await expect(handle.rpc.call('/other', 'goals/create', {})).rejects.toThrow(/channel.*unavailable/)
    await expect(handle.rpc.call('/api', 'unknown/read', { args: { agentId: 'fx-alpha' } }))
      .rejects.toThrow(/endpoint.*unavailable/)
  })
})
