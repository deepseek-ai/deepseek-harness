import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const built = [
  new URL('../lib/index.js', import.meta.url),
  new URL('../../../ptc-runtime/ptc-runtime-node/lib/index.js', import.meta.url),
  new URL('../../../ptc-runtime/ptc-runtime-node/lib/process.js', import.meta.url),
].every(path => existsSync(path))
const runNode = promisify(execFile)

/** Plain Node loads the published workflow package and PTC child bootstrap. */
describe.skipIf(!built)('built workflow PTC runtime', () => {
  it('runs a structured child and confines direct writes through installed exports', async () => {
    const driverRoot = await mkdtemp(join(packageRoot, '.built-runtime-'))
    let root: string | undefined
    try {
      root = await mkdtemp(join(homedir(), '.dsh-built-workflow-'))
      const cwd = join(root, 'workspace')
      const outside = join(root, 'outside.txt')
      await mkdir(cwd)
      await writeFile(outside, 'unchanged')
      const driver = join(driverRoot, 'driver.mjs')
      await writeFile(driver, `
import { Context } from '@deepseek-ai/cordis'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
const ctx = new Context()
try {
  for (const name of ['session', 'session-projection', 'fs-local', 'subprocess-local', 'sandbox-local']) {
    await ctx.plugin((await import('@deepseek-ai/dsh-' + name)).default, {})
  }
  await ctx.plugin((await import('@deepseek-ai/dsh-sandbox-policy')).default, { mode: 'read-only', workspaceRoot: process.argv[2] })
  await ctx.plugin((await import('@deepseek-ai/dsh-ptc-runtime-node')).default, {})
  await ctx.plugin((await import('@deepseek-ai/dsh-subagent')).default, {})
  let selectedStarts = 0
  ctx.subagents.registerProvider({
    name: 'built-selected',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start() {
      selectedStarts += 1
      return {
        id: 'built-child', localAgent: undefined,
        result: Promise.resolve({ output: [], structured: { answer: 42 }, stopReason: 'completed' }),
        dispose: () => Promise.resolve(),
      }
    },
  })
  await ctx.plugin(PtcWorkflowEngine, { provider: 'must-not-be-used' })
  const session = ctx.sessions.create(undefined, { meta: { cwd: process.argv[2] } })
  const run = ctx.workflowEngine.start({
    script: "const proc = globalThis.constructor.constructor('return process')(); try { proc.getBuiltinModule('node:fs').writeFileSync(args.outside, 'changed') } catch {} const value = await agent('answer', { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } }); return value.answer",
    args: { outside: process.argv[3] },
    meta: { name: 'built-smoke', description: 'built workflow runtime' },
    subagentProvider: 'built-selected',
    parent: { id: session.id, session, options: {} },
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed' || result.value !== 42 || selectedStarts !== 1) {
      throw new Error('unexpected result: ' + JSON.stringify(result))
    }
    console.log('built-runtime-smoke-ok')
  } finally { await run.dispose() }
} finally { await ctx.fiber.dispose() }
`, 'utf8')
      const { stdout } = await runNode(process.execPath, [driver, cwd, outside], { cwd: packageRoot, timeout: 60_000 })
      expect(stdout).toContain('built-runtime-smoke-ok')
      expect(await readFile(outside, 'utf8')).toBe('unchanged')
    } finally {
      await rm(driverRoot, { recursive: true, force: true })
      if (root !== undefined) await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
