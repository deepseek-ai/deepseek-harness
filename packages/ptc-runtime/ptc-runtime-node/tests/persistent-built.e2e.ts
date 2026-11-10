import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/process.js'].every(file => existsSync(join(pkgDir, file)))

describe.skipIf(!built)('persistent PTC published exports', () => {
  it.each(['repl', 'script', 'scoped-repl'])('retains variables through published configuration and runtime exports with %s syntax', async (programFormat) => {
    const script = `
      const { Context } = await import('@deepseek-ai/cordis')
      const { default: NodeRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')
      const { resolvePersistentExecution } = await import('@deepseek-ai/dsh-ptc-runtime-node/configuration')
      const ctx = new Context()
      try {
        for (const name of ['session-projection', 'fs-local', 'subprocess-local', 'sandbox-local', 'sandbox-policy']) {
          await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default)
        }
        await ctx.plugin(NodeRuntime, resolvePersistentExecution(${JSON.stringify(programFormat)}))
        const stateOwner = {}
        const initialization = ${JSON.stringify(programFormat === 'repl' ? 'globalThis.helper ??= { value: 7 }; helper' : undefined)}
        if (initialization !== undefined) ctx.effect(() => ctx.ptcRuntime.registerEnvironmentInitializer(initialization))
        const run = (program, timeoutMs, bindings = []) => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({program, timeoutMs, bindings, stateOwner}))
        const first = await run('let count: number = 40; const path = await import("node:path");')
        const initialized = await run('typeof helper === "undefined" ? null : helper.value')
        const second = await run('count += 2; inspect(path.basename("/a/b")); count')
        const interrupted = await run('try { await tools.wait({}) } catch {} finally { count++ }', 200, [{ global: 'tools', functions: { wait: () => new Promise(() => {}) } }])
        const preserved = await run('count')
        await ctx.ptcRuntime.release(stateOwner)
        const fresh = await run('typeof count')
        const reinitialized = await run('typeof helper === "undefined" ? null : helper.value')
        console.log(JSON.stringify({ first, initialized, second, interrupted, preserved, fresh, reinitialized }))
      } finally { await ctx.fiber.dispose() }
    `
    const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkgDir, stdin: 'ignore', timeout: 55_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const observed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as { first: { error?: unknown } }
    expect(observed.first.error).toBeUndefined()
    const helperValue = programFormat === 'repl' ? 7 : null
    expect(observed).toMatchObject({ initialized: { value: helperValue }, reinitialized: { value: helperValue } })
    expect(observed).toMatchObject({ second: { output: [{ type: 'text', text: 'b\n' }], value: 42 }, interrupted: { error: { kind: 'timeout' } }, preserved: { value: 43 }, fresh: { output: [], value: 'undefined' } })
  })

  it('redeclares names through published exports with scoped-repl syntax while earlier closures keep their values', async () => {
    const script = `
      const { Context } = await import('@deepseek-ai/cordis')
      const { default: NodeRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')
      const { resolvePersistentExecution } = await import('@deepseek-ai/dsh-ptc-runtime-node/configuration')
      const ctx = new Context()
      try {
        for (const name of ['session-projection', 'fs-local', 'subprocess-local', 'sandbox-local', 'sandbox-policy']) {
          await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default)
        }
        await ctx.plugin(NodeRuntime, resolvePersistentExecution('scoped-repl'))
        const stateOwner = {}
        const run = (program) => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ program, bindings: [], stateOwner }))
        const first = await run('const value: number = 1\\nconst read = () => value')
        const second = await run('const value = 2;\\n[value, read()]')
        const assigned = await run('value = 3;\\n[value, read()]')
        await ctx.ptcRuntime.release(stateOwner)
        console.log(JSON.stringify({ format: ctx.ptcRuntime.programFormat, first, second, assigned }))
      } finally { await ctx.fiber.dispose() }
    `
    const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkgDir, stdin: 'ignore', timeout: 55_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
      format: 'scoped-repl', first: { output: [] }, second: { value: [2, 1] }, assigned: { value: [3, 1] },
    })
  })
})
