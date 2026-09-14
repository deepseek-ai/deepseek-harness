import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

/**
 * Keyless built-artifact smoke: plain Node imports the package by name through its exports map,
 * then exercises type stripping, sibling `process.js` loading, bindings, and logs. Unit tests use
 * `src/process.ts`; this pins the downstream `lib/index.js` path. It skips when `lib/` is absent,
 * and CI runs it after the build.
 */

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const built = ['lib/index.js', 'lib/process.js'].every(file => existsSync(join(pkgDir, file)))
  && existsSync(join(pkgDir, '../ptc-runtime/lib/index.js'))

describe.skipIf(!built)('built lib real load path (plain node)', () => {
  it('runs a TypeScript program with a binding through lib/index.js and its lib/process.js entry', async () => {
    const script = `
      const { Context } = await import('@deepseek-ai/cordis')
      const { NodePtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime-node')
      const ctx = new Context()
      for (const name of ['session-projection', 'fs-local', 'subprocess-local', 'sandbox-local']) {
        const plugin = await import('@deepseek-ai/dsh-' + name)
        await ctx.plugin(plugin.default, {})
      }
      const { default: SandboxPolicy } = await import('@deepseek-ai/dsh-sandbox-policy')
      await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
      await ctx.plugin(NodePtcRuntime, {})
      const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
        program: 'const doubled: number = await tools.double({ n: 21 }); console.log("halfway", doubled); let failure; try { await tools.fail({}) } catch (error) { failure = { typed: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message } } return { doubled, failure };',
        bindings: [{
          global: 'tools',
          functions: {
            double: async args => args.n * 2,
            fail: async () => { throw new Error('denied') },
          },
          errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
        }],
      }))
      await ctx.fiber.dispose()
      console.log(JSON.stringify(result))
    `
    const { exitCode, stdout, stderr } = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkgDir,
      stdin: 'ignore',
      timeout: 55_000,
      killSignal: 'SIGKILL',
      reject: false,
    })

    expect(exitCode, `stderr:\n${stderr}`).toBe(0)
    const lastLine = stdout.trim().split('\n').at(-1) ?? ''
    const result = JSON.parse(lastLine) as { value?: unknown; logs: string[]; error?: unknown }
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({
      doubled: 42,
      failure: { typed: true, name: 'ToolCallError', toolName: 'fail', message: 'denied' },
    })
    expect(result.logs).toContain('halfway 42')
  })
})
