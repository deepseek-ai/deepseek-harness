/** Model-call fixtures preserve raw JSON input and reject incomplete execution. */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { type ToolExecutor } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'
import { executeModelToolFixture } from '../src/index.ts'

async function setup(execute: ToolExecutor['execute']): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.setExecutor({ describe: () => ({ schemas: [], knownNames: [] }), execute })
  return ctx
}

const call = { callId: ToolCallId('fixture'), name: 'echo', signal: new AbortController().signal }

it('serializes model arguments and returns the selected executor result without an Agent', async () => {
  const result = { isError: false as const, value: 'done', content: [{ type: 'text' as const, text: 'done' }] }
  const ctx = await setup(async (input) => {
    expect(input.calls).toEqual([{ type: 'tool-call', id: call.callId, name: 'echo', arguments: '{"text":"hello"}' }])
    expect(input.signal).toBe(call.signal)
    expect(input.agent).toBeUndefined()
    return { results: [{ callId: call.callId, result }], additionalContexts: [], concluded: false }
  })
  expect(await executeModelToolFixture(ctx, { ...call, arguments: { text: 'hello' } })).toBe(result)
})

it('rejects unencodable model arguments before invoking the executor', async () => {
  const ctx = await setup(async () => { throw new Error('executor must not run') })
  await expect(executeModelToolFixture(ctx, { ...call, arguments: undefined }))
    .rejects.toThrow('Model tool fixture arguments must encode as JSON')
})

it('reports when an executor omits the requested result', async () => {
  const ctx = await setup(async () => ({ results: [], additionalContexts: [], concluded: false }))
  await expect(executeModelToolFixture(ctx, { ...call, arguments: {} }))
    .rejects.toThrow('Executor omitted the model tool fixture result')
})
