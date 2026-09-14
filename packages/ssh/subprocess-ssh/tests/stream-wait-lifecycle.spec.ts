/** Caller-owned stream closure and bounded observations across remote allocation. */
import { duplexPair, type Duplex } from 'node:stream'
import { getEventListeners } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SshSubprocessRuntime } from '../src/index.ts'

type Stage = 'prepare' | 'connect' | 'start' | 'wait' | 'terminate'
const id = '8fbfb59c-fbce-44f7-bd87-5ab5a0ea02aa'
const spec: SubprocessSpawnSpec = {
  argv: ['node'], cwd: '/workspace', graceMs: 5,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
}
const finishedValue = { outcome: { exitCode: 0, signal: null }, spills: {}, collected: {} }

async function setup(options: { pause?: Stage; failStart?: Error; failWait?: Error; failTerminate?: Error } = {}) {
  const ctx = new Context()
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<typeof finishedValue>()
  const peers = new Map<string, { host: Duplex; remote: Duplex }>()
  const calls: string[] = []
  const errors: unknown[] = []
  ctx.logger.error = ((error: unknown) => { errors.push(error) }) as typeof ctx.logger.error
  const stage = async (name: Stage, signal?: AbortSignal) => {
    if (options.pause !== name) { signal?.throwIfAborted(); return }
    entered.resolve(undefined)
    signal?.throwIfAborted()
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => { cancelled.reject(new Error('SSH operation cancelled')) }
    signal?.addEventListener('abort', abort, { once: true })
    try { await Promise.race([gate.promise, cancelled.promise]) }
    finally { signal?.removeEventListener('abort', abort) }
  }
  const connection = {
    request: async <T>(method: string, _params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> => {
      calls.push(method)
      let value: unknown
      if (method === 'process.prepare') {
        await stage('prepare', signal)
        value = { id, streams: {
          stdout: { path: '/tmp/stdout', capability: 'a'.repeat(64) },
          stderr: { path: '/tmp/stderr', capability: 'b'.repeat(64) },
        } }
      } else if (method === 'process.start') {
        await stage('start', signal)
        if (options.failStart !== undefined) throw options.failStart
        started.resolve(undefined)
        value = {}
      } else if (method === 'process.done') value = await finished.promise
      else if (method === 'process.wait') {
        await stage('wait', signal)
        if (options.failWait !== undefined) throw options.failWait
        value = true
      } else if (method === 'process.terminate') {
        await stage('terminate', signal)
        if (options.failTerminate !== undefined) throw options.failTerminate
        value = null
      } else throw new Error(`Unexpected request ${method}`)
      return schema.parse(value)
    },
    connectStream: async (endpoint: { path: string }, signal?: AbortSignal) => {
      await stage('connect', signal)
      const [host, remote] = duplexPair({ allowHalfOpen: true })
      host.on('error', () => {})
      remote.on('error', () => {})
      peers.set(endpoint.path, { host, remote })
      return host
    },
    dispose: () => Promise.resolve(),
  }
  ctx.provide('ssh', connection as never)
  const fiber = await ctx.plugin(SshSubprocessRuntime)
  onTestFinished(async () => {
    gate.resolve(undefined)
    finished.resolve(finishedValue)
    for (const peer of peers.values()) { peer.host.destroy(); peer.remote.destroy() }
    await fiber.dispose()
    if (options.failTerminate === undefined) expect(errors).toEqual([])
  })
  const peer = (name: string) => {
    const entry = peers.get(`/tmp/${name}`)
    if (entry === undefined) throw new Error('transport was not allocated')
    return entry
  }
  return { runtime: ctx.subprocess, calls, peer, entered: entered.promise, started: started.promise,
    release: () => { gate.resolve(undefined) }, finished }
}

describe('SSH public output streams', () => {
  it.each(['stdout', 'stderr'] as const)('closes only the matching transport when %s is destroyed', async (name) => {
    const test = await setup()
    const handle = test.runtime.spawn(spec)
    await test.started
    handle[name]!.destroy()
    await new Promise(resolve => setImmediate(resolve))
    expect(test.peer(name).host.destroyed).toBe(true)
    const other = name === 'stdout' ? 'stderr' : 'stdout'
    expect(test.peer(other).host.destroyed).toBe(false)
    expect(test.calls).not.toContain('process.terminate')
  })

  it.each(['stdout', 'stderr'] as const)('remembers %s closure before remote allocation finishes', async (name) => {
    const test = await setup({ pause: 'prepare' })
    const handle = test.runtime.spawn(spec)
    await test.entered
    handle[name]!.destroy()
    test.release()
    await test.started
    expect(test.peer(name).host.destroyed).toBe(true)
    expect(test.peer(name === 'stdout' ? 'stderr' : 'stdout').host.destroyed).toBe(false)
  })
})

describe('SSH range-observation cancellation', () => {
  it.each(['prepare', 'connect', 'start', 'wait', 'terminate'] as const)('bounds the whole observation while %s is pending', async (pause) => {
    const test = await setup({ pause })
    const handle = test.runtime.spawn(spec)
    if (pause === 'terminate') { await test.started; handle.terminate() }
    const controller = new AbortController()
    let settled = false
    const observed = handle.waitForExit(controller.signal).then(
      value => ({ value }), (error: unknown) => ({ error }),
    ).finally(() => { settled = true })
    await test.entered
    controller.abort('wait deadline')
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(true)
    expect(await observed).toEqual({ value: false })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    if (pause !== 'terminate') expect(test.calls).not.toContain('process.terminate')
    test.release()
    expect(await handle.waitForExit()).toBe(true)
  })

  it('bounds termination after failed startup while retaining real termination failure', async () => {
    const cleanup = new Error('range owner unavailable')
    const test = await setup({ pause: 'terminate', failStart: new Error('start refused'), failTerminate: cleanup })
    const handle = test.runtime.spawn(spec)
    const controller = new AbortController()
    let settled = false
    const observed = handle.waitForExit(controller.signal).then(
      value => ({ value }), (error: unknown) => ({ error }),
    ).finally(() => { settled = true })
    await test.entered
    controller.abort()
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(true)
    expect(await observed).toEqual({ value: false })
    test.release()
    await expect(handle.waitForExit()).rejects.toBe(cleanup)
  })

  it('returns false for a pre-aborted live observation and true once quiescence is known', async () => {
    const test = await setup({ pause: 'prepare' })
    const handle = test.runtime.spawn(spec)
    const signal = AbortSignal.abort()
    let settled = false
    const observed = handle.waitForExit(signal).then(
      value => ({ value }), (error: unknown) => ({ error }),
    ).finally(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(true)
    expect(await observed).toEqual({ value: false })
    test.release()
    expect(await handle.waitForExit()).toBe(true)
    expect(await handle.waitForExit(signal)).toBe(true)
  })

  it('preserves real observation failure and detaches the caller cancellation listener', async () => {
    const failure = new Error('remote range observation failed')
    const test = await setup({ failWait: failure })
    const handle = test.runtime.spawn(spec)
    await test.started
    const controller = new AbortController()
    await expect(handle.waitForExit(controller.signal)).rejects.toBe(failure)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('returns true when an uncancelled bounded observation completes', async () => {
    const test = await setup()
    const handle = test.runtime.spawn(spec)
    const controller = new AbortController()
    expect(await handle.waitForExit(controller.signal)).toBe(true)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
