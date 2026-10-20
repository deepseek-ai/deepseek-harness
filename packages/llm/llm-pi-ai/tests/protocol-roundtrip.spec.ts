/** Cross-protocol requests must not overwrite the history needed by its original provider. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { assemble } from './assemble.ts'
import { anthropicFrame, closeMockServers, mockServer } from './mock-server.ts'

type Api = 'anthropic-messages' | 'openai-responses' | 'openai-completions'
const apis: Api[] = ['anthropic-messages', 'openai-responses', 'openai-completions']
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

function responsesFrames(tools: boolean): string[] {
  const items = tools ? [
    { type: 'reasoning', id: 'rs_original', encrypted_content: 'encrypted-reasoning', summary: [{ type: 'summary_text', text: 'source reasoning' }] },
    { type: 'message', id: 'msg_original', role: 'assistant', content: [{ type: 'output_text', text: 'source text', annotations: [] }] },
    ...[0, 1].map(index => ({ type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: 'lookup', arguments: JSON.stringify({ key: index }) })),
    { type: 'message', id: 'msg_empty', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] },
  ] : [{ type: 'message', id: 'msg_reply', role: 'assistant', content: [{ type: 'output_text', text: 'reply', annotations: [] }] }]
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_original' } }),
    ...items.flatMap((item, output_index) => [
      JSON.stringify({ type: 'response.output_item.added', output_index, item }),
      JSON.stringify({ type: 'response.output_item.done', output_index, item }),
    ]),
    JSON.stringify({ type: 'response.completed', response: {
      id: 'resp_original', status: 'completed', output: items, usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    } }),
  ]
}

function anthropicFrames(tools: boolean): ReturnType<typeof anthropicFrame>[] {
  const blocks = tools ? [
    { type: 'thinking', thinking: 'source reasoning', signature: 'signed-reasoning' },
    { type: 'redacted_thinking', data: 'encrypted-redacted-reasoning' },
    { type: 'text', text: 'source text' },
    ...[0, 1].map(index => ({ type: 'tool_use', id: `toolu_${index}`, name: 'lookup', input: { key: index } })),
    { type: 'text', text: '' },
  ] : [{ type: 'text', text: 'reply' }]
  return [
    anthropicFrame({ type: 'message_start', message: {
      id: 'msg_original', type: 'message', role: 'assistant', model: 'model', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 },
    } }),
    ...blocks.flatMap((content_block, index) => [
      anthropicFrame({ type: 'content_block_start', index, content_block }),
      anthropicFrame({ type: 'content_block_stop', index }),
    ]),
    anthropicFrame({ type: 'message_delta', delta: { stop_reason: tools ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame({ type: 'message_stop' }),
  ]
}

function frames(api: Api, tools = false): (string | ReturnType<typeof anthropicFrame>)[] {
  if (api === 'openai-responses') return responsesFrames(tools)
  if (api === 'anthropic-messages') return anthropicFrames(tools)
  return [
    JSON.stringify({ choices: [{ index: 0, delta: {
      role: 'assistant', content: tools ? 'source text' : 'reply',
      ...tools ? {
        reasoning_content: 'source reasoning',
        tool_calls: [0, 1].map(index => ({
          index, id: `call_${index}`, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ key: index }) },
          // Gemini's OpenAI-compatible endpoints sign only the first call of each step.
          ...index === 0 ? { extra_content: { google: { thought_signature: 'gemini-signature' } } } : {},
        })),
      } : {},
    }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    '[DONE]',
  ]
}

function wireHistory(request: unknown, api: Api): unknown[] {
  expect(request).toBeTypeOf('object')
  const history = (request as Record<string, unknown>)[api === 'openai-responses' ? 'input' : 'messages']
  if (!Array.isArray(history)) throw new Error('Expected a wire message array')
  return history
}

function expectToolPairs(request: unknown, api: Api): void {
  const messages = wireHistory(request, api) as Record<string, unknown>[]
  const calls: unknown[] = []
  const results: unknown[] = []
  for (const message of messages) {
    if (api === 'openai-responses') {
      if (message['type'] === 'function_call') calls.push(message['call_id'])
      if (message['type'] === 'function_call_output') results.push(message['call_id'])
    } else if (api === 'openai-completions') {
      for (const call of (message['tool_calls'] ?? []) as Record<string, unknown>[]) calls.push(call['id'])
      if (message['role'] === 'tool') results.push(message['tool_call_id'])
    } else if (Array.isArray(message['content'])) {
      for (const block of message['content'] as Record<string, unknown>[]) {
        if (block['type'] === 'tool_use') calls.push(block['id'])
        if (block['type'] === 'tool_result') results.push(block['tool_use_id'])
      }
    }
  }
  expect(calls).toHaveLength(2)
  expect(calls.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  expect(new Set(calls).size).toBe(2)
  expect(results).toEqual(calls)
}

const tool = { name: 'lookup', description: 'Look up a value.', parameters: { type: 'object', properties: { key: { type: 'number' } }, required: ['key'] } }
const pairs: { a: Api; b: Api | 'deepseek-messages' }[] = [
  ...apis.flatMap(a => apis.map(b => ({ a, b }))),
  ...apis.map(a => ({ a, b: 'deepseek-messages' as const })),
]

describe('protocol history round trips', () => {
  it.each(pairs)('$a → $b → $a preserves saved content and restores native replay', async ({ a, b }) => {
    vi.stubEnv('PROTOCOL_ROUNDTRIP_KEY', 'test-key')
    const source = await mockServer([{ events: frames(a, true) }, { events: frames(a) }, { events: frames(a) }])
    const targetApi = b === 'deepseek-messages' ? 'anthropic-messages' : b
    const targetProvider = b === 'deepseek-messages' ? 'deepseek-official' : 'route-b'
    const target = await mockServer([{ events: frames(targetApi) }])
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: {
      'route-a': { api: a, baseURL: source.url, apiKeyEnv: 'PROTOCOL_ROUNDTRIP_KEY', cacheRetention: 'none', models: [{ id: 'model' }] },
      ...b === 'deepseek-messages' ? {} : {
        'route-b': { api: b, baseURL: target.url, apiKeyEnv: 'PROTOCOL_ROUNDTRIP_KEY', cacheRetention: 'none', models: [{ id: 'model' }] },
      },
    } })
    if (b === 'deepseek-messages') await ctx.plugin(DeepSeek, {
      baseURL: target.url, apiKeyEnv: 'PROTOCOL_ROUNDTRIP_KEY', models: [{ id: 'model' }], thinking: 'disabled',
    })
    let history: Message[] = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Look up both values.' }] })]
    const original = await assemble(ctx, { provider: 'route-a', model: 'model', messages: history, tools: [tool] })
    expect(original.finish).toEqual({ kind: 'tool-calls' })
    const calls = original.message.content.filter(block => block.type === 'tool-call')
    expect(calls).toHaveLength(2)
    if (a !== 'openai-completions') expect(original.message.content.at(-1)).toEqual({ type: 'text', text: '' })
    expect(original.message.source).toMatchObject({ replayState: { response: { api: a, provider: 'route-a', model: 'model' } } })
    if (a === 'anthropic-messages') {
      const blocks: unknown = expect.arrayContaining([
        { type: 'reasoning', thinkingSignature: 'signed-reasoning' },
        { type: 'reasoning', thinkingSignature: 'encrypted-redacted-reasoning', redacted: true },
      ])
      expect(original.message.source).toMatchObject({ replayState: { blocks } })
    } else if (a === 'openai-responses') {
      const thinkingSignature: unknown = expect.stringContaining('encrypted-reasoning')
      const blocks: unknown = expect.arrayContaining([
        { type: 'reasoning', thinkingSignature },
        { type: 'text', textSignature: JSON.stringify({ v: 1, id: 'msg_empty' }) },
      ])
      expect(original.message.source).toMatchObject({ replayState: { response: { responseId: 'resp_original' }, blocks } })
    } else {
      const blocks = (original.message.source as { replayState: { blocks: unknown[] } }).replayState.blocks.filter(block => (block as { type: string }).type === 'tool-call')
      expect(blocks).toEqual([{ type: 'tool-call', thoughtSignature: 'gemini-signature' }, { type: 'tool-call' }])
    }
    history.push(original.message, ...calls.map(call => createToolResultMessage({
      callId: call.id, content: [{ type: 'text', text: 'value' }], isError: false,
    })))
    const saved = JSON.stringify(history)
    history = JSON.parse(saved) as Message[]

    // Capture A's request before any foreign conversion, then use the same saved history for B.
    expect((await assemble(ctx, { provider: 'route-a', model: 'model', messages: history, tools: [tool] })).finish).toEqual({ kind: 'stop' })
    const baseline = wireHistory(source.requests[1], a)
    expectToolPairs(source.requests[1], a)
    if (a === 'anthropic-messages') {
      expect(JSON.stringify(baseline)).toContain('signed-reasoning')
      expect(JSON.stringify(baseline)).toContain('encrypted-redacted-reasoning')
    } else if (a === 'openai-responses') {
      expect(JSON.stringify(baseline)).toContain('encrypted-reasoning')
      expect(JSON.stringify(baseline)).toContain('fc_0')
    } else {
      const calls = baseline.flatMap(message => (message as { tool_calls?: unknown[] }).tool_calls ?? [])
      expect(calls).toMatchObject([{ extra_content: { google: { thought_signature: 'gemini-signature' } } }, {}])
      expect(calls[1]).not.toHaveProperty('extra_content')
    }
    const foreign = await assemble(ctx, { provider: targetProvider, model: 'model', messages: history, tools: [tool] })
    expect(foreign.finish).toEqual({ kind: 'stop' })
    expect(JSON.stringify(history)).toBe(saved)
    expectToolPairs(target.requests[0], targetApi)
    expect(JSON.stringify(target.requests[0])).not.toContain('encrypted-reasoning')
    expect(JSON.stringify(target.requests[0])).not.toContain('encrypted-redacted-reasoning')
    expect(JSON.stringify(target.requests[0])).not.toContain('signed-reasoning')
    expect(JSON.stringify(target.requests[0])).not.toContain('gemini-signature')
    history.push(foreign.message, createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue with the original model.' }] }))
    history = JSON.parse(JSON.stringify(history)) as Message[]
    expect(history.slice(0, -2)).toEqual(JSON.parse(saved))
    expect((await assemble(ctx, { provider: 'route-a', model: 'model', messages: history, tools: [tool] })).finish).toEqual({ kind: 'stop' })
    expect(wireHistory(source.requests[2], a).slice(0, baseline.length)).toEqual(baseline)
    expect(history.slice(0, -2)).toEqual(JSON.parse(saved))
    expect(source.requests).toHaveLength(3)
    expect(target.requests).toHaveLength(1)
  })
})
