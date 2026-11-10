import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'

async function setup(config: Config = {}, initialization?: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ptc-initialization-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) })
  const { runtime } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory', ...config })
  if (initialization !== undefined) onTestFinished(runtime.registerEnvironmentInitializer(initialization))
  const owner = {}
  const run = (program: string, options: Partial<PtcRunRequest> = {}) =>
    runtime.run(runtime.resolve({ program, bindings: [], cwd, stateOwner: owner, ...options }))
  return { ctx, runtime, owner, run, cwd }
}

function tools(functions: Record<string, PtcBindingFunction>) {
  return [{ global: 'tools', functions }]
}

describe('Node environment initialization', () => {
  it('initializes once and keeps current bindings through retained objects', async () => {
    const { run } = await setup({}, 'globalThis.helper = { read: () => tools.value({}) }; console.log("initialized"); helper')
    expect(await run('var saved = helper; await helper.read()', {
      bindings: tools({ value: async () => 'first' }),
    })).toMatchObject({ logs: ['initialized'], value: 'first' })
    expect(await run('({ value: await helper.read(), same: saved === helper })', {
      bindings: tools({ value: async () => 'second' }),
    })).toMatchObject({ logs: [], value: { value: 'second', same: true } })
  })

  it('initializes temporary environments, other owners, and environments recreated after release', async () => {
    const { run, runtime, owner, cwd } = await setup({}, 'globalThis.counter = { value: 0 }; counter')
    const temporary = () => runtime.run(runtime.resolve({ program: '++counter.value', bindings: [], cwd }))
    expect((await run('++counter.value')).value).toBe(1)
    expect((await run('++counter.value')).value).toBe(2)
    expect((await run('++counter.value', { stateOwner: {} })).value).toBe(1)
    expect((await temporary()).value).toBe(1)
    expect((await temporary()).value).toBe(1)
    expect((await run('counter.value')).value).toBe(2)
    await runtime.release(owner)
    expect((await run('++counter.value')).value).toBe(1)
  })

  it('recreates overwritten globals only after the environment is released', async () => {
    const { run, runtime, owner } = await setup({}, 'globalThis.helper = {}')
    expect((await run('globalThis.helper = undefined; typeof helper')).value).toBe('undefined')
    expect((await run('typeof helper')).value).toBe('undefined')
    await runtime.release(owner)
    expect((await run('typeof helper')).value).toBe('object')
  })

  it('discards partial initialization and retries only in a new environment', async () => {
    const { run } = await setup({}, 'globalThis.partial = (globalThis.partial ?? 0) + 1; await tools.initialize({})')
    const initialize = vi.fn(async () => null).mockRejectedValueOnce(new Error('setup failed'))
    const program = vi.fn(async () => null)
    const options = { bindings: tools({ initialize, program }) }
    const failed = await run('await tools.program({})', options)
    expect(failed.error?.kind).toBe('exception')
    expect(failed.error?.message).toContain('retained variables were cleared')
    expect(program).not.toHaveBeenCalled()
    expect(initialize).toHaveBeenCalledOnce()
    expect((await run('partial', options)).value).toBe(1)
    expect(initialize).toHaveBeenCalledTimes(2)
  })

  it('keeps an initialized environment after the first user program throws', async () => {
    const { run } = await setup({}, 'globalThis.helper = { count: 0 }')
    expect((await run('helper.count++; throw new Error("program failed")')).error?.kind).toBe('exception')
    expect((await run('helper.count')).value).toBe(1)
  })

  it('keeps user source locations independent of initialization lines', async () => {
    const { run } = await setup({}, '\n\n\nglobalThis.ready = true')
    const result = await run('throw new Error("program failure")')
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('ptc-repl:1:7')
  })

  it.each(['timeout', 'abort'] as const)('discards partial initialization on %s', async (action) => {
    const { run } = await setup({}, 'globalThis.partial = (globalThis.partial ?? 0) + 1; try { await tools.wait({}) } catch {}')
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const pendingBinding = Promise.withResolvers<null>()
    const controller = new AbortController()
    const program = vi.fn(async () => null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = run('await tools.program({})', {
      timeoutMs: action === 'timeout' ? 200 : null, signal: controller.signal,
      bindings: tools({ wait: () => { entered.resolve(); return pendingBinding.promise }, program }),
    })
    try {
      await entered.promise
      if (action === 'abort') controller.abort()
      else vi.advanceTimersByTime(200)
      vi.useRealTimers()
      const result = await pending
      expect(result.error?.kind).toBe(action)
      expect(result.error?.message).toContain('retained variables were cleared')
      expect(program).not.toHaveBeenCalled()
      expect((await run('partial', { bindings: tools({ wait: async () => null }) })).value).toBe(1)
    } finally {
      controller.abort()
      pendingBinding.resolve(null)
      vi.useRealTimers()
      await pending
    }
  })

  it('keeps one elapsed deadline across initialization and user execution', async () => {
    const { run } = await setup({}, 'await tools.initialize({}); globalThis.helper = 42')
    const initializationEntered: PromiseWithResolvers<void> = Promise.withResolvers()
    const programEntered: PromiseWithResolvers<void> = Promise.withResolvers()
    const initialize = Promise.withResolvers<null>()
    const program = Promise.withResolvers<null>()
    const controller = new AbortController()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = run('await tools.program({})', {
      timeoutMs: 100, signal: controller.signal,
      bindings: tools({
        initialize: () => { initializationEntered.resolve(); return initialize.promise },
        program: () => { programEntered.resolve(); return program.promise },
      }),
    })
    try {
      await initializationEntered.promise
      vi.advanceTimersByTime(60)
      initialize.resolve(null)
      await programEntered.promise
      vi.advanceTimersByTime(40)
      const result = await pending
      vi.useRealTimers()
      expect(result.error?.kind).toBe('timeout')
      expect(result.error?.message).toContain('(100ms)')
      expect(result.error?.message).toContain('retained variables were preserved')
      expect((await run('helper')).value).toBe(42)
    } finally {
      controller.abort()
      initialize.resolve(null)
      program.resolve(null)
      vi.useRealTimers()
      await pending
    }
  })

  it('shares output accounting and initializes again after output overflow', async () => {
    const { run } = await setup({ maxOutputBytes: 256 }, 'globalThis.resource = 42; console.log("x".repeat(120))')
    const result = await run('console.log("y".repeat(120)); "z".repeat(50)')
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs[0]).toBe('x'.repeat(120))
    expect(result.error?.message).toContain('retained variables were cleared')
    expect((await run('resource')).value).toBe(42)
  })

  it('does not start the program after initialization exhausts captured output', async () => {
    const { run, cwd } = await setup({ maxOutputBytes: 256 }, 'var fs = await import("node:fs"); console.log("x".repeat(1000))')
    const result = await run('fs.writeFileSync("program-started", "unexpected")')
    expect(result.error?.kind).toBe('output-limit')
    await expect(access(join(cwd, 'program-started'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    'globalThis.cycle = {}; cycle.self = cycle; cycle',
    '({ get bad() { throw new Error("must not inspect") } })',
    '({ get then() { throw new Error("must not adopt") } })',
    'new Promise(() => {})',
  ])('discards initialization completion without traversing it: %s', async (initialization) => {
    const { run } = await setup({}, initialization)
    expect(await run('42')).toMatchObject({ value: 42, logs: [] })
  })

  it('rejects malformed, duplicate, late, and disposed registrations', async () => {
    const { ctx, runtime, run } = await setup()
    expect(() => runtime.registerEnvironmentInitializer('const =')).toThrow()
    const remove = runtime.registerEnvironmentInitializer('globalThis.helper = 42')
    onTestFinished(remove)
    expect(() => runtime.registerEnvironmentInitializer('')).toThrow('already registered')
    expect((await run('helper')).value).toBe(42)
    await remove()
    expect(() => runtime.registerEnvironmentInitializer('')).toThrow('before the first run')
    await ctx.fiber.dispose()
    expect(() => runtime.registerEnvironmentInitializer('')).toThrow('after disposal')
  })

  it('does not let an old disposer remove a new unused registration', async () => {
    const { runtime, run } = await setup()
    const first = runtime.registerEnvironmentInitializer('globalThis.value = 1')
    await first()
    const second = runtime.registerEnvironmentInitializer('globalThis.value = 2')
    onTestFinished(second)
    await first()
    expect((await run('value')).value).toBe(2)
  })

  it('cancels active execution and clears environments before unregistering', async () => {
    const { runtime, run } = await setup()
    const remove = runtime.registerEnvironmentInitializer('globalThis.helper = 42')
    onTestFinished(remove)
    expect((await run('helper')).value).toBe(42)
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const binding = Promise.withResolvers<null>()
    const pending = run('await tools.wait({})', {
      timeoutMs: null, bindings: tools({ wait: () => { entered.resolve(); return binding.promise } }),
    })
    try {
      await entered.promise
      const closing = remove()
      await expect(run('42')).rejects.toThrow('cleanup is incomplete')
      await Promise.all([closing, remove()])
      expect((await pending).error?.kind).toBe('abort')
      expect((await run('typeof helper')).value).toBe('undefined')
    } finally { binding.resolve(null); await remove(); await pending }
  })
})

it.each<Config>([
  { executionMode: 'per-call' },
  { executionMode: 'vm-script', scriptPersistence: false },
  { executionMode: 'vm-script', scriptPersistence: true },
])('rejects initializer registration with configuration %j', async (config) => {
  const { runtime } = await setup(config)
  expect(() => runtime.registerEnvironmentInitializer('')).toThrow('initialization requires persistent-in-memory execution')
})
