import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'
import { fakeChild, NO_INITIAL_FRAME } from './fake-child.ts'
import { encodePtcJsonWire } from '../src/json-wire.ts'

const request: PtcRunRequest = { program: '1', bindings: [], stateOwner: {} }
async function setup(config: Config = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const { runtime, fiber } = await mountRuntime(ctx, { ...config, executionMode: config.executionMode ?? 'persistent-in-memory' })
  return { ctx, fiber, runtime, ...fakeChild(ctx, runtime, request) }
}

function call(id = 1, args: unknown = encodePtcJsonWire(null)) { return { t: 'q', i: String(id), m: 'invoke', a: ['tools', 'test', args] } }
const bound: PtcRunRequest = { ...request, bindings: [{ global: 'tools', functions: { test: async () => 42 } }] }

it.each(['per-call', 'persistent-in-memory'] as const)('cancels a %s call when its Session policy changes before process launch', async (executionMode) => {
  const h = await setup({ executionMode })
  const session = h.ctx.sessions.create(SessionId('policy-admission'))
  const policy = h.ctx.sandboxPolicy.resolve({ session })
  expect(policy.mode).toBe('danger-full-access')
  h.receive((message) => {
    if (typeof message !== 'object' || message === null || !('t' in message)) return
    const done = { value: encodePtcJsonWire(1) }
    if ('m' in message && message.m === 'run') h.complete(done)
  })

  const pending = h.start({
    program: executionMode === 'per-call' ? 'return 1' : '1',
    bindings: [],
    stateOwner: {},
    sandboxPolicy: policy,
  })
  setSandboxMode(session, 'read-only')

  const result = await pending
  expect(h.ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
  expect(result).toMatchObject({ error: { kind: 'abort' } })
  expect(h.spawn).not.toHaveBeenCalled()
})

it.each(['per-call', 'persistent-in-memory'] as const)('keeps an approved wider %s call when the standing mode is unchanged', async (executionMode) => {
  const h = await setup({ executionMode })
  const session = h.ctx.sessions.create(SessionId('temporary-admission'))
  setSandboxMode(session, 'read-only')
  const standing = h.ctx.sandboxPolicy.resolve({ session })
  h.receive((message) => {
    if (typeof message !== 'object' || message === null || !('t' in message)) return
    const done = { value: encodePtcJsonWire(1) }
    if ('m' in message && message.m === 'run') h.complete(done)
  })
  const pending = h.start({
    program: executionMode === 'per-call' ? 'return 1' : '1',
    bindings: [],
    sandboxPolicy: { ...standing, mode: 'danger-full-access' },
  })
  setSandboxMode(session, 'read-only')
  expect(await pending).toMatchObject({ value: 1, sandbox: { mode: 'danger-full-access' } })
  expect(h.spawn).toHaveBeenCalledOnce()
  expect(h.ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
})

it.each(['per-call', 'persistent-in-memory'] as const)('keeps a %s call canceled when policy changes back during earlier cleanup', async (executionMode) => {
  const h = await setup({ executionMode })
  const session = h.ctx.sessions.create(SessionId('waiting-admission'))
  const booted = Promise.withResolvers<undefined>()
  const cleaning = Promise.withResolvers<undefined>()
  const cleanup = Promise.withResolvers<boolean>()
  h.receive((message) => {
    if (typeof message === 'object' && message !== null && 'm' in message
      && message.m === 'run') booted.resolve(undefined)
  })
  h.waitForExit.mockImplementation(() => { cleaning.resolve(undefined); return cleanup.promise })
  const first = h.start({ ...request, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }) })
  let waiting: ReturnType<typeof h.start> | undefined
  try {
    await booted.promise
    setSandboxMode(session, 'read-only')
    await cleaning.promise
    waiting = h.start({ ...request, stateOwner: {}, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }) }, NO_INITIAL_FRAME)
    setSandboxMode(session, 'danger-full-access')
    setSandboxMode(session, 'read-only')
    expect(h.spawn).toHaveBeenCalledOnce()
    cleanup.resolve(true)
    expect((await first).error?.kind).toBe('abort')
    expect((await waiting).error?.kind).toBe('abort')
    expect(h.spawn).toHaveBeenCalledOnce()
  } finally {
    cleanup.resolve(true)
    await first
    await waiting
  }
})

it('rejects a retained call when its provider unloads during earlier policy cleanup', async () => {
  const h = await setup()
  const session = h.ctx.sessions.create(SessionId('unloading-admission'))
  h.onBoot(() => { h.complete({}) })
  await h.start({ ...request, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }) })
  const cleaning = Promise.withResolvers<undefined>()
  const cleanup = Promise.withResolvers<boolean>()
  h.waitForExit.mockImplementation(() => { cleaning.resolve(undefined); return cleanup.promise })
  setSandboxMode(session, 'read-only')
  await cleaning.promise
  const pending = h.runtime.run(h.runtime.resolve({
    ...request, stateOwner: {}, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }),
  }))
  const rejected = expect(pending).rejects.toThrow('persistent PTC: run after disposal')
  const closing = h.fiber.dispose()
  try {
    await vi.waitFor(() => {
      expect(() => h.runtime.resolve(request)).toThrow('persistent PTC: resolve after disposal')
    })
    expect(h.spawn).toHaveBeenCalledOnce()
    cleanup.resolve(true)
    await rejected
    await closing
    expect(h.ctx.get('ptcRuntime')).toBeUndefined()
    expect(h.spawn).toHaveBeenCalledOnce()
  } finally {
    cleanup.resolve(true)
    await Promise.allSettled([pending, rejected, closing])
  }
})

describe('persistent PTC host protocol', () => {
  it.each([
    null,
    { t: 'q', m: 'log', a: [1] },
    call(1, 'not a wire value'),
  ])('rejects invalid process traffic %j', async (raw) => {
    const h = await setup()
    h.onBoot(() => { h.emit(raw) })
    expect((await h.start(bound)).error?.kind).toBe('protocol')
    expect(h.terminate).toHaveBeenCalledTimes(1)
    expect(h.waitForExit).toHaveBeenCalledTimes(1)
  })

  it.each([{ error: { kind: 'other', message: '' } }, { error: { kind: 'exception', message: 1 } }])('rejects malformed results %j', async (raw) => {
    const h = await setup()
    h.onBoot(() => { h.complete(raw) })
    expect((await h.start()).error?.kind).toBe('protocol')
  })

  it('requires the readiness handshake and all requested pipes', async () => {
    const h = await setup()
    expect((await h.start(request, null)).error?.kind).toBe('protocol')
    const missing = await setup()
    missing.spawn.mockReturnValue({ ...missing.handle, control: undefined })
    expect((await missing.start(request, NO_INITIAL_FRAME)).error?.message).toContain('did not supply')
  })

  it.each(['exception', 'invalid-output', 'output-limit'])('accepts a terminal %s failure', async (kind) => {
    const h = await setup()
    h.onBoot(() => { h.complete({ error: { kind, message: 'example' } }) })
    expect((await h.start()).error?.kind).toBe(kind)
  })

  it('rejects lossy terminal values and bounds complete results', async () => {
    const h = await setup()
    h.onBoot(() => { h.complete({ value: 'bad' }) })
    expect((await h.start()).error?.kind).toBe('invalid-output')
    const limited = await setup({ maxOutputBytes: 30 })
    limited.onBoot(() => { limited.emit({ t: 'q', m: 'log', a: ['x'.repeat(100)] }) })
    expect((await limited.start()).error?.kind).toBe('output-limit')
  })

  it('returns current binding successes, exceptions and unavailable bindings', async () => {
    const cases: Record<string, PtcBindingFunction>[] = [
      { test: async () => 42 }, { test: async () => { throw new Error('denied') } },
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Host bindings may reject with a non-Error value.
      { test: () => Promise.reject('denied') }, {},
    ]
    for (const functions of cases) {
      const h = await setup()
      h.receive((raw) => {
        const message = raw as Record<string, unknown>
        if (message.m === 'run') h.emit(call())
        else if (message.t === 's') h.complete({ value: encodePtcJsonWire(message.e === undefined) })
      })
      const result = await h.start({ ...request, bindings: [{ global: 'tools', functions }] })
      expect(result.error).toBeUndefined()
      const reply = h.messages.find(raw => (raw as { t: string }).t === 's') as { e?: { message: string } }
      expect(result.value).toBe(reply.e === undefined)
      if (reply.e) expect(reply.e.message).toMatch(/denied|unavailable/)
    }
  })

  it('bounds outstanding binding calls and drops replies after a run ends', async () => {
    const h = await setup({ maxPendingCalls: 1 })
    const pending = Promise.withResolvers<null>()
    h.onBoot(() => { h.emit(call()); h.emit(call(2)) })
    try {
      expect((await h.start({ ...request, bindings: [{ global: 'tools', functions: { test: () => pending.promise } }] })).error?.kind).toBe('protocol')
    } finally { pending.resolve(null) }
    await setImmediate()
    expect(h.messages.some(raw => (raw as { t: string }).t === 's')).toBe(false)
  })

  it('cleans up after launch failure and cancellation during executable resolution', async () => {
    const h = await setup()
    h.resolveExecutable.mockRejectedValue('missing executable')
    expect((await h.start(request, NO_INITIAL_FRAME)).error?.message).toContain('missing executable')
    const waiting = await setup()
    const ready = Promise.withResolvers<string>()
    waiting.resolveExecutable.mockImplementation(() => ready.promise)
    const controller = new AbortController()
    const result = waiting.start({ ...request, signal: controller.signal }, NO_INITIAL_FRAME)
    controller.abort()
    ready.resolve(process.execPath)
    expect((await result).error?.kind).toBe('abort')
    expect(waiting.spawn).not.toHaveBeenCalled()
  })

  it('captures active raw output and ignores bytes arriving while the environment is idle', async () => {
    const h = await setup()
    h.onBoot(() => {
      h.stdout.write('stdout')
      h.stderr.write('stderr')
      h.complete({})
    })
    expect(await h.start()).toMatchObject({ logs: ['stdout', 'stderr'] })
    h.stdout.write('idle stdout')
    h.stderr.write('idle stderr')
    h.onBoot(() => { h.complete({}) })
    expect(await h.start(request, NO_INITIAL_FRAME)).toMatchObject({ logs: [] })
    expect(h.terminate).not.toHaveBeenCalled()
  })

  it('clears retained resources when final diagnostic accounting detects an overflow', async () => {
    const h = await setup({ maxOutputBytes: 100 })
    h.onBoot(() => { h.complete({ error: { kind: 'exception', message: 'x'.repeat(1000) } }) })
    const result = await h.start()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('retained variables were cleared')
    expect(h.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps the first outcome when raw output overflows beside a terminal frame', async () => {
    const h = await setup({ maxOutputBytes: 100 })
    h.onBoot(() => {
      h.complete({ value: encodePtcJsonWire(42) })
      queueMicrotask(() => { h.stdout.write('x'.repeat(1000)) })
    })
    expect((await h.start()).error?.kind).toBe('output-limit')
    await setImmediate()
    expect(h.terminate).toHaveBeenCalledTimes(1)
  })

  it('reports the exit result when the control pipe ends beside process completion', async () => {
    const h = await setup()
    h.onBoot(() => {
      h.stdout.end()
      h.stderr.end('fatal output')
      h.direct.resolve({ exitCode: 7, signal: null })
      h.control.push(null)
    })
    const result = await h.start()
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('7')
    expect(result.error?.message).toContain('fatal output')
  })

  it('does not send a late binding result into the next evaluation', async () => {
    const h = await setup({ maxMessageBytes: 1024 })
    const release = Promise.withResolvers<string>()
    onTestFinished(() => { release.resolve('') })
    const slow = { ...request, bindings: [{ global: 'tools', functions: { test: () => release.promise } }] }
    h.onBoot(() => { h.emit(call()); h.complete({}) })
    expect((await h.start(slow)).error).toBeUndefined()
    const booted = Promise.withResolvers<undefined>()
    h.onBoot(() => { booted.resolve(undefined) })
    const next = h.start(slow, NO_INITIAL_FRAME)
    await booted.promise
    release.resolve('x'.repeat(2000))
    await setImmediate()
    h.complete({ value: encodePtcJsonWire(2) })
    expect(await next).toMatchObject({ value: 2 })
    expect(h.messages).toContainEqual({ t: 's', i: '1', e: { message: 'PTC evaluation ended before the binding completed' } })
  })

  it('terminates the process when the control pipe fails during an evaluation', async () => {
    const h = await setup()
    h.onBoot(() => { h.control.emit('error', new Error('control transport failed')) })
    expect((await h.start()).error?.kind).toBe('worker-exit')
    expect(h.terminate).toHaveBeenCalled()
  })

  it('terminates when a binding result exceeds the control write budget', async () => {
    const h = await setup({ maxMessageBytes: 1024 })
    h.onBoot(() => { h.emit(call()) })
    const result = await h.start({ ...request, bindings: [{ global: 'tools', functions: { test: async () => 'x'.repeat(2000) } }] })
    expect(result.error?.kind).toBe('protocol')
    expect(result.error?.message).toContain('control output exceeds')
    expect(h.terminate).toHaveBeenCalledTimes(1)
  })

  it.each(['exit', 'abort', 'cleanup'] as const)('does not dispatch to an exited idle process during %s handling', async (outcome) => {
    const h = await setup()
    h.onBoot(() => { h.complete({}) })
    await h.start()
    h.onBoot(() => { h.stdout.end(); h.stderr.end() })
    h.direct.resolve({ exitCode: 9, signal: null })
    await Promise.resolve()
    const controller = new AbortController()
    if (outcome === 'abort') controller.abort()
    if (outcome === 'cleanup') h.waitForExit.mockRejectedValue(new Error('exit cleanup failed'))
    const result = await h.runtime.run(h.runtime.resolve({ ...request, program: '2', signal: controller.signal }))
    expect(result.error?.kind).toBe(outcome === 'abort' ? 'abort' : 'worker-exit')
    expect(result.error?.message).toContain(outcome === 'abort' ? 'execution canceled' : outcome === 'cleanup' ? 'exit cleanup failed' : 'exited (9, signal null)')
    expect(h.messages).toHaveLength(1)
    expect(h.messages[0]).toMatchObject({ t: 'q', m: 'run' })
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.terminate).toHaveBeenCalledTimes(1)
    expect(h.waitForExit).toHaveBeenCalledTimes(1)
  })

  it('reports stream errors and process failures without retaining state', async () => {
    for (const action of ['stream', 'exit', 'rejection'] as const) {
      const h = await setup()
      h.onBoot(() => {
        if (action === 'stream') h.stderr.emit('error', new Error('pipe failed'))
        else if (action === 'exit') { h.stdout.end(); h.stderr.end(); h.direct.resolve({ exitCode: 7, signal: null }) }
        else h.direct.reject(new Error('process failed'))
      })
      const result = await h.start()
      expect(result.error?.kind).toBe('worker-exit')
      expect(result.logs).toEqual([])
    }
  })

  it('reports failed managed cleanup and waits for both exit and pipe drain', async () => {
    const h = await setup()
    h.waitForExit.mockRejectedValue(new Error('cleanup failed'))
    h.onBoot(() => { h.emit({ t: 'q', m: 'outputLimit', a: [] }) })
    expect((await h.start()).error?.message).toContain('cleanup failed')
  })

  it.each([
    { maxOutputBytes: 38, kind: 'worker-exit' },
    { maxOutputBytes: 4, kind: 'output-limit' },
  ])('bounds cleanup failure after parse diagnostics overflow a $maxOutputBytes-byte budget', async ({ maxOutputBytes, kind }) => {
    const h = await setup({ maxOutputBytes })
    h.onBoot(() => { h.complete({}) })
    expect(await h.start()).toMatchObject({ logs: [] })
    h.waitForExit.mockRejectedValue(new Error('x'))
    const result = await h.runtime.run(h.runtime.resolve({ ...request, program: 'return 1' }))
    expect(result.error?.kind).toBe(kind)
    if (kind === 'worker-exit') expect(result.error?.message).toContain('cleanup failed: x')
    const bytes = Buffer.byteLength(JSON.stringify(result.logs)) + Buffer.byteLength(JSON.stringify(result.error?.message))
    expect(bytes).toBeLessThanOrEqual(maxOutputBytes)
    expect(h.terminate).toHaveBeenCalledTimes(1)
    expect(h.waitForExit).toHaveBeenCalledTimes(1)
    await expect(h.runtime.release(request.stateOwner!)).rejects.toThrow('x')
  })

  it('rejects invalid resolved inputs and deployment bounds', async () => {
    const h = await setup()
    expect(h.runtime.executionInstructions).toContain('Variables, functions, and imported modules remain in memory')
    await expect(h.runtime.run({ ...request, cwd: '.', timeoutMs: null })).rejects.toThrow('resolved inputs')
    await expect(h.runtime.run({ ...request, cwd: process.cwd(), timeoutMs: Infinity })).rejects.toThrow('resolved inputs')
    for (const config of [
      { timeoutMs: 0 }, { maxMessageBytes: 1.5 }, { maxOutputBytes: 3 }, { graceMs: 2_147_483_648 },
      { launch: { kind: 'node-script', executable: '' } },
      { launch: { kind: 'node-script', executable: process.execPath, bootstrapPath: 'relative' } },
    ] satisfies Config[]) {
      await expect(setup(config)).rejects.toThrow('ptc-runtime-node')
    }
  })

  it('waits for another environment to stop before reporting a failed cleanup', async () => {
    const h = await setup()
    h.onBoot(() => { h.complete({}) })
    await h.start()
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const release: PromiseWithResolvers<string> = Promise.withResolvers()
    h.resolveExecutable.mockImplementationOnce(() => { entered.resolve(); return release.promise })
    const pending = h.runtime.run(h.runtime.resolve({ ...request, stateOwner: {} }))
    await entered.promise
    const failure = new Error('first environment cleanup failed')
    h.waitForExit.mockRejectedValue(failure)
    const reported = vi.spyOn(h.fiber.ctx.logger, 'error').mockImplementation(() => {})
    let closed = false
    const closing = h.fiber.dispose().then(() => { closed = true })
    try {
      await setImmediate()
      expect(closed).toBe(false)
      expect(reported).not.toHaveBeenCalled()
      release.resolve(process.execPath)
      expect((await pending).error?.kind).toBe('abort')
      await closing
      expect(closed).toBe(true)
      expect(reported).toHaveBeenCalledWith(failure)
      expect(h.spawn).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve(process.execPath)
      await Promise.allSettled([pending, closing])
      reported.mockRestore()
    }
  })
})

it('rejects corrupt framed traffic before it reaches the evaluator', async () => {
  const h = await setup()
  h.onBoot(() => { h.control.emit('data', Buffer.from([255, 10])) })
  expect((await h.start()).error?.kind).toBe('protocol')
})

it.each([
  { t: 'q', m: 'log', a: ['late'] },
  { t: 'q', m: 'outputLimit', a: [] },
  call(),
])('discards unsolicited idle traffic %j and awaits the retained process exit', async (raw) => {
  const h = await setup()
  h.onBoot(() => { h.complete({}) })
  expect((await h.start()).error).toBeUndefined()
  h.emit(raw)
  await h.direct.promise
  expect(h.terminate).toHaveBeenCalledTimes(1)
})

it.each(['owner release', 'provider unload'])('keeps idle-crash cleanup tracked through %s', async (action) => {
  const h = await setup()
  const cleanup = Promise.withResolvers<true>()
  const stopped = Promise.withResolvers<boolean>()
  h.waitForExit.mockImplementation(async () => { cleanup.resolve(true); return stopped.promise })
  h.onBoot(() => { h.complete({}) })
  let closing: Promise<void> | undefined
  try {
    await h.start()
    h.stdout.end()
    h.stderr.end()
    h.direct.resolve({ exitCode: 9, signal: null })
    await cleanup.promise
    await expect(h.runtime.run(h.runtime.resolve(request))).rejects.toThrow('cleanup is incomplete')
    expect(h.spawn).toHaveBeenCalledTimes(1)
    let disposed = false
    closing = (action === 'owner release' ? Promise.all([h.runtime.release(request.stateOwner!), h.runtime.release(request.stateOwner!)]) : h.fiber.dispose()).then(() => { disposed = true })
    await setImmediate()
    expect(disposed).toBe(false)
    if (action === 'owner release') await expect(h.runtime.run(h.runtime.resolve(request))).rejects.toThrow('cleanup is incomplete')
    stopped.resolve(true)
    await closing
    expect(disposed).toBe(true)
  } finally { stopped.resolve(true); await closing }
})

it('logs unexpected idle readiness and its failed cleanup', async () => {
  const h = await setup()
  const reported = vi.spyOn(h.fiber.ctx.logger, 'warn').mockImplementation(() => {})
  try {
    h.onBoot(() => { h.complete({}) })
    await h.start()
    h.waitForExit.mockRejectedValueOnce(new Error('idle cleanup failed'))
    h.emit({ t: 'q', m: 'ready', a: [] })
    await vi.waitFor(() => { expect(reported).toHaveBeenCalledTimes(2) })
    expect(reported.mock.calls).toEqual([['unexpected persistent PTC readiness'], ['idle cleanup failed']])
  } finally { reported.mockRestore() }
})

it('does not log a launch failure after cancellation closed the environment', async () => {
  const h = await setup()
  const entered = Promise.withResolvers<undefined>()
  const lookup = Promise.withResolvers<string>()
  h.resolveExecutable.mockImplementation(() => { entered.resolve(undefined); return lookup.promise })
  const reported = vi.spyOn(h.fiber.ctx.logger, 'warn').mockImplementation(() => {})
  try {
    const controller = new AbortController()
    const result = h.start({ ...request, signal: controller.signal }, NO_INITIAL_FRAME)
    await entered.promise
    controller.abort()
    lookup.reject(new Error('lookup aborted'))
    expect((await result).error?.kind).toBe('abort')
    expect(reported).not.toHaveBeenCalled()
  } finally { reported.mockRestore() }
})

it('logs an idle process failure with its bounded stderr tail', async () => {
  const h = await setup({ maxOutputBytes: 100 })
  const reported = vi.spyOn(h.fiber.ctx.logger, 'warn').mockImplementation(() => {})
  try {
    h.onBoot(() => { h.complete({}) })
    await h.start()
    h.stdout.end()
    h.stderr.end('x'.repeat(200) + 'idle fatal diagnostic')
    h.direct.resolve({ exitCode: 9, signal: null })
    await vi.waitFor(() => { expect(reported).toHaveBeenCalledOnce() })
    expect(reported).toHaveBeenCalledWith(`Node process exited (9, signal null): ${'x'.repeat(79)}idle fatal diagnostic`)
    await h.runtime.release(request.stateOwner!)
  } finally { reported.mockRestore() }
})

it('retries process observation before releasing an owner after cleanup fails', async () => {
  const h = await setup()
  h.onBoot(() => { h.complete({}) })
  await h.start()
  const failure = new Error('release cleanup failed')
  h.waitForExit.mockRejectedValue(failure)
  await expect(h.runtime.release(request.stateOwner!)).rejects.toBe(failure)
  const reported = vi.spyOn(h.fiber.ctx.logger, 'error').mockImplementation(() => {})
  try {
    await expect(h.runtime.run(h.runtime.resolve(request))).rejects.toThrow('cleanup is incomplete')
    h.waitForExit.mockResolvedValue(true)
    await h.runtime.release(request.stateOwner!)
    await h.fiber.dispose()
    expect(reported).not.toHaveBeenCalled()
    expect(h.waitForExit).toHaveBeenCalledTimes(2)
  } finally { reported.mockRestore() }
})

it('reserves the owner while parse-output overflow releases its environment', async () => {
  const h = await setup({ maxOutputBytes: 32 })
  const cleanup = Promise.withResolvers<true>()
  const stopped = Promise.withResolvers<boolean>()
  h.onBoot(() => { h.complete({}) })
  await h.start()
  h.waitForExit.mockImplementation(async () => { cleanup.resolve(true); return stopped.promise })
  const pending = h.runtime.run(h.runtime.resolve({ ...request, program: 'return 1' }))
  try {
    await cleanup.promise
    await expect(h.runtime.run(h.runtime.resolve(request))).rejects.toThrow('cleanup is incomplete')
    expect(h.spawn).toHaveBeenCalledOnce()
    stopped.resolve(true)
    expect((await pending).error?.kind).toBe('output-limit')
  } finally { stopped.resolve(true); await pending }
})

it.each([true, false])('classifies confined process spawn failure with runner evidence %s', async (runnerFailure) => {
  const h = await setup()
  const runner = '/missing-ptc-sandbox-runner'
  const confine = vi.spyOn(h.ctx.sandbox, 'confine').mockResolvedValue({
    argv: [runner], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [],
  })
  h.spawn.mockImplementation(() => {
    throw Object.assign(new Error('spawn failed'), { code: 'ENOENT', path: runnerFailure ? runner : '/other', syscall: `spawn ${runner}` })
  })
  try {
    const result = await h.start({ ...request, sandboxPolicy: { mode: 'read-only', workspaceRoot: process.cwd() } }, NO_INITIAL_FRAME)
    expect(result.error?.kind).toBe(runnerFailure ? 'sandbox-unavailable' : 'worker-exit')
    expect(result.sandbox?.enforcement).toBe('partial')
  } finally { confine.mockRestore() }
})

it('reports a sandbox runner refusal before the REPL is ready', async () => {
  const h = await setup()
  const confine = vi.spyOn(h.ctx.sandbox, 'confine').mockResolvedValue({
    argv: ['sandbox-runner'], enforcement: 'full', denialSignatures: [],
    runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['sandbox runner rejected'] }],
  })
  const pending = h.start({ ...request, sandboxPolicy: { mode: 'read-only', workspaceRoot: process.cwd() } }, NO_INITIAL_FRAME)
  try {
    await vi.waitFor(() => { expect(h.spawn).toHaveBeenCalledOnce() })
    h.stdout.end()
    h.stderr.end('sandbox runner rejected the file policy')
    h.direct.resolve({ exitCode: 127, signal: null })
    const result = await pending
    expect(result.error?.kind).toBe('sandbox-unavailable')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  } finally { h.direct.resolve({ exitCode: 127, signal: null }); await pending; confine.mockRestore() }
})

it('releases a confirmed exited process even when its output pipe did not drain', async () => {
  const h = await setup()
  h.onBoot(() => { h.complete({}) })
  await h.start()
  h.stdout.destroy()
  const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
  try {
    await expect(h.runtime.release(request.stateOwner!)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('persistent Node process exited but its output did not drain cleanly')
    await expect(h.runtime.release(request.stateOwner!)).resolves.toBeUndefined()
  } finally { warn.mockRestore() }
})

it('preserves logs in a result-level failure when temporary process pipes do not drain', async () => {
  const h = await setup()
  h.onBoot(() => {
    h.emit({ t: 'q', m: 'log', a: ['captured before cleanup'] })
    h.complete({ value: encodePtcJsonWire(42) })
    h.stdout.destroy()
  })
  const result = await h.start({ program: '1', bindings: [] })
  expect(result.logs).toEqual(['captured before cleanup'])
  expect(result.error).toEqual({ kind: 'worker-exit', message: 'managed process exited but its output did not drain cleanly' })
})
