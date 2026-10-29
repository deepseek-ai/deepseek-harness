/** Executor plugins follow the Loader-owned preset revision lifetime. */
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import * as PtcPlugin from '@deepseek-ai/dsh-tool-executor-ptc'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutor } from '@deepseek-ai/dsh-tools'
import { agentOn, declare, harness } from './harness.ts'

it('loads scoped executor objects and retains them with the preset revision', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Shared capability.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'shared',
  }))
  const native = new NativeToolExecutor(ctx)
  let mounted = 0
  let disposed = 0
  const executions: string[] = []
  ctx.loader.builtins.executor = {
    inject: ['tools'],
    apply(owner: Context) {
      const label = `executor-${++mounted}`
      const executor: ToolExecutor = {
        sections: [{ name: 'tools:transport', order: 800, text: label, interpolate: false }],
        describe: tools => native.describe(tools),
        execute: (input) => { executions.push(label); return native.execute(input) },
      }
      owner.tools.setExecutor(executor)
      owner.effect(() => () => { disposed++ })
    },
  }
  const definition = { id: 'custom', plugins: [{ id: 'executor', name: 'cordis:executor' }] }
  const firstRow = await declare(ctx, definition)
  await declare(ctx, { id: 'standard', plugins: [] })
  const first = await agentOn(ctx, 'first-executor', 'custom')
  const sameRevision = await agentOn(ctx, 'same-executor', 'custom')
  const plain = await agentOn(ctx, 'plain-executor', 'standard')
  expect(mounted).toBe(1)
  expect(first.ctx.tools.get('echo', first)).toBe(plain.ctx.tools.get('echo', plain))
  expect((await ctx.systemPrompt.assemble({ scope: first })).sections)
    .toContainEqual(expect.objectContaining({ name: 'tools:transport', text: 'executor-1' }))
  const result = await executeModelToolFixture(ctx, {
    agent: first, callId: ToolCallId('loader-executor'), name: 'echo', arguments: {}, signal: new AbortController().signal,
  })
  expect(result).toMatchObject({ value: 'shared', isError: false })
  await firstRow.dispose()
  await declare(ctx, definition)
  const newer = await agentOn(ctx, 'new-executor', 'custom')
  expect(mounted).toBe(2)
  expect(disposed).toBe(0)
  expect((await ctx.systemPrompt.assemble({ scope: first })).sections)
    .toContainEqual(expect.objectContaining({ text: 'executor-1' }))
  expect((await ctx.systemPrompt.assemble({ scope: newer })).sections)
    .toContainEqual(expect.objectContaining({ text: 'executor-2' }))
  for (const agent of [first, sameRevision, plain, newer]) {
    const batch = await ctx.tools.execute({
      agent, calls: [{ type: 'tool-call', id: ToolCallId('revision'), name: 'echo', arguments: '{}' }],
      signal: new AbortController().signal,
    })
    expect(batch.results[0]?.result).toMatchObject({ value: 'shared', isError: false })
  }
  expect(executions).toEqual(['executor-1', 'executor-1', 'executor-1', 'executor-2'])
})

/** A deterministic external program backend that invokes the provided tool binding. */
class ProgramFixture extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'

  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    expect(request.program).toBe('return await tools.echo({ value: "ptc" })')
    const value = await request.bindings[0]!.functions.echo!({ value: 'ptc' })
    return { logs: [], value }
  }
}

it.each([true, false])('loads cordis.yml executor presets with runtime availability %s', async (hasRuntime) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-executor-packages-'))
  const ctx = await harness()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await ctx.plugin(FsLocal)
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
  if (hasRuntime) await ctx.plugin(ProgramFixture)
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Shared capability.', parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => `echo:${args.value}`,
  }))
  Object.assign(ctx.loader.builtins, { include: Include, preset: AgentPreset, ptc: PtcPlugin })
  const path = join(root, 'cordis.yml')
  await writeFile(path, `- id: native-preset
  name: cordis:preset
  config:
    id: standard
    plugins: []
- id: ptc-preset
  name: cordis:preset
  config:
    id: ptc
    plugins:
      - id: executor
        name: cordis:ptc
        config:
          maxParallelSubCalls: 2
`)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const native = await agentOn(ctx, 'native-package', 'standard')
  expect((await ctx.systemPrompt.assemble({ scope: native })).tools.map(tool => tool.name)).toEqual(['echo'])
  if (!hasRuntime) {
    const pending = agentOn(ctx, 'ptc-package', 'ptc')
    await expect(pending).rejects.toMatchObject({ code: 'agent-preset/invalid' })
    await expect(pending).rejects.toThrow('executor (cordis:ptc): waiting for ptcRuntime')
    return
  }
  const ptc = await agentOn(ctx, 'ptc-package', 'ptc')
  expect((await ctx.systemPrompt.assemble({ scope: ptc })).tools.map(tool => tool.name)).toEqual(['run_code'])
  const signal = new AbortController().signal
  expect(await executeModelToolFixture(ctx, {
    agent: native, name: 'echo', arguments: { value: 'native' }, callId: ToolCallId('native'), signal,
  })).toMatchObject({ isError: false, value: 'echo:native' })
  expect(await executeModelToolFixture(ctx, {
    agent: ptc, name: 'run_code', callId: ToolCallId('program'), signal,
    arguments: { code: 'return await tools.echo({ value: "ptc" })', description: 'Echo through the program' },
  })).toMatchObject({ isError: false, content: [{ type: 'text', text: 'echo:ptc' }] })
  expect(ptc.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch')).toMatchObject({
    data: { name: 'echo', isError: false, content: [{ type: 'text', text: 'echo:ptc' }] },
  })
})
