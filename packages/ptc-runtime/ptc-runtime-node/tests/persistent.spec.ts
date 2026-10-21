import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import type { PtcBindingFunction, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Config } from '../src/index.ts'
import { mountRuntime } from './setup.ts'

async function setup(config: Config = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-persistent-ptc-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) })
  const { runtime, fiber } = await mountRuntime(ctx, { ...config, executionMode: 'persistent-in-memory' })
  const owner = {}
  const run = (program: string, options: Partial<PtcRunRequest> = {}) =>
    runtime.run(runtime.resolve({ program, bindings: [], cwd, stateOwner: owner, ...options }))
  return { ctx, fiber, runtime, owner, run, cwd }
}

function bindings(value: PtcBindingFunction) {
  return [{ global: 'tools', functions: { value }, errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }]
}

describe('persistent Node REPL', () => {
  it('keeps a snapshot of caller-owned root arrays and rejects changed grants', async () => {
    const { run, runtime, owner, cwd } = await setup()
    const roots = [cwd]
    const policy = { mode: 'danger-full-access' as const, workspaceRoot: cwd, additionalWritableRoots: roots }
    expect((await run('var retained = 7; retained', { sandboxPolicy: policy })).value).toBe(7)
    expect((await run('retained', { sandboxPolicy: { ...policy, additionalWritableRoots: [cwd, cwd] } })).value).toBe(7)
    roots[0] = tmpdir()
    await expect(run('retained', { sandboxPolicy: policy })).rejects.toThrow('release the retained environment')
    await runtime.release(owner)
    expect((await run('typeof retained', { sandboxPolicy: policy })).value).toBe('undefined')
  })
  it.each([
    'function f() {', '(', '[', '`unfinished',
    'const x = await Promise.resolve(1); return x',
  ])('reports an incomplete or top-level-return program before starting a process: %s', async (program) => {
    const { ctx, run } = await setup()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    onTestFinished(() => { spawn.mockRestore() })
    const result = await run(program)
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message.trim().length).toBeGreaterThan(0)
    if (program.includes('return x')) expect(result.error?.message).toMatch(/return/i)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps the environment when an evaluation ends with an unawaited binding call', async () => {
    const { run } = await setup()
    const release = Promise.withResolvers<null>()
    onTestFinished(() => { release.resolve(null) })
    expect((await run('var kept = 1; void tools.value({}); kept', { bindings: bindings(() => release.promise) })).value).toBe(1)
    expect((await run('kept')).value).toBe(1)
  })

  it('retains declarations, closures, object identity, and imports across evaluations', async () => {
    const { run, cwd } = await setup()
    expect(await run('const box: { count: number } = { count: 1 }; let alias = box; function increment() { return ++box.count }; const path = await import("node:path");')).toMatchObject({ logs: [] })
    expect(await run('console.log("second call"); ({ count: increment(), same: box === alias, dir: path.basename(process.cwd()), env: Object.keys(process.env) })')).toMatchObject({ logs: ['second call'], value: { count: 2, same: true, dir: cwd.split(/[\\/]/).at(-1), env: [] } })
  })

  it('retains implicit REPL globals and does not attribute a completed callback exception to a later evaluation', async () => {
    const { run } = await setup()
    expect((await run('implicitValue = 7')).value).toBe(7)
    await run(`
      let fireLate; let acknowledge;
      const fired = new Promise(resolve => { fireLate = resolve });
      const acknowledged = new Promise(resolve => { acknowledge = resolve });
      void fired.then(() => setImmediate(() => { acknowledge(); throw new Error('completed callback failure') }));
    `)
    expect(await run('fireLate(); await acknowledged; implicitValue')).toMatchObject({ logs: [], value: 7 })
    expect(await run('implicitValue')).toMatchObject({ logs: [], value: 7 })
  })

  it('uses current host bindings through retained functions and saved method references', async () => {
    const { run } = await setup()
    const first = vi.fn(async () => 'old')
    const second = vi.fn(async () => 'new')
    expect((await run('const saved = tools.value; async function query() { return await saved({}) }; await query()', { bindings: bindings(first) })).value).toBe('old')
    expect((await run('await query()', { bindings: bindings(second) })).value).toBe('new')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect((await run('let failure; try { await query() } catch (error) { console.log(error.toolName); failure = "unavailable" }; failure')).value).toBe('unavailable')
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('runs top-level await blocks with reusable local declarations and keeps outer state', async () => {
    const { run } = await setup()
    await run('let total = 0;')
    const code = '{ const amount = await tools.value({}); total += amount; console.log(amount); }'
    expect(await run(code, { bindings: bindings(async () => 2) })).toMatchObject({ logs: ['2'] })
    expect(await run(code, { bindings: bindings(async () => 3) })).toMatchObject({ logs: ['3'] })
    expect(await run('({ total, local: typeof amount })')).toMatchObject({ logs: [], value: { total: 5, local: 'undefined' } })
  })

  it('uses the current error descriptor through a saved binding and retains matching constructor identity', async () => {
    const { run } = await setup()
    const fail = async () => { throw new Error('rejected') }
    const first = { bindings: [{ global: 'tools', functions: { value: fail },
      errorClass: { name: 'FirstError', memberNameProperty: 'firstMember' } }] }
    const second = { bindings: [{ global: 'tools', functions: { value: fail },
      errorClass: { name: 'SecondError', memberNameProperty: 'secondMember' } }] }
    await run('const saved = tools.value; const initialClass = FirstError;', first)
    expect((await run('FirstError === initialClass', first)).value).toBe(true)
    const observed = await run(`
      let observed;
      try { await saved({}) } catch (error) {
        observed = { name: error.name, member: error.secondMember, first: 'firstMember' in error,
          current: error instanceof SecondError, previous: error instanceof initialClass };
      }
      observed
    `, second)
    expect(observed.value).toEqual({ name: 'SecondError', member: 'value', first: false, current: true, previous: false })
    const plain = await run(`
      let plain;
      try { await saved({}) } catch (error) { plain = { name: error.name, member: 'secondMember' in error }; }
      plain
    `, { bindings: [{ global: 'tools', functions: { value: fail } }] })
    expect(plain.value).toEqual({ name: 'Error', member: false })
  })

  it('settles an asynchronous exception once while a later evaluation awaits a tool', async () => {
    const { run } = await setup()
    const failed = await run('let retained = 17; let resume; const paused = new Promise(resolve => { resume = resolve }); setImmediate(() => { throw new Error("async failure") }); await paused; retained')
    expect(failed.error?.message).toContain('async failure')
    const next = await run('resume(); await tools.value({})', { bindings: bindings(async () => { await setImmediate(); return 42 }) })
    expect(next).toMatchObject({ logs: [], value: 42 })
    expect((await run('retained')).value).toBe(17)
  })

  it('rejects a completed evaluation callback without consuming the next real binding identity', async () => {
    const { run } = await setup()
    const called = vi.fn(async () => 42)
    const options = { bindings: bindings(called) }
    await run('let retained = 17; let trigger; let rejection; const expired = new Promise(resolve => { trigger = resolve }); void expired.then(async () => { try { await tools.value({}) } catch (error) { rejection = error.message } });', options)
    expect((await run('trigger(); await new Promise(resolve => setImmediate(resolve)); rejection', options)).value).toContain('evaluation has ended')
    expect(called).not.toHaveBeenCalled()
    expect(await run('({ retained, answer: await tools.value({}) })', options)).toMatchObject({ logs: [], value: { retained: 17, answer: 42 } })
    expect(called).toHaveBeenCalledTimes(1)
  })

  it('captures inherited child stdout and stderr without losing retained variables', async () => {
    const { run } = await setup()
    const childProgram = 'process.stdout.write("stdout marker"); process.stderr.write("stderr marker")'
    const result = await run(`let retained = 17; const child = await import("node:child_process"); child.execFileSync(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: "inherit" }); retained`)
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(17)
    expect(result.logs.join('')).toContain('stdout marker')
    expect(result.logs.join('')).toContain('stderr marker')
    expect((await run('retained')).value).toBe(17)
  })

  it('reports direct process exit status and stderr after draining raw output', async () => {
    const { run } = await setup()
    const result = await run('const nativeFs = await import("node:fs"); nativeFs.writeSync(2, "fatal fixture"); process.exit(7)')
    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('7')
    expect(result.error?.message).toContain('fatal fixture')
    expect(result.logs.join('')).toContain('fatal fixture')
    expect((await run('42')).value).toBe(42)
  })

  it('isolates owners and uses fresh state when no owner is supplied', async () => {
    const { run, runtime, cwd } = await setup()
    const temporary = (program: string) => runtime.run(runtime.resolve({ program, bindings: [], cwd }))
    expect((await run('let privateValue = 7;')).error).toBeUndefined()
    expect((await run('typeof privateValue', { stateOwner: {} })).value).toBe('undefined')
    expect((await temporary('let temporary = 8;')).error).toBeUndefined()
    expect((await temporary('typeof temporary')).value).toBe('undefined')
    expect((await run('privateValue')).value).toBe(7)
  })

  it('releases an owner and reports missing variables until the caller recreates them', async () => {
    const { run, runtime, owner } = await setup()
    await run('let app = { ready: true };')
    await runtime.release(owner)
    const missing = await run('app.ready')
    expect(missing.error?.kind).toBe('exception')
    expect(missing.error?.message).toContain('app is not defined')
    expect((await run('let app = { ready: true }; app.ready')).value).toBe(true)
    await runtime.release(owner)
    await runtime.release(owner)
  })

  it('keeps mutations before an exception and recovers after syntax and output errors', async () => {
    const { run } = await setup()
    await run('let count = 0;')
    expect((await run('count++; throw new Error("expected failure")')).error?.message).toContain('expected failure')
    expect((await run('count')).value).toBe(1)
    expect((await run('const =')).error?.kind).toBe('exception')
    expect((await run('() => count')).error?.kind).toBe('invalid-output')
    expect((await run('count')).value).toBe(1)
  })

  it('cancels active execution, awaits process exit, and clears all variables', async () => {
    const { run } = await setup()
    const entered = Promise.withResolvers<true>()
    const controller = new AbortController()
    const pending = run('let app = {}; await tools.value({}); while (true) {}', {
      signal: controller.signal,
      bindings: bindings(async () => { entered.resolve(true); return null }),
    })
    await entered.promise
    controller.abort()
    expect((await pending).error?.kind).toBe('abort')
    expect((await run('typeof app')).value).toBe('undefined')
  })

  it('resets a timed-out environment and does not reuse an exited process', async () => {
    const { run } = await setup()
    await run('let retained = 1;')
    expect((await run('while (true) {}', { timeoutMs: 50 })).error?.kind).toBe('timeout')
    expect((await run('typeof retained')).value).toBe('undefined')
    expect((await run('process.exit(7)')).error?.kind).toBe('worker-exit')
    expect((await run('40 + 2')).value).toBe(42)
  })

  it('rejects overlapping runs for one owner and permits other owners', async () => {
    const { run } = await setup()
    const entered = Promise.withResolvers<true>()
    const proceed = Promise.withResolvers<null>()
    const pending = run('await tools.value({})', { bindings: bindings(async () => { entered.resolve(true); return await proceed.promise }) })
    try {
      await entered.promise
      await expect(run('1')).rejects.toThrow('concurrent runs')
      await expect(run('const =')).rejects.toThrow('concurrent runs')
      expect((await run('2', { stateOwner: {} })).value).toBe(2)
    } finally { proceed.resolve(null) }
    expect((await pending).value).toBeNull()
  })

  it('disposes in-flight execution and removes the service on plugin unload', async () => {
    const { run, fiber, ctx, runtime } = await setup()
    const entered = Promise.withResolvers<true>()
    const pending = run('await tools.value({}); await new Promise(() => {})', { bindings: bindings(async () => { entered.resolve(true); return null }) })
    await entered.promise
    await fiber.dispose()
    expect((await pending).error?.kind).toBe('abort')
    expect(ctx.get('ptcRuntime')).toBeUndefined()
    expect(() => runtime.resolve({ program: '1', bindings: [] })).toThrow('after disposal')
    await expect(runtime.run({ program: '1', bindings: [], cwd: process.cwd(), timeoutMs: null })).rejects.toThrow('after disposal')
  })

  it('resolves confinement and validates options before starting a process', async () => {
    const { run, runtime } = await setup()
    expect(runtime.sandboxMode).toBe('danger-full-access')
    expect(runtime.programFormat).toBe('repl')
    expect(runtime.timeout).toEqual({ defaultMs: 120_000, maxMs: 600_000 })
    expect(runtime.resolve({ program: '1', bindings: [], sandboxPolicy: { mode: 'read-only', workspaceRoot: process.cwd() } }).sandboxPolicy?.mode).toBe('read-only')
    expect(() => runtime.resolve({ program: '1', bindings: [], cwd: 'relative' })).toThrow('absolute')
    expect(() => runtime.resolve({ program: '1', bindings: [], timeoutMs: 0 })).toThrow()
    await expect(run('1', { bindings: [{ global: 'console', functions: {} }] })).rejects.toThrow('reserved')
    expect((await run('1', { signal: AbortSignal.abort() })).error?.kind).toBe('abort')
    expect((await run('42', { timeoutMs: null })).value).toBe(42)
  })

  it.each(['throw new Error("long diagnostic ".repeat(1000))', '"large completion".repeat(1000)'])('clears retained state after a final output overflow: %s', async (program) => {
    const { run } = await setup({ maxOutputBytes: 100 })
    await run('let retained = true;')
    const result = await run(program)
    expect(result.error?.kind).toBe('output-limit')
    expect(result.error?.message).toContain('retained variables were cleared')
    const outputBytes = Buffer.byteLength(JSON.stringify(result.logs)) + Buffer.byteLength(JSON.stringify(result.error?.message))
    expect(outputBytes).toBeLessThanOrEqual(100)
    expect((await run('typeof retained')).value).toBe('undefined')
  })

  it('bounds type-stripping diagnostics and clears the owner after a parse-output overflow', async () => {
    const { run } = await setup({ maxOutputBytes: 32 })
    await run('let retained = true;')
    const result = await run('const =')
    expect(result.error?.kind).toBe('output-limit')
    const outputBytes = Buffer.byteLength(JSON.stringify(result.logs)) + Buffer.byteLength(JSON.stringify(result.error?.message))
    expect(outputBytes).toBeLessThanOrEqual(32)
    expect((await run('typeof retained')).value).toBe('undefined')
  })

  it('rejects a packaged host without a persistent bootstrap during provider loading', async () => {
    const previous = Object.getOwnPropertyDescriptor(process, 'pkg')
    try {
      Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
      await expect(setup()).rejects.toThrow('requires a node-script launch')
      const { runtime } = await setup({ launch: { kind: 'node-script', executable: process.execPath, bootstrapPath: join(process.cwd(), 'persistent-process.js') } })
      expect(runtime.programFormat).toBe('repl')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process, 'pkg')
      else Object.defineProperty(process, 'pkg', previous)
    }
  })

  it('bounds output and clears state after an overflow', async () => {
    const { run } = await setup({ maxOutputBytes: 100 })
    expect((await run('let retained = true; console.log("x".repeat(1000))')).error?.kind).toBe('output-limit')
    expect((await run('typeof retained')).value).toBe('undefined')
  })
})

it.each(['_', '_error'])('keeps %s assignments and subsequent tools in the active evaluation', async (name) => {
  const { run } = await setup()
  const called = vi.fn(async () => 7)
  expect(await run(`${name} = 42; await tools.value({}); ${name}`, { bindings: bindings(called) })).toMatchObject({ logs: [], value: 42 })
  expect(called).toHaveBeenCalledOnce()
  expect((await run(name)).value).toBe(42)
})

it('rejects a new run until cancellation cleanup has completed for its owner', async () => {
  const { run, ctx } = await setup()
  const entered = Promise.withResolvers<true>()
  const cleanup = Promise.withResolvers<true>()
  const released = Promise.withResolvers<boolean>()
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementationOnce((spec) => {
    const handle = spawn(spec)
    return { ...handle, waitForExit: async () => { await handle.waitForExit(); cleanup.resolve(true); return released.promise } }
  })
  const abort = new AbortController()
  const pending = run('await tools.value({}); await new Promise(() => {})', {
    signal: abort.signal, bindings: bindings(async () => { entered.resolve(true); return null }),
  })
  try {
    await entered.promise
    abort.abort()
    await cleanup.promise
    await expect(run('42')).rejects.toThrow('concurrent runs')
    expect(intercepted).toHaveBeenCalledTimes(1)
    released.resolve(true)
    expect((await pending).error?.kind).toBe('abort')
    expect((await run('42')).value).toBe(42)
  } finally { released.resolve(true); await pending; intercepted.mockRestore() }
})
