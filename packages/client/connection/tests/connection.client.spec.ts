/** Connection generation readiness, loss, retry, and sink isolation. */

import { describe, expect, it, vi } from 'vitest'
import type { ConnectionGenerationSource, ConnectionState } from '../src/client/connection.ts'
import { ConnectionController } from '../src/client/connection.ts'
import { FakeGenerationSource } from './fake-generation.client.ts'

const FAST = { backoffBaseMs: 10, backoffFactor: 2, backoffMaxMs: 80, generationReadyTimeoutMs: 500 }

describe('connection lifecycle', () => {
  it('announces connected with the Host facts from generation readiness', async () => {
    const source = new FakeGenerationSource()
    const homes: string[] = []
    const controller = new ConnectionController(source.source, {
      onConnected: (host) => { homes.push(host.home) },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(homes).toEqual(['/h']) })
    } finally {
      controller.stop()
    }
  })

  it('reconnects with a fresh generation when its source fails, and stop() ends the loop', async () => {
    const source = new FakeGenerationSource()
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(source.source, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      source.fail(new Error('stream torn'))
      await vi.waitFor(() => { expect(connected).toBe(2) })
      expect(source.activeCount).toBe(1)
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
    await vi.waitFor(() => { expect(source.activeCount).toBe(0) })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(source.activeCount).toBe(0)
  })

  it('keeps retrying at the jittered cap and recovers after a prolonged outage', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reconnectRequested = vi.fn()
    let calls = 0
    let available = false
    const states: ConnectionState[] = []
    const source: ConnectionGenerationSource = (signal, ready) => {
      calls++
      if (!available) return Promise.reject(new Error('offline'))
      ready({ home: '/h' })
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const controller = new ConnectionController(source, {
      onReconnectRequested: reconnectRequested,
      onStateChange: state => states.push(state),
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      expect(states).toEqual(['connecting'])

      for (const [attempt, delay] of [250, 500, 1_000, 2_000, 4_000, 5_000].entries()) {
        await vi.advanceTimersByTimeAsync(delay)
        expect(calls).toBe(attempt + 2)
      }

      expect(reconnectRequested).toHaveBeenCalledTimes(6)
      expect(warnSpy).toHaveBeenCalledTimes(6)
      expect(warnSpy).toHaveBeenLastCalledWith('[connection] connection lost, retry #6')
      expect(states).toEqual(['connecting'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(19)
      available = true
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls).toBe(20)
      expect(states).toEqual(['connecting', 'connected'])
      expect(reconnectRequested).toHaveBeenCalledTimes(19)
    } finally {
      controller.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('continues retrying at a fixed cap when the growth factor is one', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const states: ConnectionState[] = []
    let calls = 0
    const controller = new ConnectionController(() => {
      calls++
      return Promise.reject(new Error('offline'))
    }, {
      onStateChange: state => states.push(state),
    }, {
      backoffBaseMs: 10,
      backoffFactor: 1,
      backoffMaxMs: 80,
      generationReadyTimeoutMs: 500,
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(5)
      expect(calls).toBe(2)
      expect(states).toEqual(['connecting'])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toBe(202)
    } finally {
      controller.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('interrupts the retry delay when a reconnect is requested', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reconnectRequested = vi.fn()
    let calls = 0
    const source: ConnectionGenerationSource = (signal, ready) => {
      calls++
      if (calls === 1) return Promise.reject(new Error('offline'))
      ready({ home: '/h' })
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const controller = new ConnectionController(source, { onReconnectRequested: reconnectRequested })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      controller.reconnect()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(2)
      expect(reconnectRequested).toHaveBeenCalledOnce()
    } finally {
      controller.stop()
      controller.reconnect()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('pauses retries while offline and restarts the base delay after each recovery', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const states: ConnectionState[] = []
    let calls = 0
    let active = 0
    let maxActive = 0
    const source: ConnectionGenerationSource = (signal, ready) => new Promise<void>((resolve) => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      ready({ home: '/h' })
      signal.addEventListener('abort', () => {
        active--
        resolve()
      }, { once: true })
    })
    const controller = new ConnectionController(source, {
      onStateChange: state => states.push(state),
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      expect(states).toEqual(['connected'])

      controller.setNetworkAvailable(false)
      controller.setNetworkAvailable(false)
      expect(states.at(-1)).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
      expect(active).toBe(0)

      controller.setNetworkAvailable(true)
      controller.setNetworkAvailable(true)
      expect(states.at(-1)).toBe('connecting')
      await vi.advanceTimersByTimeAsync(125)
      controller.setNetworkAvailable(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)

      controller.setNetworkAvailable(true)
      await vi.advanceTimersByTimeAsync(249)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
      expect(active).toBe(1)
      expect(maxActive).toBe(1)
      expect(states).toEqual([
        'connected',
        'disconnected',
        'connecting',
        'disconnected',
        'connecting',
        'connected',
      ])
      expect(warnSpy).toHaveBeenCalledOnce()
      expect(warnSpy).toHaveBeenCalledWith('[connection] connection lost, retry #1')
    } finally {
      controller.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stops an offline wait when its state sink stops the controller synchronously', async () => {
    const source = vi.fn<ConnectionGenerationSource>(() => Promise.resolve())
    const controller = new ConnectionController(source, {
      onStateChange: () => { controller.stop() },
    })
    controller.setNetworkAvailable(false)
    controller.start()
    await Promise.resolve()
    expect(source).not.toHaveBeenCalled()
  })

  it('allows one manual attempt while offline without starting automatic retries', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const states: ConnectionState[] = []
    let calls = 0
    const controller = new ConnectionController(() => {
      calls++
      return Promise.reject(new Error('offline'))
    }, {
      onStateChange: state => states.push(state),
    })
    controller.setNetworkAvailable(false)
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(states).toEqual(['disconnected'])
      expect(calls).toBe(0)

      controller.reconnect()
      expect(states.at(-1)).toBe('connecting')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      expect(states.at(-1)).toBe('disconnected')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
    } finally {
      controller.stop()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not delay a reconnect requested synchronously from the connecting state sink', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    let restart = true
    const controller = new ConnectionController(() => {
      calls++
      return Promise.reject(new Error('offline'))
    }, {
      onStateChange: (state) => {
        if (state !== 'connecting' || !restart) return
        restart = false
        controller.reconnect()
      },
    }, {
      backoffBaseMs: 10,
      backoffFactor: 2,
      backoffMaxMs: 10,
      generationReadyTimeoutMs: 500,
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(2)
      expect(warnSpy.mock.calls.map(([message]) => String(message))).toEqual([
        '[connection] connection lost, retry #1',
      ])
    } finally {
      controller.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([
    {
      label: 'manual reconnect',
      stopState: 'connecting' as const,
      interrupt: (controller: ConnectionController) => { controller.reconnect() },
    },
    {
      label: 'browser going offline',
      stopState: 'disconnected' as const,
      interrupt: (controller: ConnectionController) => { controller.setNetworkAvailable(false) },
    },
  ])('honors a synchronous stop from the $label state sink', async ({ stopState, interrupt }) => {
    const source = new FakeGenerationSource()
    const controller = new ConnectionController(source.source, {
      onStateChange: (state) => {
        if (state === stopState) controller.stop()
      },
    }, FAST)
    controller.start()
    await vi.waitFor(() => { expect(source.activeCount).toBe(1) })
    interrupt(controller)
    await vi.waitFor(() => { expect(source.activeCount).toBe(0) })
  })

  it('stops when the physical-reconnect sink disposes the controller', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    const reconnectRequested = vi.fn()
    const controller = new ConnectionController(() => {
      calls++
      return Promise.reject(new Error('offline'))
    }, {
      onReconnectRequested: () => {
        reconnectRequested()
        controller.stop()
      },
    }, FAST)
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(5)
      expect(calls).toBe(1)
      expect(reconnectRequested).toHaveBeenCalledOnce()
    } finally {
      controller.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stops before opening a retry when the connecting state sink disposes the controller', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    const controller = new ConnectionController(() => {
      calls++
      return Promise.reject(new Error('offline'))
    }, {
      onStateChange: (state) => {
        if (state === 'connecting') controller.stop()
      },
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      controller.stop()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('restarts an active retry immediately and resets its attempt number', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reconnectRequested = vi.fn()
    const states: ConnectionState[] = []
    let calls = 0
    const source: ConnectionGenerationSource = (signal) => {
      calls++
      if (calls <= 2) return Promise.reject(new Error('offline'))
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const controller = new ConnectionController(source, {
      onReconnectRequested: reconnectRequested,
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(20)
      expect(calls).toBe(3)
      expect(states.at(-1)).toBe('connecting')

      controller.reconnect()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(4)
      expect(states.at(-1)).toBe('connecting')
      expect(reconnectRequested).toHaveBeenCalledTimes(3)
      expect(warnSpy.mock.calls.map(([message]) => String(message))).toEqual([
        '[connection] connection lost, retry #1',
        '[connection] connection lost, retry #2',
        '[connection] connection lost, retry #1',
      ])
    } finally {
      controller.stop()
      randomSpy.mockRestore()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stops while an automatic retry delay is pending', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let calls = 0
    const controller = new ConnectionController(() => {
      calls++
      return Promise.reject(new Error('offline'))
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toBe(1)
      controller.stop()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls).toBe(1)
    } finally {
      controller.stop()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('replaces an active generation immediately when reconnect is requested', async () => {
    const source = new FakeGenerationSource()
    const reconnectRequested = vi.fn()
    let connected = 0
    const controller = new ConnectionController(source.source, {
      onConnected: () => { connected++ },
      onReconnectRequested: reconnectRequested,
    }, { backoffBaseMs: 60_000, backoffFactor: 2, backoffMaxMs: 120_000, generationReadyTimeoutMs: 500 })
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      controller.reconnect()
      await vi.waitFor(() => { expect(connected).toBe(2) })
      expect(reconnectRequested).toHaveBeenCalledOnce()
      expect(source.activeCount).toBe(1)
    } finally {
      controller.stop()
    }
  })

  it('isolates a connected sink exception from the generation', async () => {
    const source = new FakeGenerationSource()
    let connected = 0
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new ConnectionController(source.source, {
      onConnected: () => {
        connected++
        throw new Error('business layer bug')
      },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(source.activeCount).toBe(1)
      expect(errorSpy).toHaveBeenCalledWith('[connection] connection sink threw:', expect.any(Error))
    } finally {
      controller.stop()
      errorSpy.mockRestore()
    }
  })

  it('holds onConnected until the incremental source reports ready', async () => {
    const source = new FakeGenerationSource()
    source.holdReady = true
    let connected = 0
    const controller = new ConnectionController(source.source, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(source.activeCount).toBe(1) })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(connected).toBe(0)
      source.releaseReady()
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
    }
  })

  it('accepts only the first readiness report from one generation', async () => {
    const homes: string[] = []
    const source: ConnectionGenerationSource = (signal, ready) => {
      ready({ home: '/first' })
      ready({ home: '/duplicate' })
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const controller = new ConnectionController(source, {
      onConnected: (host) => { homes.push(host.home) },
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(homes).toEqual(['/first']) })
    } finally {
      controller.stop()
    }
  })

  it('does not announce readiness after a stop queued from the ready callback', async () => {
    const owner: { controller?: ConnectionController } = {}
    let sourceCalls = 0
    const connected = vi.fn()
    const source: ConnectionGenerationSource = (signal, ready) => new Promise<void>((resolve) => {
      sourceCalls++
      ready({ home: '/h' })
      queueMicrotask(() => { owner.controller?.stop() })
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    const controller = new ConnectionController(source, { onConnected: connected }, FAST)
    owner.controller = controller
    controller.start()
    await vi.waitFor(() => { expect(sourceCalls).toBe(1) })
    expect(connected).not.toHaveBeenCalled()
  })

  it('rejects a generation whose source ends during readiness and retries', async () => {
    const source = new FakeGenerationSource()
    source.holdReady = true
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(source.source, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(source.activeCount).toBe(1) })
      source.holdReady = false
      source.end()
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['connecting', 'connected'])
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it.each([
    { label: 'ends normally', fail: () => Promise.resolve() },
    {
      label: 'rejects with a non-Error reason',
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test
      fail: () => Promise.reject('fixture offline'),
    },
  ])('retries when the generation source $label before reporting ready', async ({ fail }) => {
    let sourceCalls = 0
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const source: ConnectionGenerationSource = (signal, ready) => {
      sourceCalls++
      if (sourceCalls === 1) return fail()
      ready({ home: '/h' })
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const controller = new ConnectionController(source, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(sourceCalls).toBe(2) })
      await vi.waitFor(() => { expect(connected).toBe(1) })
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('accepts a slow Host after the warning and clears both readiness timers', async () => {
    vi.useFakeTimers()
    const source = new FakeGenerationSource()
    source.holdReady = true
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(
      source.source,
      { onConnected: () => { connected++ } },
      { ...FAST, generationReadyWarnMs: 20, generationReadyTimeoutMs: 100 },
    )
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(source.activeCount).toBe(1)
      await vi.advanceTimersByTimeAsync(20)
      expect(connected).toBe(0)
      expect(source.activeCount).toBe(1)
      expect(warnSpy).toHaveBeenCalledWith('[connection] generation is still not ready after 20ms')
      source.releaseReady()
      await vi.advanceTimersByTimeAsync(100)
      expect(connected).toBe(1)
      expect(source.activeCount).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      controller.stop()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([20, 100, 200])('cancels an unready generation with warn=%i ms, waits for cleanup, and ignores late ready', async (generationReadyWarnMs) => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const cleanup = Promise.withResolvers<undefined>()
    const signals: AbortSignal[] = []
    const report: Array<(host: { home: string }) => void> = []
    const connected = vi.fn()
    const states: ConnectionState[] = []
    const source: ConnectionGenerationSource = async (signal, ready) => {
      signals.push(signal)
      report.push(ready)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      await cleanup.promise
    }
    const controller = new ConnectionController(source, {
      onConnected: connected,
      onStateChange: state => states.push(state),
    }, { ...FAST, generationReadyWarnMs, generationReadyTimeoutMs: 100 })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(100)
      expect(signals[0]?.aborted).toBe(true)
      expect(signals[0]?.reason).toMatchObject({ message: 'connection generation was not ready within 100ms' })
      const warnings = generationReadyWarnMs <= 100
        ? [[`[connection] generation is still not ready after ${String(generationReadyWarnMs)}ms`]]
        : []
      warnings.push(['[connection] connection generation was not ready within 100ms; cancelling generation'])
      expect(warnSpy.mock.calls).toEqual(warnings)
      report[0]!({ home: '/stale' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(signals).toHaveLength(1)
      expect(connected).not.toHaveBeenCalled()
      expect(warnSpy.mock.calls).toEqual(warnings)
      cleanup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(5)
      expect(signals).toHaveLength(2)
      report[1]!({ home: '/fresh' })
      await vi.advanceTimersByTimeAsync(0)
      expect(connected).toHaveBeenCalledExactlyOnceWith({ home: '/fresh' })
      expect(states).toEqual(['connecting', 'connected'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.stop()
      cleanup.resolve(undefined)
      await vi.advanceTimersByTimeAsync(0)
      randomSpy.mockRestore()
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each(['stop', 'reconnect', 'failure'] as const)('clears a pending handshake deadline on %s', async (action) => {
    vi.useFakeTimers()
    const source = new FakeGenerationSource()
    source.holdReady = true
    const connected = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(source.source, { onConnected: connected }, {
      ...FAST, generationReadyWarnMs: 20, generationReadyTimeoutMs: 100,
    })
    controller.start()
    try {
      await vi.advanceTimersByTimeAsync(10)
      source.holdReady = false
      if (action === 'failure') source.fail(new Error('carrier failed'))
      else controller[action]()
      await vi.advanceTimersByTimeAsync(0)
      source.releaseReady()
      await vi.advanceTimersByTimeAsync(200)
      expect(source.activeCount).toBe(action === 'stop' ? 0 : 1)
      expect(connected).toHaveBeenCalledTimes(action === 'stop' ? 0 : 1)
      expect(vi.getTimerCount()).toBe(0)
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes('still not ready'))).toBe(false)
      expect(warnSpy.mock.calls.some(([message]) => String(message).includes('cancelling generation'))).toBe(false)
    } finally {
      controller.stop()
      await vi.advanceTimersByTimeAsync(0)
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('emits the disconnected, retry-attempt, and connected transitions', async () => {
    const source = new FakeGenerationSource()
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const controller = new ConnectionController(source.source, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['connected'])
      source.fail(new Error('torn'))
      await vi.waitFor(() => { expect(connected).toBe(2) })
      expect(states).toEqual(['connected', 'connecting', 'connected'])
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('does not announce a generation stopped synchronously by its connected state sink', async () => {
    const source = new FakeGenerationSource()
    const states: ConnectionState[] = []
    let connected = 0
    const controller = new ConnectionController(source.source, {
      onConnected: () => { connected++ },
      onStateChange: (state) => {
        states.push(state)
        if (state === 'connected') controller.stop()
      },
    }, FAST)

    controller.start()
    await vi.waitFor(() => { expect(states).toEqual(['connected']) })
    await vi.waitFor(() => { expect(source.activeCount).toBe(0) })
    expect(connected).toBe(0)
  })

  it('keeps one connecting state across consecutive retry attempts', async () => {
    let sourceCalls = 0
    const states: ConnectionState[] = []
    let connected = 0
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const source: ConnectionGenerationSource = (signal, ready) => {
      sourceCalls++
      if (sourceCalls <= 2) return Promise.reject(new Error('down'))
      ready({ home: '/h' })
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    const controller = new ConnectionController(source, {
      onConnected: () => { connected++ },
      onStateChange: state => states.push(state),
    }, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(sourceCalls).toBe(3) })
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(states).toEqual(['connecting', 'connected'])
    } finally {
      controller.stop()
      warnSpy.mockRestore()
    }
  })

  it('runs with no sinks at all', async () => {
    const source = new FakeGenerationSource()
    const controller = new ConnectionController(source.source, {}, FAST)
    controller.start()
    try {
      await vi.waitFor(() => { expect(source.activeCount).toBe(1) })
    } finally {
      controller.stop()
    }
  })

  it('start() is idempotent', async () => {
    const source = new FakeGenerationSource()
    let connected = 0
    const controller = new ConnectionController(source.source, { onConnected: () => { connected++ } }, FAST)
    controller.start()
    controller.start()
    try {
      await vi.waitFor(() => { expect(connected).toBe(1) })
      expect(source.activeCount).toBe(1)
    } finally {
      controller.stop()
    }
  })
})
