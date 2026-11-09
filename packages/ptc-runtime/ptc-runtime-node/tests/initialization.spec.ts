import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'

async function setup(config: Config = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-ptc-initialization-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) })
  const { runtime } = await mountRuntime(ctx, { executionMode: 'persistent-in-memory', ...config })
  const owner = {}
  const run = (program: string, options: Partial<PtcRunRequest> = {}) =>
    runtime.run(runtime.resolve({ program, bindings: [], cwd, stateOwner: owner, ...options }))
  return { ctx, runtime, owner, run, cwd }
}

function tools(functions: Record<string, PtcBindingFunction>) {
  return [{ global: 'tools', functions }]
}

describe('Node REPL initialization', () => {
  it('initializes before each program with current bindings and preserves object identity', async () => {
    const { run } = await setup()
    const initialization = `
      globalThis.helper ??= { read: () => tools.value({}) };
      globalThis.initializations = (globalThis.initializations ?? 0) + 1;
      console.log("initialize", initializations);
      helper
    `
    expect(await run('var saved = helper; await helper.read()', {
      initialization, bindings: tools({ value: async () => 'first' }),
    })).toMatchObject({ logs: ['initialize 1'], value: 'first' })
    expect(await run('({ value: await helper.read(), same: saved === helper, initializations })', {
      initialization, bindings: tools({ value: async () => 'second' }),
    })).toMatchObject({ logs: ['initialize 2'], value: { value: 'second', same: true, initializations: 2 } })
  })

  it('recreates initialization for temporary environments and after owner release', async () => {
    const { run, runtime, owner, cwd } = await setup()
    const initialization = 'globalThis.counter ??= { value: 0 }; counter'
    const options = { initialization }
    const temporary = () => runtime.run(runtime.resolve({ program: '++counter.value', bindings: [], cwd, initialization }))
    expect((await run('++counter.value', options)).value).toBe(1)
    expect((await run('++counter.value', options)).value).toBe(2)
    expect((await temporary()).value).toBe(1)
    expect((await temporary()).value).toBe(1)
    expect((await run('counter.value', options)).value).toBe(2)
    await runtime.release(owner)
    expect((await run('++counter.value', options)).value).toBe(1)
  })

  it.each(['const =', 'throw new Error("initialization failed")'])('does not execute the program when initialization fails: %s', async (initialization) => {
    const { run } = await setup()
    const program = vi.fn(async () => null)
    const result = await run('await tools.program({})', { initialization, bindings: tools({ program }) })
    expect(result.error?.kind).toBe('exception')
    expect(result.value).toBeUndefined()
    expect(program).not.toHaveBeenCalled()
    expect((await run('42')).value).toBe(42)
  })

  it('preserves initialization mutations after an exception without executing the program', async () => {
    const { run } = await setup()
    const result = await run('globalThis.programRan = true', {
      initialization: 'globalThis.partial = 7; throw new Error("failed")',
    })
    expect(result.error?.kind).toBe('exception')
    expect((await run('({ partial, program: typeof programRan })')).value).toEqual({ partial: 7, program: 'undefined' })
  })

  it('keeps user source locations independent of initialization lines', async () => {
    const { run } = await setup()
    const result = await run('throw new Error("program failure")', { initialization: '\n\n\nglobalThis.ready = true' })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('ptc-repl:1:7')
  })

  it.each(['timeout', 'abort'] as const)('stops during initialization on %s and does not start the program after a handled rejection', async (action) => {
    const { run } = await setup()
    expect((await run('globalThis.kept = 1; kept')).value).toBe(1)
    const entered: PromiseWithResolvers<void> = Promise.withResolvers()
    const pendingBinding = Promise.withResolvers<null>()
    const controller = new AbortController()
    onTestFinished(() => { controller.abort(); pendingBinding.resolve(null) })
    const program = vi.fn(async () => null)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = run('await tools.program({})', {
      initialization: 'try { await tools.wait({}) } catch {} finally { kept++ }',
      timeoutMs: action === 'timeout' ? 200 : null,
      signal: controller.signal,
      bindings: tools({ wait: () => { entered.resolve(); return pendingBinding.promise }, program }),
    })
    try {
      await entered.promise
      if (action === 'abort') controller.abort()
      else vi.advanceTimersByTime(200)
      const result = await pending
      expect(result.error?.kind).toBe(action)
      expect(result.error?.message).toContain('retained variables were preserved')
      expect(program).not.toHaveBeenCalled()
      expect((await run('kept')).value).toBe(2)
    } finally {
      controller.abort()
      pendingBinding.resolve(null)
      vi.useRealTimers()
      await pending
    }
  })

  it('keeps one elapsed deadline across initialization and user execution', async () => {
    const { run } = await setup()
    expect((await run('42')).value).toBe(42)
    const initializationEntered: PromiseWithResolvers<void> = Promise.withResolvers()
    const programEntered: PromiseWithResolvers<void> = Promise.withResolvers()
    const initialize = Promise.withResolvers<null>()
    const program = Promise.withResolvers<null>()
    const controller = new AbortController()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = run('await tools.program({})', {
      initialization: 'await tools.initialize({})', timeoutMs: 100, signal: controller.signal,
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
      expect(result.error?.kind).toBe('timeout')
      expect(result.error?.message).toContain('(100ms)')
    } finally {
      controller.abort()
      initialize.resolve(null)
      program.resolve(null)
      vi.useRealTimers()
      await pending
    }
  })

  it('reinitializes after a deadline terminates an unresponsive initialization', async () => {
    const { run } = await setup({ stopGraceMs: 50 })
    const initialization = 'globalThis.resource ??= { value: 42 }; resource'
    expect((await run('resource.value', { initialization })).value).toBe(42)
    const result = await run('globalThis.programRan = true', { initialization: 'while (true) {}', timeoutMs: 200 })
    expect(result.error?.kind).toBe('timeout')
    expect(result.error?.message).toContain('retained variables were cleared')
    expect((await run('({ value: resource.value, program: typeof programRan })', { initialization })).value)
      .toEqual({ value: 42, program: 'undefined' })
  })

  it('shares the output budget between initialization and program and recreates lost state', async () => {
    const { run } = await setup({ maxOutputBytes: 256 })
    const initialization = 'globalThis.resource ??= { value: 42 }; console.log("x".repeat(120)); resource'
    const result = await run('console.log("y".repeat(120)); "z".repeat(50)', { initialization })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs[0]).toBe('x'.repeat(120))
    expect(result.error?.message).toContain('retained variables were cleared')
    expect((await run('resource.value', { initialization })).value).toBe(42)
  })

  it('does not start the program after initialization exhausts captured output', async () => {
    const { run, cwd } = await setup({ maxOutputBytes: 256 })
    expect((await run('var fs = await import("node:fs")')).error).toBeUndefined()
    const result = await run('fs.writeFileSync("program-started", "unexpected")', {
      initialization: 'console.log("x".repeat(1000))',
    })
    expect(result.error?.kind).toBe('output-limit')
    await expect(access(join(cwd, 'program-started'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discards non-JSON initialization completion values without traversing them', async () => {
    const { run } = await setup()
    expect(await run('42', { initialization: 'globalThis.cycle = {}; cycle.self = cycle; cycle' }))
      .toMatchObject({ value: 42, logs: [] })
    expect((await run('42', { initialization: '({ get bad() { throw new Error("must not inspect") } })' })).value).toBe(42)
  })
})

it.each<Config>([
  { executionMode: 'per-call' },
  { executionMode: 'vm-script', scriptPersistence: false },
  { executionMode: 'vm-script', scriptPersistence: true },
])('rejects explicit initialization during resolution with configuration %j', async (config) => {
  const { runtime } = await setup(config)
  for (const initialization of ['', 'globalThis.helper = {}']) {
    expect(() => runtime.resolve({ program: '', bindings: [], initialization })).toThrow('initialization requires persistent-in-memory execution')
    const spec = runtime.resolve({ program: '', bindings: [] })
    await expect(runtime.run({ ...spec, initialization })).rejects.toThrow('initialization requires persistent-in-memory execution')
  }
  expect(runtime.resolve({ program: '', bindings: [] }).initialization).toBeUndefined()
})
