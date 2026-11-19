/** Activity notices use the real tool result/context pipeline and leave program values unchanged. */
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { CuaOperation } from '@deepseek-ai/dsh-cua/api'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { expect, it, onTestFinished } from 'vitest'
import { handleActivityResult } from '../src/recent-activity.ts'

const activity = {
  lookbackMs: 10000, externalInputMonitoring: 'listening',
  events: [{ source: 'agent', windowId: '7', ageMs: 8000, operation: 'invoke' }],
}

async function run(
  value: Parameters<typeof handleActivityResult>[1],
  request: CuaOperation = { method: 'getState', params: { appHandle: 'app-one', windowId: '7' } },
) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.register({
    name: 'cua', description: 'Observe a fixture application.', parameters: {},
    output: { schema: {}, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (_args, execution) => handleActivityResult(request, value, execution),
  })
  return executeToolFixture(ctx, {
    name: 'cua', callId: brandString<ToolCallId>('activity-call'), arguments: {}, signal: new AbortController().signal,
  })
}

it('keeps activity context distinct from a successful operation value', async () => {
  const result = await run({ tree: 'AX tree', recentActivity: activity })
  expect(result.isError).toBe(false)
  expect(result.value).toEqual({ tree: 'AX tree' })
  expect(result.additionalContexts).toMatchObject([{
    source: { kind: 'cua-activity', form: 'notice' },
    content: [{ type: 'text', text: `Recent activity (advisory only): ${JSON.stringify({ appHandle: 'app-one', ...activity })}` }],
  }])
})

it.each([null, 42, [], { dispatched: true }])('preserves replies without activity: %j', async (value) => {
  const result = await run(value)
  expect(result.isError).toBe(false)
  expect(result.value).toEqual(value)
  expect(result.additionalContexts ?? []).toEqual([])
})

it.each(['unavailable', 'secure-input', 'listening'])('reports monitoring transitions with no input: %s', async (externalInputMonitoring) => {
  const result = await run({ dispatched: true, recentActivity: { ...activity, externalInputMonitoring, events: [] } })
  expect(result.isError).toBe(false)
  expect(result.additionalContexts?.[0]?.content).toEqual([{
    type: 'text', text: `Recent activity (advisory only): ${JSON.stringify({
      appHandle: 'app-one', ...activity, externalInputMonitoring, events: [],
    })}`,
  }])
})

it('rejects malformed native metadata and metadata without an authorized application target', async () => {
  const malformed = await run({ dispatched: true, recentActivity: { ...activity, lookbackMs: 0 } })
  expect(malformed).toMatchObject({ isError: true, error: { info: { code: 'NATIVE_PROTOCOL' } } })
  expect(malformed.additionalContexts ?? []).toEqual([])
  const discovery = await run({ recentActivity: activity }, { method: 'getCapabilities', params: {} })
  expect(discovery).toMatchObject({ isError: true, error: { info: { code: 'NATIVE_PROTOCOL' } } })
  expect(discovery.additionalContexts ?? []).toEqual([])
})
