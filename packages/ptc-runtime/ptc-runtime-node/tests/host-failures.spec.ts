import { AsyncLocalStorage } from 'node:async_hooks'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setImmediate } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Config } from '../src/index.ts'
import { fakeChild, NO_INITIAL_FRAME } from './fake-child.ts'
import { encodePtcJsonWire } from '../src/json-wire.ts'
import { mountRuntime } from './setup.ts'

const request: PtcRunRequest = { program: 'return 1', bindings: [] }

async function setup(config: Config = {}, mode: 'read-only' | 'danger-full-access' = 'danger-full-access') {
  const ctx = new Context()
  const { runtime } = await mountRuntime(ctx, config, { mode, workspaceRoot: process.cwd() })
  return { ctx, runtime, ...fakeChild(ctx, runtime, request) }
}

function call(id: number, value: string = '') {
  return { t: 'q', i: String(id), m: 'invoke', a: ['tools', 'test', encodePtcJsonWire(value)] }
}

function withBinding(fn: PtcBindingFunction): PtcRunRequest {
  return { ...request, bindings: [{ global: 'tools', functions: { test: fn } }] }
}

function confinement(argv: string[]): ConfinedArgv {
  return { argv, enforcement: 'partial', denialSignatures: ['EACCES'], runnerFailureRules: [{ fatalSignatures: ['sandbox-fatal:'] }] }
}

describe('Node runtime host failures', () => {
  it.each<[Config, string]>([
    [{ timeoutMs: 0 }, 'timeoutMs'],
    [{ maxPendingCalls: -1 }, 'maxPendingCalls'],
    [{ maxOldGenerationSizeMb: Infinity }, 'maxOldGenerationSizeMb'],
    [{ timeoutMs: MAX_TIMER_DELAY_MS + 1 }, 'timeoutMs'],
    [{ maxTimeoutMs: MAX_TIMER_DELAY_MS + 1 }, 'maxTimeoutMs'],
    [{ graceMs: MAX_TIMER_DELAY_MS + 1 }, 'graceMs'],
    [{ maxOutputBytes: 3 }, 'maxOutputBytes'],
    [{ maxOutputBytes: 4.5 }, 'maxOutputBytes'],
    [{ maxMessageBytes: 1.5 }, 'maxMessageBytes'],
    [{ maxPendingCalls: 1.5 }, 'maxPendingCalls'],
    [{ maxOldGenerationSizeMb: 1.5 }, 'maxOldGenerationSizeMb'],
    [{ launch: { kind: 'node-script', executable: '' } }, 'launch.executable'],
    [{ launch: { kind: 'node-script', executable: process.execPath, bootstrapPath: 'relative-bootstrap.js' } }, 'bootstrapPath'],
  ])('rejects deployment configuration %j', async (config, field) => {
    await expect(mountRuntime(new Context(), config)).rejects.toThrow(field)
  })

  it('reports the deployment mode and rejects unsupported resolved inputs before spawning', async () => {
    const h = await setup({}, 'read-only')
    expect(h.runtime.sandboxMode).toBe('read-only')
    expect(() => h.runtime.resolve({ ...request, cwd: 'relative' })).toThrow('cwd must be absolute')
    await expect(h.runtime.run({ ...request, cwd: process.cwd(), timeoutMs: 1 })).rejects.toThrow('resolved sandbox policy')
    const spec = h.runtime.resolve(request)
    await expect(h.runtime.run({ ...spec, timeoutMs: Infinity })).rejects.toThrow('resolved cwd and timeout')
    expect(h.spawn).not.toHaveBeenCalled()
    await h.ctx.fiber.dispose()
    expect(() => h.runtime.resolve(request)).toThrow('resolve after disposal')
    await expect(h.runtime.run(spec)).rejects.toThrow('run after disposal')
  })

  it('fails a required unavailable sandbox before spawning', async () => {
    const h = await setup({}, 'read-only')
    vi.spyOn(h.ctx.sandbox, 'confine').mockRejectedValue(new SandboxUnavailableError('read-only'))
    expect((await h.start()).error?.kind).toBe('sandbox-unavailable')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('keeps partial enforcement separate from a successful program', async () => {
    const h = await setup({}, 'read-only')
    vi.spyOn(h.ctx.sandbox, 'confine').mockImplementation(async argv => confinement([...argv]))
    h.onBoot(() => { h.complete({ value: encodePtcJsonWire(42) }) })
    expect(await h.start()).toEqual({ logs: [], value: 42, sandbox: { mode: 'read-only', denied: false, enforcement: 'partial' } })
  })

  it.each([['EACCES: blocked', true], ['EPERM: unrelated dialect', false]] as const)('uses only the selected denial dialect for %s', async (message, denied) => {
    const h = await setup({}, 'read-only')
    vi.spyOn(h.ctx.sandbox, 'confine').mockImplementation(async argv => confinement([...argv]))
    h.onBoot(() => { h.complete({ error: { kind: 'exception', message } }) })
    const result = await h.start()
    expect(result.error).toEqual({ kind: 'exception', message })
    expect(result.sandbox).toEqual({ mode: 'read-only', denied, enforcement: 'partial' })
  })

  it('distinguishes fatal sandbox startup output from a program denial', async () => {
    const h = await setup({}, 'read-only')
    vi.spyOn(h.ctx.sandbox, 'confine').mockImplementation(async argv => confinement([...argv]))
    h.onBoot(() => {
      h.stderr.write('sandbox-fatal: runner could not initialize')
      h.direct.resolve({ exitCode: 1, signal: null })
    })
    const result = await h.start()
    expect(result.error?.kind).toBe('sandbox-unavailable')
    expect(result.sandbox?.denied).toBe(false)
  })

  it('reports bootstrap assets that cannot map into the execution world', async () => {
    const h = await setup()
    vi.spyOn(h.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    expect((await h.start()).error?.message).toContain('bootstrap is unavailable')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('cleans up a provider that fails to supply its requested control pipe', async () => {
    const h = await setup()
    h.spawn.mockReturnValue({ ...h.handle, control: undefined })
    expect((await h.start()).error?.message).toContain('did not supply the requested control')
    expect(h.terminate).toHaveBeenCalledOnce()
    expect(h.waitForExit).toHaveBeenCalledOnce()
  })

  it('reports an executable lookup failure without allocating a process', async () => {
    const h = await setup()
    h.resolveExecutable.mockRejectedValue(new Error('Node executable missing'))
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'Node executable missing' })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('honors an already-aborted run without beginning executable lookup', async () => {
    const h = await setup()
    const result = await h.start({ ...request, signal: AbortSignal.abort('already stopped') }, NO_INITIAL_FRAME)
    expect(result.error).toEqual({ kind: 'abort', message: 'already stopped' })
    expect(h.resolveExecutable).not.toHaveBeenCalled()
  })

  it('keeps a null-deadline run active past the numeric ceiling until cancellation', async () => {
    const h = await setup({ timeoutMs: 20, maxTimeoutMs: 40 })
    const booted = Promise.withResolvers<undefined>()
    h.onBoot(() => { booted.resolve(undefined) })
    const controller = new AbortController()
    let active: ReturnType<typeof h.start> | undefined
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      active = h.start({ ...request, timeoutMs: null, signal: controller.signal })
      const settled = vi.fn()
      void active.then(settled)
      await booted.promise
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).not.toHaveBeenCalled()
      expect(h.terminate).not.toHaveBeenCalled()
      controller.abort('stop unlimited run')
      expect((await active).error).toEqual({ kind: 'abort', message: 'stop unlimited run' })
      expect(h.terminate).toHaveBeenCalledOnce()
      expect(h.waitForExit).toHaveBeenCalledOnce()
    } finally {
      controller.abort('test cleanup')
      vi.useRealTimers()
      await active
    }
  })

  it('does not launch after cancellation races executable lookup completion', async () => {
    const h = await setup()
    const controller = new AbortController()
    h.resolveExecutable.mockImplementation(async () => {
      controller.abort('lookup canceled')
      return process.execPath
    })
    expect((await h.start({ ...request, signal: controller.signal }, NO_INITIAL_FRAME)).error?.kind).toBe('abort')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('does not launch when confinement resolves after cancellation', async () => {
    const h = await setup({}, 'read-only')
    const entered = Promise.withResolvers<AbortSignal>()
    const response = Promise.withResolvers<ConfinedArgv>()
    vi.spyOn(h.ctx.sandbox, 'confine').mockImplementation((_argv, _policy, signal) => {
      entered.resolve(signal!)
      return response.promise
    })
    const controller = new AbortController()
    const pending = h.start({ ...request, signal: controller.signal }, NO_INITIAL_FRAME)
    try {
      const signal = await entered.promise
      expect(signal.aborted).toBe(false)
      controller.abort('confinement cancelled')
      expect(signal.aborted).toBe(true)
      response.resolve(confinement([process.execPath]))
      expect((await pending).error).toEqual({ kind: 'abort', message: 'confinement cancelled' })
      expect(h.spawn).not.toHaveBeenCalled()
    } finally {
      response.resolve(confinement([process.execPath]))
      await pending
    }
  })

  it('reports an early control EOF using the direct process result', async () => {
    const h = await setup()
    h.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        h.control.push(null)
        h.direct.resolve({ exitCode: 7, signal: null })
      })
      return h.handle
    })
    expect((await h.start(request, NO_INITIAL_FRAME)).error).toEqual({
      kind: 'worker-exit', message: 'Node process exited before completing (7)',
    })
  })

  it('reports startup transport loss when the direct process outcome rejects', async () => {
    const h = await setup()
    h.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        h.control.emit('error', new Error('control transport closed'))
        h.direct.reject(new Error('runner connection broken'))
      })
      return h.handle
    })
    expect((await h.start(request, NO_INITIAL_FRAME)).error).toEqual({ kind: 'worker-exit', message: 'runner connection broken' })
  })

  it('reports control loss after readiness as a substrate failure', async () => {
    const h = await setup()
    h.onBoot(() => { h.control.emit('error', new Error('control transport closed')) })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'control transport closed' })
  })

  it('fails at once when a bootstrap from another release sends a length-prefixed frame', async () => {
    const h = await setup()
    const body = Buffer.from(JSON.stringify({ type: 'ready' }))
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    h.spawn.mockImplementation(() => {
      queueMicrotask(() => { h.control.push(Buffer.concat([header, body])) })
      return h.handle
    })
    expect((await h.start(request, NO_INITIAL_FRAME)).error).toEqual({
      kind: 'protocol', message: 'control message is not a JSON object; the Node bootstrap may be from another release',
    })
  })

  it('classifies invalid UTF-8 on the live control stream as a protocol failure', async () => {
    const h = await setup()
    h.onBoot(() => { h.control.push(Buffer.from([0xff, 10])) })
    expect((await h.start()).error?.kind).toBe('protocol')
  })

  it.each<[unknown, string]>([
    [null, 'not a JSON object'],
    [{ t: 'q', m: 'ready', a: [] }, 'duplicate program readiness'],
    [{ t: 'q', m: 'log', a: [1] }, 'invalid program log'],
    [{ t: 'q', m: 'invoke', a: [null, 'test', []], i: 'call' }, 'undeclared binding'],
    [{ t: 'q', m: 'invoke', a: ['tools', 'constructor', []], i: 'call' }, 'undeclared binding'],
    [{ t: 'q', m: 'invoke', a: ['tools', 'test'], i: 'call' }, 'arguments must be lossless JSON'],
  ])('rejects malformed program traffic %j', async (frame, message) => {
    const h = await setup()
    const binding = vi.fn(async () => null)
    h.onBoot(() => { h.emit(frame) })
    const result = await h.start(withBinding(binding))
    expect(result.error?.kind).toBe('protocol')
    expect(result.error?.message).toContain(message)
    expect(binding).not.toHaveBeenCalled()
  })

  it('answers calls to unknown methods without failing the run', async () => {
    const h = await setup()
    h.onBoot(() => {
      h.emit({ t: 'q', i: 'unknown', m: 'constructor', a: [] })
      h.complete({ value: encodePtcJsonWire(42) })
    })
    expect((await h.start()).value).toBe(42)
    expect(h.messages).toContainEqual({ t: 's', i: 'unknown', e: { message: '[birpc] function "constructor" not found' } })
  })

  it.each([null, { error: null }, { error: { kind: 'exception', message: 1 } }, { error: { kind: 'timeout', message: 'forged' } }])('rejects malformed run results %j', async (raw) => {
    const h = await setup()
    h.onBoot(() => { h.complete(raw) })
    expect((await h.start()).error?.kind).toBe('protocol')
  })

  it.each<Config>([{ maxPendingCalls: 1 }, { maxMessageBytes: 512 }])('bounds unresolved host calls with %j', async (config) => {
    const h = await setup(config)
    const release = Promise.withResolvers<null>()
    onTestFinished(() => { release.resolve(null) })
    const binding = vi.fn(async () => await release.promise)
    h.onBoot(() => { h.emit(call(1, 'a'.repeat(300))); h.emit(call(2, 'b'.repeat(300))) })
    expect((await h.start(withBinding(binding))).error?.message).toContain('pending binding calls exceed')
    expect(binding).toHaveBeenCalledOnce()
    release.resolve(null)
    await setImmediate()
  })

  it('rejects an untransferable completion instead of returning a substituted value', async () => {
    const h = await setup()
    h.onBoot(() => { h.complete({ value: { invalid: true } }) })
    expect((await h.start()).error?.kind).toBe('invalid-output')
  })

  it('returns non-lossless binding resolutions as program-visible binding failures', async () => {
    const h = await setup()
    h.receive((message) => {
      if (typeof message !== 'object' || message === null || !('t' in message)) return
      if ('m' in message && message.m === 'run') h.emit(call(1))
      if (message.t === 's') h.complete({})
    })
    expect((await h.start(withBinding(async () => Number.NaN))).error).toBeUndefined()
    expect(h.messages).toContainEqual({ t: 's', i: '1', e: { message: 'binding resolution must be lossless JSON' } })
  })

  it('does not publish a late binding reply after the program has settled', async () => {
    const h = await setup()
    const release = Promise.withResolvers<null>()
    onTestFinished(() => { release.resolve(null) })
    h.onBoot(() => { h.emit(call(1)); h.complete({}) })
    expect((await h.start(withBinding(async () => await release.promise))).error).toBeUndefined()
    release.resolve(null)
    await setImmediate()
    expect(h.messages).not.toContainEqual(expect.objectContaining({ t: 's' }))
    expect(h.control.destroyed).toBe(true)
  })

  it('reports failed managed cleanup even when the program returns successfully', async () => {
    const h = await setup()
    vi.mocked(h.waitForExit).mockRejectedValue(new Error('range cannot be observed'))
    h.onBoot(() => { h.complete({ value: encodePtcJsonWire(42) }) })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'managed process cleanup failed: range cannot be observed' })
  })

  it('fails when the configured frame budget cannot carry bootstrap data', async () => {
    const h = await setup({ maxMessageBytes: 32 })
    expect((await h.start()).error?.message).toContain('control output exceeds 32 queued bytes')
  })

  it('turns an oversized binding reply into a protocol failure', async () => {
    const h = await setup({ maxMessageBytes: 256 })
    h.onBoot(() => { h.emit(call(1)) })
    const result = await h.start(withBinding(async () => 'x'.repeat(512)))
    expect(result.error).toEqual({ kind: 'protocol', message: 'control output exceeds 256 queued bytes' })
  })

  it('keeps an output overflow delivered beside the program result', async () => {
    const h = await setup({ maxOutputBytes: 64 }, 'read-only')
    vi.spyOn(h.ctx.sandbox, 'confine').mockImplementation(async argv => confinement([...argv]))
    h.receive((message) => {
      const run = message as { m?: string; i?: string }
      if (run.m !== 'run') return
      const result = { t: 's', i: run.i, r: { error: { kind: 'exception', message: 'EACCES: blocked' } } }
      const log = { t: 'q', m: 'log', a: ['x'.repeat(100)] }
      h.control.push(Buffer.from(`${JSON.stringify(result)}\n${JSON.stringify(log)}\n`))
    })
    const result = await h.start()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.sandbox?.denied).toBe(false)
  })

  it('retains admitted logs when the program reports its own output limit', async () => {
    const h = await setup()
    h.onBoot(() => {
      h.emit({ t: 'q', m: 'log', a: ['retained'] })
      h.complete({ error: { kind: 'output-limit', message: 'child ledger exhausted' } })
    })
    const result = await h.start()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs).toEqual(['retained'])
  })

  it.each([undefined, { kind: 'exception', message: 'program failed' }] as const)('bounds incomplete raw output after completion with %j', async (failure) => {
    const h = await setup({ graceMs: 5 })
    const cleaning = Promise.withResolvers<undefined>()
    vi.mocked(h.terminate).mockImplementation(() => { h.direct.resolve({ exitCode: 0, signal: null }) })
    vi.mocked(h.waitForExit).mockImplementation(async () => { cleaning.resolve(undefined); return true })
    h.onBoot(() => { h.complete(failure === undefined ? {} : { error: failure }) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = h.start()
      await cleaning.promise
      await vi.advanceTimersByTimeAsync(5)
      expect((await pending).error).toEqual(failure ?? { kind: 'worker-exit', message: 'Node process output did not close cleanly' })
      expect(h.stdout.destroyed).toBe(true)
      expect(h.stderr.destroyed).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('decodes fragmented native output and preserves incomplete final UTF-8 bytes', async () => {
    const h = await setup()
    h.onBoot(() => {
      for (const stream of [h.stdout, h.stderr]) {
        stream.write(Buffer.from([0xef, 0xbb, 0xbf]))
        stream.write(Buffer.from([0xe2]))
        stream.write(Buffer.from([0x82, 0xac]))
        stream.end(Buffer.from([0xe2]))
      }
      h.complete({})
    })
    const result = await h.start()
    expect(result.error).toBeUndefined()
    expect(result.logs.filter(text => text === '\uFEFF')).toHaveLength(2)
    expect(result.logs.filter(text => text === '€')).toHaveLength(2)
    expect(result.logs.filter(text => text === '�')).toHaveLength(2)
  })

  it('keeps the fitting native-output prefix and ignores later overflow chunks', async () => {
    const h = await setup({ maxOutputBytes: 256 })
    vi.mocked(h.terminate).mockImplementation(() => {
      h.stderr.end('later output')
      h.stdout.end()
      h.direct.resolve({ exitCode: 0, signal: null })
    })
    h.onBoot(() => { h.stdout.write('x'.repeat(1024)) })
    const result = await h.start()
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs.join('')).toMatch(/^x+$/)
    expect(Buffer.byteLength(JSON.stringify(result.logs))).toBeLessThanOrEqual(256)
  })

  it.each(['stdout', 'stderr'] as const)('reports a broken raw %s pipe', async (name) => {
    const h = await setup()
    h.onBoot(() => { h[name].emit('error', new Error(`${name} closed`)) })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: `${name} closed` })
  })

  it('retains stderr when a ready process exits without a completion frame', async () => {
    const h = await setup()
    h.onBoot(() => {
      h.stderr.write('native fatal detail')
      h.direct.resolve({ exitCode: 9, signal: null })
    })
    expect((await h.start()).error).toEqual({ kind: 'worker-exit', message: 'Node process exited before completing (9): native fatal detail' })
  })

  it.each([true, false])('attributes a failed confined spawn only with runner evidence (%s)', async (runnerFailed) => {
    const h = await setup({}, 'read-only')
    const runner = '/sandbox-runner'
    vi.spyOn(h.ctx.sandbox, 'confine').mockImplementation(async argv => confinement([runner, ...argv]))
    h.onBoot(() => {
      h.direct.reject(Object.assign(new Error('spawn rejected'), runnerFailed ? { code: 'ENOENT', path: runner, syscall: `spawn ${runner}` } : {}))
    })
    expect((await h.start()).error).toEqual({ kind: runnerFailed ? 'sandbox-unavailable' : 'worker-exit', message: 'spawn rejected' })
  })

  it('retains distinct native temp paths for the trusted launcher while removing other ambient values', async () => {
    const h = await setup()
    onTestFinished(() => { vi.unstubAllEnvs() })
    vi.stubEnv('TEMP', 'fixture-temp-first')
    vi.stubEnv('TMP', 'fixture-tmp-second')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('DSH_TEST_RUNTIME_SECRET', 'must-not-inherit')
    h.onBoot(() => { h.complete({}) })
    expect((await h.start()).error).toBeUndefined()
    const env = h.spawn.mock.calls[0]?.[0].env ?? {}
    expect(Object.hasOwn(env, 'TEMP')).toBe(false)
    expect(Object.hasOwn(env, 'TMP')).toBe(false)
    expect(Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE')).toBe(false)
    expect(Object.hasOwn(env, 'DSH_TEST_RUNTIME_SECRET')).toBe(true)
    expect(env.DSH_TEST_RUNTIME_SECRET).toBeUndefined()
  })

  it('selects the remote embedded bootstrap without leaking ambient environment', async () => {
    const h = await setup({ launch: { kind: 'embedded', executable: process.execPath } })
    h.onBoot(() => { h.complete({}) })
    expect((await h.start()).error).toBeUndefined()
    const spec = h.spawn.mock.calls[0]?.[0]
    expect(spec?.env?.DSH_PTC_RUNTIME_NODE).toBe('1')
    expect(Object.hasOwn(spec?.env ?? {}, 'PATH')).toBe(false)
    expect(spec?.argv).toEqual([process.execPath, '134217728'])
    expect(Object.fromEntries(Object.entries(spec?.env ?? {}).filter(([, value]) => value !== undefined)))
      .toEqual({ DSH_PTC_RUNTIME_NODE: '1', NODE_OPTIONS: '--max-old-space-size=512' })
  })
})

it('keeps failed per-call cleanup registered until process observation succeeds', async () => {
  const h = await setup()
  const session = h.ctx.sessions.create(SessionId('per-call-cleanup-retry'))
  h.waitForExit.mockRejectedValue(new Error('range cannot be observed'))
  h.onBoot(() => { h.complete({ value: encodePtcJsonWire(42) }) })
  const result = await h.start({ ...request, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }) })
  expect(result.error?.kind).toBe('worker-exit')
  setSandboxMode(session, 'read-only')
  expect(h.ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
  await expect(h.runtime.run(h.runtime.resolve({ ...request, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }) }))).rejects.toThrow('range cannot be observed')
  h.waitForExit.mockResolvedValue(true)
  await h.ctx.fiber.dispose()
  expect(h.waitForExit.mock.calls.length).toBeGreaterThanOrEqual(3)
})

it('unregisters a Session resource when process spawn fails', async () => {
  const h = await setup()
  const session = h.ctx.sessions.create(SessionId('failed-session-spawn'))
  h.spawn.mockImplementation(() => { throw new Error('spawn failed') })
  const result = await h.start({ ...request, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }) }, NO_INITIAL_FRAME)
  expect(result.error?.message).toContain('spawn failed')
  setSandboxMode(session, 'read-only')
})

it('preserves execution context for bindings delivered by an external control stream', async () => {
  const h = await setup()
  const session = h.ctx.sessions.create(SessionId('external-binding-context'))
  const booted = Promise.withResolvers<undefined>()
  h.receive((raw) => {
    const message = raw as { t: string; m?: string; r?: unknown }
    if ('m' in message && message.m === 'run') booted.resolve(undefined)
    if (message.t === 's') h.complete({ value: message.r })
  })
  const context = new AsyncLocalStorage<string>()
  const pending = context.run('binding context', () => h.start({ ...request, sandboxPolicy: h.ctx.sandboxPolicy.resolve({ session }),
    bindings: [{ global: 'tools', functions: { test: async () => context.getStore() ?? null } }],
  }))
  await booted.promise
  h.emit(call(1))
  const result = await pending
  expect(result.value).toBe('binding context')
  expect(h.ctx.sandboxPolicy.resolve({ session }).mode).toBe('danger-full-access')
})
