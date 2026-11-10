import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'

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
  it.each(['process', 'persistent-process'])('loads a copied %s bundle before rejecting a missing control channel', async (entry) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-standalone-worker-'))
    onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
    const path = join(directory, 'worker.mjs')
    await copyFile(join(pkgDir, `lib/${entry}.js`), path)
    const result = await execa(process.execPath, ['--experimental-vm-modules', path, '100000'], {
      cwd: directory, env: { DSH_SUBPROCESS_CONTROL: '' }, stdin: 'ignore',
      timeout: 55_000, killSignal: 'SIGKILL', reject: false,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('subprocess control channel was not inherited')
  })

  it.each(['per-call', 'vm-script'] as const)('runs TypeScript and bindings through published exports in %s mode', async (executionMode) => {
    const program = 'const doubled: number = await tools.double({ n: 21 }); inspect("halfway", doubled); let failure; try { await tools.fail({}) } catch (error) { failure = { typed: error instanceof ToolCallError, name: error.name, toolName: error.toolName, message: error.message } }; const env = Object.keys((await import("node:process")).env); ' + (executionMode === 'per-call' ? 'return { doubled, failure, env };' : '({ doubled, failure, env })')
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
      await ctx.plugin(NodePtcRuntime, ${JSON.stringify({ executionMode })})
      const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
        program: ${JSON.stringify(program)},
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
    const resultProcess = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: pkgDir,
      stdin: 'ignore',
      timeout: 55_000,
      killSignal: 'SIGKILL',
      reject: false,
    })

    expect(resultProcess.timedOut).toBe(false)
    expect(resultProcess.signal).toBeUndefined()
    expect(resultProcess.exitCode, resultProcess.stderr).toBe(0)
    const lastLine = resultProcess.stdout.trim().split('\n').at(-1) ?? ''
    const result = JSON.parse(lastLine) as { value?: unknown; output: { type: 'text'; text: string }[]; error?: unknown }
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({
      doubled: 42,
      failure: { typed: true, name: 'ToolCallError', toolName: 'fail', message: 'denied' },
      env: [],
    })
    expect(result.output).toContainEqual({ type: 'text', text: 'halfway 42\n' })
  })
})
