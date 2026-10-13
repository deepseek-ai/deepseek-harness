import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/persistent-process.js'].every(file => existsSync(join(pkgDir, file)))

describe.skipIf(!built)('persistent PTC published exports', () => {
  it('retains variables through the built provider and sibling process entry', async () => {
    const script = `
      const { Context } = await import('@deepseek-ai/cordis')
      const { default: NodeRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')
      const ctx = new Context()
      try {
        for (const name of ['session-projection', 'fs-local', 'subprocess-local', 'sandbox-local', 'sandbox-policy']) {
          await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default)
        }
        await ctx.plugin(NodeRuntime, { executionMode: 'persistent-in-memory' })
        const stateOwner = {}
        const run = program => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({program, bindings: [], stateOwner}))
        const first = await run('let count: number = 40; const path = await import("node:path");')
        const second = await run('count += 2; console.log(path.basename("/a/b")); count')
        await ctx.ptcRuntime.release(stateOwner)
        const fresh = await run('typeof count')
        console.log(JSON.stringify({ first, second, fresh }))
      } finally { await ctx.fiber.dispose() }
    `
    const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkgDir, stdin: 'ignore', timeout: 55_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
      first: { logs: [] }, second: { logs: ['b'], value: 42 }, fresh: { logs: [], value: 'undefined' },
    })
  })
})
