/** Root registry plugins follow the Loader-owned preset revision lifetime. */
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
import * as PtcPlugin from '@deepseek-ai/dsh-tool-registry-ptc'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tool-registry-native'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { agentOn, declare, harness } from './harness.ts'

/** Native root with one entry of its own, `root_label`, which answers with the root's label. */
function labeledRoot(label: string): NativeToolRegistry {
  const root = new NativeToolRegistry()
  root.register(defineTool({
    name: 'root_label', description: 'Name the root that runs this call.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => label,
  }))
  return root
}

/** Boot with a shared `echo` tool, a rootless `standard` preset, and a `cordis:root` row that installs a labeled preset root. */
async function labeledRoots() {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Shared capability.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'shared',
  }))
  const state = { ctx, mounted: 0, disposed: 0, owners: [] as Context[], unloads: [] as (() => void)[] }
  ctx.loader.builtins.root = {
    inject: ['tools', 'systemPrompt'],
    apply(owner: Context) {
      const label = `root-${++state.mounted}`
      const root = labeledRoot(label)
      owner.systemPrompt.section({ name: 'tools:root', order: 800, text: label, interpolate: false })
      state.unloads.push(owner.tools.setRoot(root))
      state.owners.push(owner)
      owner.effect(() => () => { state.disposed++ })
    },
  }
  await declare(ctx, { id: 'standard', plugins: [] })
  return state
}

const labeledPreset = { id: 'custom', plugins: [{ id: 'root', name: 'cordis:root' }] }

/** Run one call through the root the Agent's scope selects. */
async function call(ctx: Context, agent: Agent, name: string) {
  const batch = await ctx.tools.execute({
    agent, calls: [{ type: 'tool-call', id: brandString<ToolCallId>('revision'), name, arguments: '{}' }],
    signal: new AbortController().signal,
  })
  return batch.results[0]?.result
}

/** Run one `echo` call through the root the Agent's scope selects. */
async function echo(ctx: Context, agent: Agent) {
  return call(ctx, agent, 'echo')
}

/** Name the labeled root that runs an Agent's calls, or undefined when its root has none. */
async function rootLabel(ctx: Context, agent: Agent): Promise<unknown> {
  const result = await call(ctx, agent, 'root_label')
  return result?.isError === false ? result.value : undefined
}

it('loads scoped root registries and retains them with the preset revision', async () => {
  const state = await labeledRoots()
  const ctx = state.ctx
  const firstRow = await declare(ctx, labeledPreset)
  const first = await agentOn(ctx, 'first-root', 'custom')
  const sameRevision = await agentOn(ctx, 'same-root', 'custom')
  const plain = await agentOn(ctx, 'plain-root', 'standard')
  expect(state.mounted).toBe(1)
  expect(first.ctx.tools.get('echo', first)).toBe(plain.ctx.tools.get('echo', plain))
  expect((await ctx.systemPrompt.assemble({ scope: first })).sections)
    .toContainEqual(expect.objectContaining({ name: 'tools:root', text: 'root-1' }))
  const result = await executeModelToolFixture(ctx, {
    agent: first, callId: brandString<ToolCallId>('loader-root'), name: 'echo', arguments: {}, signal: new AbortController().signal,
  })
  expect(result).toMatchObject({ value: 'shared', isError: false })
  await firstRow.dispose()
  await declare(ctx, labeledPreset)
  const newer = await agentOn(ctx, 'new-root', 'custom')
  expect(state.mounted).toBe(2)
  expect(state.disposed).toBe(0)
  expect((await ctx.systemPrompt.assemble({ scope: first })).sections)
    .toContainEqual(expect.objectContaining({ text: 'root-1' }))
  expect((await ctx.systemPrompt.assemble({ scope: newer })).sections)
    .toContainEqual(expect.objectContaining({ text: 'root-2' }))
  for (const agent of [first, sameRevision, plain, newer]) {
    expect(await echo(ctx, agent)).toMatchObject({ value: 'shared', isError: false })
  }
  expect(await Promise.all([first, sameRevision, plain, newer].map(agent => rootLabel(ctx, agent))))
    .toEqual(['root-1', 'root-1', undefined, 'root-2'])
})

it('keeps one root per preset scope and leaves an unloaded root selected as unavailable', async () => {
  const state = await labeledRoots()
  const ctx = state.ctx
  await declare(ctx, labeledPreset)
  const custom = await agentOn(ctx, 'custom-root', 'custom')
  const plain = await agentOn(ctx, 'plain-root', 'standard')
  const owner = state.owners[0]!
  expect(() => owner.tools.setRoot(new NativeToolRegistry())).toThrow('Only one root tool registry may be installed in each scope')
  expect(await echo(ctx, custom)).toMatchObject({ value: 'shared', isError: false })
  expect(await rootLabel(ctx, custom)).toBe('root-1')

  state.unloads[0]!()
  await expect(echo(ctx, custom)).rejects.toMatchObject({ code: 'TOOL_REGISTRY_UNAVAILABLE' })
  expect((await ctx.systemPrompt.assemble({ scope: plain })).tools.map(tool => tool.name)).toEqual(['echo'])
  expect(await echo(ctx, plain)).toMatchObject({ value: 'shared', isError: false })
  expect(await rootLabel(ctx, plain)).toBeUndefined()
})

it('selects the new preset root when a blank Agent switches presets', async () => {
  const state = await labeledRoots()
  const ctx = state.ctx
  await declare(ctx, labeledPreset)
  const agent = await agentOn(ctx, 'switching-root', 'standard')
  expect(await echo(ctx, agent)).toMatchObject({ value: 'shared', isError: false })
  expect(await rootLabel(ctx, agent)).toBeUndefined()

  expect(await ctx.agentPresets.select(agent, 'custom')).toBe('custom')
  expect(await echo(ctx, agent)).toMatchObject({ value: 'shared', isError: false })
  expect(await rootLabel(ctx, agent)).toBe('root-1')
  expect(await ctx.agentPresets.select(agent, 'standard')).toBe('standard')
  expect(await echo(ctx, agent)).toMatchObject({ value: 'shared', isError: false })
  expect(await rootLabel(ctx, agent)).toBeUndefined()
})

/** A deterministic external program backend that invokes the provided tool binding. */
class ProgramFixture extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'

  resolve(request: PtcRunRequest) {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  async run(request: PtcRunRequest): Promise<PtcRunResult> {
    expect(request.program).toBe('inspect(await tools.echo({ value: "ptc" }))')
    const value = await request.bindings[0]!.functions.echo!({ value: 'ptc' })
    if (typeof value !== 'string') throw new Error('expected a string echo result')
    return { output: [{ type: 'text', text: value }] }
  }
}

it.each([true, false])('loads cordis.yml root registry presets with runtime availability %s', async (hasRuntime) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-registry-packages-'))
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
      - id: root
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
    await expect(pending).rejects.toThrow('root (cordis:ptc): waiting for ptcRuntime')
    return
  }
  const ptc = await agentOn(ctx, 'ptc-package', 'ptc')
  expect((await ctx.systemPrompt.assemble({ scope: ptc })).tools.map(tool => tool.name)).toEqual(['run_code'])
  const signal = new AbortController().signal
  expect(await executeModelToolFixture(ctx, {
    agent: native, name: 'echo', arguments: { value: 'native' }, callId: brandString<ToolCallId>('native'), signal,
  })).toMatchObject({ isError: false, value: 'echo:native' })
  expect(await executeModelToolFixture(ctx, {
    agent: ptc, name: 'run_code', callId: brandString<ToolCallId>('program'), signal,
    arguments: { code: 'inspect(await tools.echo({ value: "ptc" }))', description: 'Echo through the program' },
  })).toMatchObject({ isError: false, content: [{ type: 'text', text: 'echo:ptc' }] })
  expect(ptc.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch')).toMatchObject({
    data: { name: 'echo', isError: false, content: [{ type: 'text', text: 'echo:ptc' }] },
  })
})
