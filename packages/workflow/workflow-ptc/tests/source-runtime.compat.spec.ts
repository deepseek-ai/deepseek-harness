/** The Node compatibility matrix runs this complete source-entry smoke. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import PtcWorkflowEngine from '../src/index.ts'
import { fakeParent, mountPtcRuntime } from './setup.ts'

async function setup(mode: SandboxMode) {
  const ctx = new Context()
  const files = await mountPtcRuntime(ctx, mode)
  await ctx.plugin(SubagentRuntime)
  ctx.subagents.registerProvider({
    name: 'spawn',
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('source runtime smoke must not start a child')),
  })
  await ctx.plugin(PtcWorkflowEngine, {})
  return { ctx, parent: fakeParent(ctx), ...files }
}

it('runs the default workflow config through the source PTC runtime', async () => {
  const { ctx, parent } = await setup('read-only')
  const run = ctx.workflowEngine.start({
    script: 'return args.left * args.right',
    args: { left: 6, right: 7 },
    meta: { name: 'source-runtime-compat', description: 'source workflow and PTC entry' },
    parent,
  })
  try {
    const result = await run.result
    expect(result, result.error).toMatchObject({ value: 42, stopReason: 'completed', agentsStarted: 0 })
  } finally { await run.dispose() }
})

it.each(['read-only', 'workspace-write'] as const)('enforces the Session file policy %s for direct Node writes', async (mode) => {
  const { ctx, parent, root, cwd } = await setup(mode)
  const outside = join(root, 'outside.txt')
  const inside = join(cwd, 'inside.txt')
  await writeFile(outside, 'unchanged')
  const run = ctx.workflowEngine.start({
    script: `const proc = globalThis.constructor.constructor('return process')()
const fs = proc.getBuiltinModule('node:fs')
try { fs.writeFileSync('inside.txt', 'inside') } catch {}
try { fs.writeFileSync(args.outside, 'changed') } catch {}
return 42`,
    args: { outside },
    meta: { name: 'source-confinement', description: 'direct Node file writes' },
    parent,
  })
  try {
    const result = await run.result
    expect(result.stopReason, result.error).toBe('completed')
    expect(await readFile(outside, 'utf8')).toBe('unchanged')
    if (mode === 'workspace-write') expect(await readFile(inside, 'utf8')).toBe('inside')
    else await expect(readFile(inside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await run.dispose() }
})
