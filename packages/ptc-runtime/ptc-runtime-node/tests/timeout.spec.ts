import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { fakeChild, NO_INITIAL_FRAME } from './fake-child.ts'
import { mountRuntime } from './setup.ts'
import type { Config } from '../src/config.ts'
import { encodePtcJsonWire } from '../src/json-wire.ts'

describe.each([false, true])('deadline reporting with retained state %s', (retained) => {
  async function setup() {
    const ctx = new Context()
    const { runtime } = await mountRuntime(ctx, { executionMode: 'vm-script', scriptPersistence: retained, timeoutMs: 100 })
    const controller = new AbortController()
    const request: PtcRunRequest = { program: 'while (true) {}', bindings: [], stateOwner: {}, signal: controller.signal }
    return { controller, ...fakeChild(ctx, runtime, request), request }
  }

  const cleared = retained ? '; retained variables were cleared' : ''

  it('expires during executable lookup without starting code or returning before setup settles', async () => {
    const h = await setup()
    const lookup = Promise.withResolvers<string>()
    h.resolveExecutable.mockReturnValue(lookup.promise)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = h.start(h.request, NO_INITIAL_FRAME)
    try {
      const settled = vi.fn()
      void run.then(settled)
      await vi.advanceTimersByTimeAsync(100)
      expect(settled).not.toHaveBeenCalled()
      lookup.resolve(process.execPath)
      expect(await run).toMatchObject({ output: [], error: { kind: 'timeout', message: `execution timed out before code started (100ms)${cleared}` } })
      expect(h.spawn).not.toHaveBeenCalled()
    } finally {
      h.controller.abort('test cleanup')
      lookup.resolve(process.execPath)
      await run
      vi.useRealTimers()
    }
  })

  it('expires before readiness without dispatching code and retains startup output', async () => {
    const h = await setup()
    const spawned = Promise.withResolvers<undefined>()
    h.spawn.mockImplementation(() => { spawned.resolve(undefined); return h.handle })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = h.start(h.request, NO_INITIAL_FRAME)
    try {
      await spawned.promise
      h.stderr.write('startup diagnostic')
      await vi.advanceTimersByTimeAsync(100)
      expect(await run).toMatchObject({ output: [{ type: 'text', text: 'startup diagnostic' }], error: { kind: 'timeout', message: `execution timed out before code started (100ms)${cleared}` } })
      expect(h.messages).not.toContainEqual(expect.objectContaining({ m: 'run' }))
      expect(h.terminate).toHaveBeenCalledOnce()
      expect(h.waitForExit).toHaveBeenCalledOnce()
    } finally {
      h.controller.abort('test cleanup')
      await run
      vi.useRealTimers()
    }
  })

  it('retains output and waits for interruption or process cleanup', async () => {
    const h = await setup()
    const booted = Promise.withResolvers<undefined>()
    const exited = Promise.withResolvers<boolean>()
    h.onBoot(() => { h.emit({ t: 'q', m: 'log', a: ['partial output'] }); booted.resolve(undefined) })
    h.waitForExit.mockReturnValue(exited.promise)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const run = h.start()
    try {
      await booted.promise
      const settled = vi.fn()
      void run.then(settled)
      await vi.advanceTimersByTimeAsync(100)
      if (retained) {
        expect(h.terminate).not.toHaveBeenCalled()
        expect(h.messages).toContainEqual({ t: 'q', m: 'revoke', a: [] })
        expect(settled).not.toHaveBeenCalled()
        h.complete({})
      } else {
        expect(h.terminate).toHaveBeenCalledOnce()
        expect(settled).not.toHaveBeenCalled()
        exited.resolve(true)
      }
      const suffix = retained ? '; retained variables were preserved' : ''
      expect(await run).toMatchObject({ output: [{ type: 'text', text: 'partial output' }], error: { kind: 'timeout', message: `execution timed out during execution (100ms)${suffix}` } })
    } finally {
      h.controller.abort('test cleanup')
      exited.resolve(true)
      await run
      vi.useRealTimers()
    }
  })
})

function requestId(messages: unknown[], method: string): string {
  const message = messages.findLast(value => typeof value === 'object' && value !== null && 'm' in value && value.m === method)
  if (!message || typeof message !== 'object' || !('i' in message) || typeof message.i !== 'string') throw new Error(`missing ${method} request`)
  return message.i
}

async function retainedChild(config: Config = {}) {
  const ctx = new Context()
  const { runtime } = await mountRuntime(ctx, { executionMode: 'vm-script', scriptPersistence: true, timeoutMs: 100, stopGraceMs: 50, ...config })
  const controller = new AbortController()
  const request = { program: 'while (true) {}', bindings: [], stateOwner: {}, signal: controller.signal }
  const h = fakeChild(ctx, runtime, request)
  const booted = Promise.withResolvers<undefined>()
  h.onBoot(() => { booted.resolve(undefined) })
  return { ...h, ctx, runtime, request, booted, controller }
}

describe.each(['timeout', 'abort'] as const)('retained %s', (action) => {
  it.each(['missing completion', 'rejection', 'malformed completion'] as const)('terminates after %s and recreates the environment', async (failure) => {
    const h = await retainedChild()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = h.start()
      await h.booted.promise
      if (action === 'timeout') await vi.advanceTimersByTimeAsync(100)
      else { h.controller.abort(); await vi.advanceTimersByTimeAsync(0) }
      const runId = requestId(h.messages, 'run')
      expect(h.messages).toContainEqual({ t: 'q', m: 'revoke', a: [] })
      expect(h.terminate).not.toHaveBeenCalled()
      if (failure === 'rejection') h.emit({ t: 's', i: runId, e: { message: 'stop failed' } })
      else if (failure === 'malformed completion') h.complete(null)
      else {
        await vi.advanceTimersByTimeAsync(49)
        expect(h.terminate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
      }
      const result = await pending
      expect(result.error?.kind).toBe(action)
      expect(result.error?.message).toContain('retained variables were cleared')
      expect(h.terminate).toHaveBeenCalledOnce()
      expect(h.waitForExit).toHaveBeenCalledOnce()
      const replacement = fakeChild(h.ctx, h.runtime, { ...h.request, signal: new AbortController().signal })
      replacement.onBoot(() => { replacement.complete({}) })
      expect((await replacement.start()).error).toBeUndefined()
      expect(replacement.spawn).toHaveBeenCalledTimes(2)
    } finally { await h.runtime.release(h.request.stateOwner); vi.useRealTimers() }
  })

  it('rejects queued activity after revocation and waits for the original run without terminating the process', async () => {
    const h = await retainedChild()
    const binding = vi.fn(async () => 42)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = h.start({ ...h.request, bindings: [{ global: 'tools', functions: { value: binding } }] })
      const settled = vi.fn()
      void pending.then(settled)
      await h.booted.promise
      if (action === 'timeout') await vi.advanceTimersByTimeAsync(100)
      else { h.controller.abort(); await vi.advanceTimersByTimeAsync(0) }
      expect(settled).not.toHaveBeenCalled()
      h.emit({ t: 'q', m: 'log', a: ['queued output'] })
      h.emit({ t: 'q', i: 'queued', m: 'invoke', a: ['tools', 'value', encodePtcJsonWire(null)] })
      await vi.advanceTimersByTimeAsync(0)
      expect(binding).not.toHaveBeenCalled()
      expect(h.messages).toContainEqual({ t: 's', i: 'queued', e: { message: 'PTC evaluation ended before the binding completed' } })
      h.complete({})
      expect((await pending).error?.message).toContain('retained variables were preserved')
      expect((await pending).output.filter(block => block.type === 'text').map(block => block.text)).toEqual([])
      await vi.advanceTimersByTimeAsync(100)
      expect(h.terminate).not.toHaveBeenCalled()
    } finally { await h.runtime.release(h.request.stateOwner); vi.useRealTimers() }
  })

})

it('rejects overlapping runs until fallback process cleanup completes', async () => {
  const h = await retainedChild()
  const exited = Promise.withResolvers<boolean>()
  h.waitForExit.mockReturnValue(exited.promise)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = h.start()
    const settled = vi.fn()
    void pending.then(settled)
    await h.booted.promise
    await vi.advanceTimersByTimeAsync(150)
    expect(h.terminate).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()
    await expect(h.runtime.run(h.runtime.resolve(h.request))).rejects.toThrow('concurrent runs')
    expect(h.spawn).toHaveBeenCalledOnce()
    exited.resolve(true)
    expect((await pending).error?.kind).toBe('timeout')
    const replacement = fakeChild(h.ctx, h.runtime, h.request)
    replacement.onBoot(() => { replacement.complete({}) })
    expect((await replacement.start()).error).toBeUndefined()
    expect(replacement.spawn).toHaveBeenCalledTimes(2)
  } finally { exited.resolve(true); await h.runtime.release(h.request.stateOwner); vi.useRealTimers() }
})

it('blocks reuse after fallback cleanup fails until release succeeds', async () => {
  const h = await retainedChild()
  h.waitForExit.mockRejectedValueOnce(new Error('exit not confirmed'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = h.start()
    await h.booted.promise
    await vi.advanceTimersByTimeAsync(150)
    expect((await pending).error?.message).toContain('managed process cleanup failed: exit not confirmed')
    await expect(h.runtime.run(h.runtime.resolve(h.request))).rejects.toThrow('cleanup is incomplete')
    await expect(h.runtime.run(h.runtime.resolve(h.request))).rejects.toMatchObject({ name: 'PtcRuntimeError', code: 'PTC_RUNTIME_UNAVAILABLE' })
    await h.runtime.release(h.request.stateOwner)
    const replacement = fakeChild(h.ctx, h.runtime, h.request)
    replacement.onBoot(() => { replacement.complete({}) })
    expect((await replacement.start()).error).toBeUndefined()
  } finally { await h.runtime.release(h.request.stateOwner); vi.useRealTimers() }
})

it('allows explicit release to terminate a process awaiting interrupted execution settlement', async () => {
  const h = await retainedChild()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = h.start()
    await h.booted.promise
    await vi.advanceTimersByTimeAsync(100)
    await h.runtime.release(h.request.stateOwner)
    expect((await pending).error?.message).toContain('retained variables were cleared')
    expect(h.terminate).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})

it('terminates when cancellation follows control-channel closure', async () => {
  const h = await retainedChild()
  const pending = h.start({ ...h.request, timeoutMs: null })
  try {
    await h.booted.promise
    h.control.emit('end')
    h.controller.abort()
    expect((await pending).error).toMatchObject({ kind: 'abort', message: 'execution canceled; retained variables were cleared' })
    expect(h.terminate).toHaveBeenCalledOnce()
    expect(h.waitForExit).toHaveBeenCalledOnce()
  } finally { await h.runtime.release(h.request.stateOwner) }
})

it('terminates when the final stop diagnostic exceeds the output budget', async () => {
  const h = await retainedChild({ maxOutputBytes: 70 })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = h.start()
    await h.booted.promise
    await vi.advanceTimersByTimeAsync(100)
    h.complete({})
    expect((await pending).error?.kind).toBe('output-limit')
    expect(h.terminate).toHaveBeenCalledOnce()
  } finally { await h.runtime.release(h.request.stateOwner); vi.useRealTimers() }
})

it('keeps the timeout outcome when run completes during recovery and ignores a duplicate reply during the next run', async () => {
  const h = await retainedChild()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = h.start()
    await h.booted.promise
    const firstId = requestId(h.messages, 'run')
    await vi.advanceTimersByTimeAsync(100)
    const nextBooted = Promise.withResolvers<undefined>()
    h.onBoot(() => { nextBooted.resolve(undefined) })
    await expect(h.runtime.run(h.runtime.resolve({ ...h.request, program: '42' }))).rejects.toThrow('concurrent runs')
    expect(h.messages.filter(value => typeof value === 'object' && value !== null && 'm' in value && value.m === 'run')).toHaveLength(1)
    h.complete({ error: { kind: 'exception', message: 'late completion' } })
    expect((await pending).error?.kind).toBe('timeout')
    const next = h.runtime.run(h.runtime.resolve({ ...h.request, program: '42' }))
    await nextBooted.promise
    const settled = vi.fn()
    void next.then(settled)
    h.emit({ t: 's', i: firstId, r: { error: { kind: 'exception', message: 'duplicate completion' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    h.complete({})
    expect(await next).toMatchObject({ output: [] })
    expect((await next).error).toBeUndefined()
    expect(h.spawn).toHaveBeenCalledOnce()
    expect(h.terminate).not.toHaveBeenCalled()
  } finally { await h.runtime.release(h.request.stateOwner); vi.useRealTimers() }
})

it('does not interrupt an evaluation that completed before its deadline', async () => {
  const h = await retainedChild()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    h.onBoot(() => { h.complete({}) })
    expect((await h.start()).error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.messages).not.toContainEqual(expect.objectContaining({ m: 'revoke' }))
    expect(h.terminate).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
