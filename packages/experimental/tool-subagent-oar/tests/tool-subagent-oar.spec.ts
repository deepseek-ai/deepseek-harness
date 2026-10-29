import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import SubagentNames from '@deepseek-ai/dsh-subagent-names'
import type { ResolvedSubagentStartRequest, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { expect, it, vi } from 'vitest'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import * as externalTool from '../src/index.ts'

async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  const harness = await mountAgentLoopTestHarness(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentNames)
  const calls: { id: SessionId; provider: string; request: ResolvedSubagentStartRequest }[] = []
  for (const name of ['codex-provider', 'claude-provider', 'future-provider']) {
    ctx.subagents.registerProvider({
      name, capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
      start: async (request) => {
        const id = SessionId(randomUUID())
        calls.push({ id, provider: name, request })
        return {
          id,
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
  expect(Object.keys(schema?.parameters.properties as Record<string, unknown>).sort()).toEqual(['cwd', 'description', 'name', 'prompt', 'runtime'])
  expect(schema?.parameters.properties).toMatchObject({ runtime: { enum: ['codex', 'claude', 'future'] } })
  for (const [index, runtime] of ['codex', 'claude', 'future'].entries()) {
    const result = await executeToolFixture(ctx, {
      agent: parent, name: 'subagent_oar', signal: test.signal,
      callId: ToolCallId(randomUUID()),
      arguments: { runtime, description: `Use ${runtime}`, prompt: 'independent task' },
    })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).toEqual({ kind: 'activation', subagentId: calls[index]?.id, name: `lead/agent-${index + 1}` })
    expect(result.content).toEqual([{ type: 'text', text: `started subagent ${calls[index]?.id}\nname: lead/agent-${index + 1}` }])
  }
  expect(calls.map(call => call.provider)).toEqual(['codex-provider', 'claude-provider', 'future-provider'])
  expect(calls[0]?.request.prompt).toEqual([
    { type: 'text', text: 'independent task' },
  ])
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
  const args = { name: 'inspector', runtime: 'inherited', description: 'task', prompt: 'task' }
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
  const args = { name: 'inspector', runtime: 'codex', description: 'Inspect child', prompt: 'task', cwd: 'packages' }
  expect(ctx.tools.get('subagent_oar')?.presentCall?.(args)).toEqual({
    card: 'generic', title: 'Inspect child', rawInput: args,
  })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: `started subagent ${calls[0]?.id}\nname: lead/inspector` }])
  expect(result.value).toEqual({ kind: 'activation', subagentId: calls[0]?.id, name: 'lead/inspector' })
  expect(calls[0]?.request.cwd).toBe(join(process.cwd(), 'packages'))
})

it('supports direct composition with the declared optional defaults', async (test) => {
  const { ctx } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  externalTool.apply(ctx, { providers: { codex: 'codex-provider' } })
  expect(ctx.tools.schemas().some(tool => tool.name === 'subagent_oar')).toBe(true)
})

it('releases the requested name when provider startup fails', async (test) => {
  const { ctx, parent } = await setup()
  test.onTestFinished(() => ctx.fiber.dispose())
  const childId = SessionId(randomUUID())
  const start = vi.fn<() => Promise<SubagentRun>>()
    .mockRejectedValueOnce(new Error('provider startup failed'))
    .mockResolvedValueOnce({
      id: childId,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: async () => {},
    })
  ctx.subagents.registerProvider({
    name: 'retry-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false, start,
  })
  await ctx.plugin(externalTool, { providers: { retry: 'retry-provider' } })
  const args = { name: 'inspector', runtime: 'retry', description: 'task', prompt: 'task' }
  const failed = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(failed.isError).toBe(true)
  expect(failed.error?.message).toContain('provider startup failed')
  const retried = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', arguments: args, callId: ToolCallId(randomUUID()), signal: test.signal,
  })
  expect(retried.isError, JSON.stringify(retried.content)).toBe(false)
  expect(retried.value).toEqual({ kind: 'activation', subagentId: childId, name: 'lead/inspector' })
  expect(start).toHaveBeenCalledTimes(2)
})

it('reports the accepted child id without stopping it when name binding fails', async (test) => {
  const { ctx, parent } = await setup()
  const childId = SessionId(randomUUID())
  const childResult = Promise.withResolvers<SubagentResult>()
  let childRequest: ResolvedSubagentStartRequest | undefined
  const dispose = vi.fn(async () => { childResult.resolve({ output: [], stopReason: 'aborted' }) })
  const bind = vi.spyOn(ctx.subagentNames, 'bind').mockImplementationOnce(() => { throw new Error('session append failed') })
  test.onTestFinished(async () => {
    bind.mockRestore()
    childResult.resolve({ output: [], stopReason: 'completed' })
    await ctx.fiber.dispose()
  })
  ctx.subagents.registerProvider({
    name: 'pending-provider', capabilities: NO_START_CAPABILITIES, inheritsParentContext: false,
    start: async (request) => {
      childRequest = request
      return { id: childId, result: childResult.promise, dispose }
    },
  })
  await ctx.plugin(externalTool, { providers: { pending: 'pending-provider' } })
  const result = await executeToolFixture(ctx, {
    agent: parent, name: 'subagent_oar', callId: ToolCallId(randomUUID()), signal: test.signal,
    arguments: { name: 'inspector', runtime: 'pending', description: 'task', prompt: 'task' },
  })
  expect(result.isError).toBe(true)
  expect(result.error?.info?.code).toBe('SUBAGENT_NAME_BIND_FAILED')
  expect(result.error?.message).toContain(`Subagent ${childId} started, but its name lead/inspector could not be recorded.`)
  expect(result.error?.message).toContain('Check this child before retrying.')
  expect(dispose).not.toHaveBeenCalled()
  expect(childRequest?.signal.aborted).toBe(false)
  const reservation = ctx.subagentNames.reserve(parent.session, parent.id, 'inspector')
  expect(reservation.name).toBe('lead/inspector')
  reservation.dispose()
  childResult.resolve({ output: [{ type: 'text', text: 'child finished' }], stopReason: 'completed' })
  await expect.poll(() => dispose.mock.calls.length).toBe(1)
})
