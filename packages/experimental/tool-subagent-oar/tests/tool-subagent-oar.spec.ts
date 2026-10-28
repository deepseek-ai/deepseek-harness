import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { expect, it } from 'vitest'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import * as externalTool from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  const calls: { provider: string; request: ResolvedSubagentStartRequest }[] = []
  for (const name of ['codex-provider', 'claude-provider', 'future-provider']) {
    ctx.subagents.registerProvider({
      name, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      start: async (request) => {
        calls.push({ provider: name, request })
        return {
          id: SessionId(randomUUID()),
          result: Promise.resolve({ output: [{ type: 'text' as const, text: 'child result' }], stopReason: 'completed' as const }),
          dispose: () => Promise.resolve(),
        }
      },
    })
  }
  const parent = await harness.create(SessionId(randomUUID()), {}, { cwd: process.cwd() })
  return { ctx, parent, calls }
}

it('selects one configured provider per call and exposes only task inputs', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  const fiber = await ctx.plugin(externalTool, {
    providers: { codex: 'codex-provider', claude: 'claude-provider', future: 'future-provider' },
  })
  const schema = ctx.tools.schemas().find(tool => tool.name === 'subagent_oar')
  expect(schema?.parameters.required).toEqual(['runtime', 'description', 'prompt'])
  expect(Object.keys(schema?.parameters.properties as Record<string, unknown>).sort()).toEqual(['cwd', 'description', 'prompt', 'runtime'])
  expect(schema?.parameters.properties).toMatchObject({ runtime: { enum: ['codex', 'claude', 'future'] } })
  for (const runtime of ['codex', 'claude', 'future']) {
    const result = await executeToolFixture(ctx, {
      agent: parent, name: 'subagent_oar', signal: test.signal,
      callId: ToolCallId(randomUUID()),
      arguments: { runtime, description: `Use ${runtime}`, prompt: 'independent task' },
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.content).toHaveLength(1)
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (content?.type === 'text') expect(content.text).toMatch(/^started subagent /u)
  }
  expect(calls.map(call => call.provider)).toEqual(['codex-provider', 'claude-provider', 'future-provider'])
  expect(calls[0]?.request.prompt).toEqual([{ type: 'text', text: 'independent task' }])
  expect(calls[0]?.request.parent).toBe(parent)
  expect(calls[0]?.request.cwd).toBe(process.cwd())
  expect(ctx.tools.get('subagent_oar')?.isConcurrencySafe?.({
    runtime: 'codex', description: 'task', prompt: 'task',
  })).toBe(true)
  await fiber.dispose()
  expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(false)
})

it('rejects unconfigured runtime names before starting any child', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'unconfigured', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(calls).toEqual([])
})

it('fails visibly when the selected provider disappears', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { missing: 'missing-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', signal: test.signal,
    callId: ToolCallId(randomUUID()),
    arguments: { runtime: 'missing', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(calls).toEqual([])
})

it('rejects empty runtime maps and keeps Loader metadata', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  expect('default' in externalTool).toBe(false)
  const loader = Object.create(Loader.prototype) as Loader
  expect(loader.unwrapExports(externalTool)).toBe(externalTool)
  await expect(ctx.plugin(externalTool, { providers: {} })).rejects.toThrow('at least one')
  await expect(ctx.plugin(externalTool, { providers: { ' ': 'codex-provider' } })).rejects.toThrow('non-empty')
})

it('requires a caller and independently scoped one-shot providers', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  ctx.subagents.registerProvider({
    name: 'inherited', capabilities: NO_START_CAPABILITIES, inheritsParentContext: true,
    start: async () => { throw new Error('must not run') },
  })
  await ctx.plugin(externalTool, { providers: { inherited: 'inherited' } })
  const args = { runtime: 'inherited', description: 'task', prompt: 'task' }
  const noParent = await executeToolFixture(ctx, {
    name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(noParent.isError).toBe(true)
  const inherited = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(inherited.isError).toBe(true)
  expect(JSON.stringify(inherited.content)).toContain('independent conversation')
})

it('passes an explicit child directory and presents the task description', async (test) => {
  const { ctx, parent, calls } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(externalTool, { providers: { codex: 'codex-provider' } })
  const args = { runtime: 'codex', description: 'Inspect child', prompt: 'task', cwd: 'packages' }
  expect(ctx.tools.get('subagent_oar')?.presentCall?.(args)).toEqual({
    card: 'generic', title: 'Inspect child', rawInput: args,
  })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(result.isError).toBe(false)
  expect(calls[0]?.request.cwd).toBe(join(process.cwd(), 'packages'))
})

it('supports direct composition with the declared optional defaults', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  externalTool.apply(ctx, { providers: { codex: 'codex-provider' } })
  expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(true)
})
