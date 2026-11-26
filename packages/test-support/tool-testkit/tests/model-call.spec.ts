/** Model-call fixtures preserve raw JSON input and reject incomplete execution. */
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { NativeToolRegistry } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, onTestFinished, vi } from 'vitest'
import { executeDefinitionFixture, executeModelToolFixture, stepToolNames } from '../src/index.ts'

async function setup(): Promise<{ ctx: Context; received: unknown[] }> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  ctx.tools.setRoot(new NativeToolRegistry())
  const received: unknown[] = []
  ctx.tools.register(defineTool({
    name: 'echo', description: 'Return the text argument.', parameters: { text: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      received.push({ args, agent: exec.agent })
      return args.text ?? ''
    },
  }))
  return { ctx, received }
}

const call = { callId: brandString<ToolCallId>('fixture'), name: 'echo', signal: new AbortController().signal }

it('serializes model arguments and returns the selected root entry result without an Agent', async () => {
  const { ctx, received } = await setup()
  expect(await executeModelToolFixture(ctx, { ...call, arguments: { text: 'hello' } }))
    .toMatchObject({ isError: false, value: 'hello', content: [{ type: 'text', text: 'hello' }] })
  expect(received).toEqual([{ args: { text: 'hello' }, agent: undefined }])
})

it('rejects unencodable model arguments before running the batch', async () => {
  const { ctx, received } = await setup()
  await expect(executeModelToolFixture(ctx, { ...call, arguments: undefined }))
    .rejects.toThrow('Model tool fixture arguments must encode as JSON')
  expect(received).toEqual([])
})

it('reports when the batch omits the requested result', async () => {
  const { ctx } = await setup()
  vi.spyOn(ctx.tools, 'execute').mockResolvedValue({ results: [], additionalContexts: [], concluded: false })
  onTestFinished(() => { vi.restoreAllMocks() })
  await expect(executeModelToolFixture(ctx, { ...call, arguments: {} }))
    .rejects.toThrow('ctx.tools.execute() omitted the model tool fixture result')
})

it('runs a known definition without a registry lookup and refuses other names', async () => {
  const { ctx } = await setup()
  const definition = defineTool({
    name: 'binding', description: 'A definition no root offers.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'bound',
  })
  const input = { callId: brandString<ToolCallId>('binding'), arguments: {}, signal: new AbortController().signal }
  expect(await executeDefinitionFixture(ctx, definition, { ...input, name: 'binding' })).toMatchObject({ isError: false, value: 'bound' })
  expect((await executeDefinitionFixture(ctx, definition, { ...input, name: 'other' })).error?.info?.code).toBe('UNKNOWN_TOOL')
})

it('lists declared entries, or the bindings a PTC step declares in its SDK', () => {
  expect(stepToolNames({ tools: [{ name: 'write' }, { name: 'read' }], sections: [] })).toEqual(['read', 'write'])
  const sdk = [
    '```ts',
    'interface ToolArgsMap {',
    '  /** Read a file. */',
    '  read: {',
    '    file_path: string;',
    '  };',
    '  "mcp-server.tool"?: {};',
    '}',
    '',
    'interface ToolOutputMap {',
    '  read: string;',
    '}',
    '```',
  ].join('\n')
  expect(stepToolNames({ tools: [{ name: 'run_code' }], sections: [{ name: 'tools:sdk', text: sdk }] })).toEqual(['mcp-server.tool', 'read'])
  expect(stepToolNames({ tools: [{ name: 'run_code' }], sections: [{ name: 'tools:sdk', text: 'no declarations' }] })).toEqual([])
})
