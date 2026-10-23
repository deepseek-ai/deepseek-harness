/** Conditional registrations share step admission with direct and nested execution. */
import { executeModelToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, TOOL_ABORTED_BEFORE_DISPATCH, ToolActivationError } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

const TEST_MODEL_SELECTION = { provider: 'test', model: 'test' }
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const agent = { id: SessionId('activation') } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools'] }))
  const controller = new AbortController()
  let calls = 0
  const tool = defineTool({
    name: 'conditional', description: 'A conditional operation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { calls++; return 'done' },
  })
  const input = { agent, name: tool.name, arguments: {}, callId: ToolCallId('call'), signal: controller.signal }
  const execute = (overrides: Partial<ToolExecutionInput> = {}): Promise<ToolExecutionResult> =>
    executeToolFixture(ctx, { ...input, ...overrides })
  const resolve = () => ctx.tools.resolve({ agent, modelSelection: TEST_MODEL_SELECTION, signal: controller.signal })
  return { ctx, agent, scope, controller, tool, input, execute, resolve, calls: () => calls }
}

it('activates and deactivates a registered tool without allowing historical calls', async () => {
  const h = await setup()
  let enabled = false
  h.ctx.tools.register(h.tool, { when: () => enabled })
  const unavailable = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, unavailable)).toEqual([])
  enabled = true
  expect((await h.execute({ toolSet: unavailable })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute()).error?.info?.code).toBe('UNKNOWN_TOOL')
  const available = await h.resolve()
  expect(h.ctx.tools.schemas(h.agent, available).map(tool => tool.name)).toEqual(['conditional'])
  expect((await h.execute({ toolSet: available })).isError).toBe(false)
  enabled = false
  const disabled = await h.resolve()
  expect((await h.execute({ toolSet: disabled })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(1)
})

it('applies a batch admission to the calls its executor runs', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  expect((await executeModelToolFixture(h.ctx, { ...h.input, toolSet })).isError).toBe(false)
  expect((await executeModelToolFixture(h.ctx, h.input)).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(1)
})

it('keeps admissions specific to the requesting agent', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  const other = { id: SessionId('other') } as Agent
  expect((await h.execute({ agent: other, toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(0)
})

it('applies live restrictions and closes step admission permanently', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  const lift = h.scope.ctx.tools.restrict({ deny: ['conditional'] })
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  lift()
  expect((await h.execute({ toolSet })).isError).toBe(false)
  toolSet.dispose()
  expect(h.ctx.tools.schemas(h.agent, toolSet)).toEqual([])
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(1)
})

it('settles calls of a cancelled step through cancellation with their finalizers', async () => {
  const h = await setup()
  h.ctx.tools.register({ ...h.tool, finalizeContent: () => [{ type: 'text', text: 'finalized' }] }, { when: () => true })
  const toolSet = await h.resolve()
  h.controller.abort()
  const result = await h.execute({ toolSet })
  expect(result.error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
  expect(result.content).toEqual([{ type: 'text', text: 'finalized' }])
  expect(h.calls()).toBe(0)
})

it('reports a wrapper result completed at cancellation as cancelled rather than unknown', async () => {
  const h = await setup()
  h.ctx.tools.register(h.tool, { when: () => true })
  const toolSet = await h.resolve()
  h.ctx.on('tools/execute', async () => {
    h.controller.abort()
    return { isError: false, value: 'wrapped', content: [{ type: 'text', text: 'wrapped' }] }
  })
  expect((await h.execute({ toolSet })).error?.info?.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
})

it('does not substitute a same-name registration after admission', async () => {
  const h = await setup()
  const unregister = h.ctx.tools.register(h.tool, { when: () => true })
  const old = await h.resolve()
  unregister()
  h.ctx.tools.register(h.tool, { when: () => true })
  expect((await h.execute({ toolSet: old })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect((await h.execute({ toolSet: await h.resolve() })).isError).toBe(false)
  expect(h.calls()).toBe(1)
})

it('does not restore a registration removed during its asynchronous condition', async () => {
  const h = await setup()
  const condition = Promise.withResolvers<boolean>()
  const entered = Promise.withResolvers<undefined>()
  const unregister = h.ctx.tools.register(h.tool, { when: () => { entered.resolve(undefined); return condition.promise } })
  const pending = h.resolve()
  await entered.promise
  unregister()
  condition.resolve(true)
  const toolSet = await pending
  expect(h.ctx.tools.schemas(h.agent, toolSet)).toEqual([])
  expect((await h.execute({ toolSet })).error?.info?.code).toBe('UNKNOWN_TOOL')
  expect(h.calls()).toBe(0)
})

it('propagates cancellation after an asynchronous condition settles', async () => {
  const h = await setup()
  const condition = Promise.withResolvers<boolean>()
  h.ctx.tools.register(h.tool, { when: ({ agent, modelSelection, signal }) => {
    expect(agent).toBe(h.agent)
    expect(modelSelection).toBe(TEST_MODEL_SELECTION)
    expect(signal).toBe(h.controller.signal)
    return condition.promise
  } })
  const pending = h.resolve()
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  h.controller.abort()
  condition.resolve(true)
  await rejection
  expect(h.calls()).toBe(0)
})

it('reports condition failures without treating them as disabled tools', async () => {
  const h = await setup()
  const cause = new Error('credential storage unavailable')
  h.ctx.tools.register(h.tool, { when: () => { throw cause } })
  await expect(h.resolve()).rejects.toMatchObject({
    name: ToolActivationError.name, code: 'TOOL_ACTIVATION_FAILED', cause,
  })
  expect(h.calls()).toBe(0)
})
