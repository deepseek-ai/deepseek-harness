/** Replayed Anthropic thinking is bound to the request prefix it was generated under. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, ToolCallId } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { anthropicFrame, closeMockServers, mockServer } from './mock-server.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

const tool = { name: 'lookup', description: 'Look up a value.', parameters: { type: 'object', properties: { key: { type: 'number' } } } }

/** One Anthropic response: signed and redacted thinking, then a tool call or a reply. */
function frames(signature: string, toolUse: boolean): ReturnType<typeof anthropicFrame>[] {
  return response(signature, [
    { type: 'thinking', thinking: `thinking ${signature}`, signature },
    { type: 'redacted_thinking', data: `redacted-${signature}` },
    toolUse ? { type: 'tool_use', id: `toolu_${signature}`, name: 'lookup', input: { key: 1 } } : { type: 'text', text: 'done' },
  ], toolUse)
}

function response(signature: string, blocks: Record<string, unknown>[], toolUse = false): ReturnType<typeof anthropicFrame>[] {
  return [
    anthropicFrame({ type: 'message_start', message: {
      id: `msg_${signature}`, type: 'message', role: 'assistant', model: 'model', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 },
    } }),
    ...blocks.flatMap((content_block, index) => [
      anthropicFrame({ type: 'content_block_start', index, content_block }),
      anthropicFrame({ type: 'content_block_stop', index }),
    ]),
    anthropicFrame({ type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    anthropicFrame({ type: 'message_stop' }),
  ]
}

async function setup(api: 'anthropic-messages' | 'openai-completions', script: Parameters<typeof mockServer>[0], adaptive = true, manual = false) {
  vi.stubEnv('PREFIX_BINDING_KEY', 'test-key')
  const server = await mockServer(script)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: {
    route: { api, baseURL: server.url, apiKeyEnv: 'PREFIX_BINDING_KEY', cacheRetention: 'none', models: [{ id: 'model', ...manual ? { reasoningEfforts: { high: 'high' } } : {} }],
      ...manual ? { reasoning: 'high' as const } : {},
      ...api === 'anthropic-messages' ? { compat: { forceAdaptiveThinking: adaptive } } : {} },
  } })
  const run = async (messages: Message[]) => {
    const result = await assemble(ctx, { provider: 'route', model: 'model', messages, tools: [tool], system: 'system' })
    return JSON.parse(JSON.stringify(result.message)) as Message
  }
  return { server, run }
}

function user(text: string): Message {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function result(callId: ToolCallId, text: string): Message {
  return JSON.parse(JSON.stringify(createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }))) as Message
}

function callId(message: Message): ToolCallId {
  const call = message.content.find(block => block.type === 'tool-call')
  if (call === undefined) throw new Error('expected a tool call')
  return call.id
}

function wire(request: unknown): string {
  return JSON.stringify((request as { messages: unknown }).messages)
}

describe('Anthropic thinking prefix binding', () => {
  it('keeps thinking while its prefix is unchanged and omits it after the prefix is rewritten', async () => {
    const { server, run } = await setup('anthropic-messages', [
      { events: frames('first', true) },
      { events: frames('second', true) },
      { events: frames('third', false) },
      { events: frames('fourth', false) },
      { events: frames('fifth', false) },
    ])
    const first = await run([user('Look up the value.')])
    const prefixDigest: unknown = expect.stringMatching(/^[0-9a-f]{64}$/)
    expect(first.source).toMatchObject({ replayState: { response: { prefixDigest } } })
    const second = await run([user('Look up the value.'), first, result(callId(first), 'large output')])
    expect(wire(server.requests[1])).toContain('"signature":"first"')
    expect(wire(server.requests[1])).toContain('redacted-first')

    // Pruning the first tool result rewrites the second response's prefix but not the first one's.
    const tail = [first, result(callId(first), 'pruned'), second, result(callId(second), 'value')]
    const third = await run([user('Look up the value.'), ...tail])
    expect(wire(server.requests[2])).toContain('"signature":"first"')
    expect(wire(server.requests[2])).not.toContain('"signature":"second"')
    expect(wire(server.requests[2])).not.toContain('redacted-second')
    expect(wire(server.requests[2])).toContain('toolu_second')

    // Compaction replaces the head: every retained response loses its thinking, tool calls stay paired.
    const compacted = [user('<compacted-summary>'), ...tail, third, user('Continue.')]
    const fourth = await run(compacted)
    const request = wire(server.requests[3])
    for (const stale of ['"signature":"first"', 'redacted-first', '"signature":"second"', '"signature":"third"']) {
      expect(request).not.toContain(stale)
    }
    expect(request).toContain('toolu_first')
    expect(request).toContain('toolu_second')

    // A response generated on the compacted prefix replays its own thinking.
    await run([...compacted, fourth, user('Again.')])
    expect(wire(server.requests[4])).toContain('"signature":"fourth"')
    expect(wire(server.requests[4])).not.toContain('"signature":"third"')
  })

  it('treats a changed system prompt as a changed prefix', async () => {
    const { server, run } = await setup('anthropic-messages', [{ events: frames('first', true) }, { events: frames('second', false) }])
    const first = await run([user('Look up the value.')])
    const ctx = contexts[0] as Context
    await assemble(ctx, {
      provider: 'route', model: 'model', tools: [tool], system: 'changed system',
      messages: [user('Look up the value.'), first, result(callId(first), 'value')],
    })
    expect(wire(server.requests[1])).not.toContain('"signature":"first"')
    expect(wire(server.requests[1])).toContain('toolu_first')
  })

  it('omits thinking whose replay state records no prefix digest', async () => {
    const { server, run } = await setup('anthropic-messages', [{ events: frames('first', true) }, { events: frames('second', false) }])
    const first = await run([user('Look up the value.')])
    const replayState = (first.source as { replayState: { response: Record<string, unknown> } }).replayState
    delete replayState.response['prefixDigest']
    await run([user('Look up the value.'), first, result(callId(first), 'value')])
    expect(wire(server.requests[1])).not.toContain('"signature":"first"')
    expect(wire(server.requests[1])).toContain('toolu_first')
  })

  it('keeps stale thinking only on the open tool round of a manual-thinking request', async () => {
    const { server, run } = await setup('anthropic-messages', [
      { events: frames('first', true) },
      { events: frames('second', true) },
      { events: frames('third', false) },
      { events: frames('fourth', false) },
    ], false, true)
    const first = await run([user('Look up the value.')])
    const second = await run([user('Look up the value.'), first, result(callId(first), 'value')])
    await run([user('<compacted-summary>'), first, result(callId(first), 'value'), second, result(callId(second), 'value')])
    expect(wire(server.requests[2])).not.toContain('"signature":"first"')
    expect(wire(server.requests[2])).toContain('"signature":"second"')
    expect(server.requests[2]).toMatchObject({ thinking: { type: 'enabled' } })

    // Once a user message closes the round, the formerly kept thinking is stale too.
    const compacted = [user('<compacted-summary>'), first, result(callId(first), 'value'), second, result(callId(second), 'value')]
    await run([...compacted, user('Continue.')])
    expect(wire(server.requests[3])).not.toContain('"signature":"second"')
  })

  it('sends an empty manual-thinking history unchanged', async () => {
    const { server, run } = await setup('anthropic-messages', [{ events: frames('first', false) }], false, true)
    await run([])
    expect(server.requests[0]).toMatchObject({ messages: [] })
  })

  it('omits stale manual thinking from a final assistant message without tool results', async () => {
    const { server, run } = await setup('anthropic-messages', [{ events: frames('first', false) }, { events: frames('second', false) }], false, true)
    const first = await run([user('Answer.')])
    await run([user('<compacted-summary>'), first])
    expect(wire(server.requests[1])).not.toContain('"signature":"first"')
  })

  it('omits stale thinking of the open tool round when the request disables thinking', async () => {
    const { server, run } = await setup('anthropic-messages', [{ events: frames('first', true) }, { events: frames('second', false) }], false)
    const first = await run([user('Look up the value.')])
    await run([user('<compacted-summary>'), first, result(callId(first), 'value')])
    expect(wire(server.requests[1])).not.toContain('"signature":"first"')
  })

  it('drops a thinking-only message and keeps unsigned thinking', async () => {
    const { server, run } = await setup('anthropic-messages', [
      { events: response('only', [{ type: 'thinking', thinking: 'thinking only', signature: 'only' }]) },
      { events: response('unsigned', [{ type: 'thinking', thinking: 'unsigned thinking', signature: '' }, { type: 'text', text: 'reply' }]) },
      { events: frames('third', false) },
    ])
    const only = await run([user('Think.')])
    const unsigned = await run([user('Think.'), only, user('Answer.')])
    await run([user('<compacted-summary>'), only, user('Answer.'), unsigned, user('Again.')])
    const messages = (server.requests[2] as { messages: { role: string }[] }).messages
    expect(messages.map(message => message.role)).toEqual(['user', 'user', 'assistant', 'user'])
    expect(wire(server.requests[2])).not.toContain('thinking only')
    expect(wire(server.requests[2])).toContain('unsigned thinking')
  })

  it('omits stale thinking without an omission observer', async () => {
    const { run } = await setup('anthropic-messages', [{ events: frames('first', true) }])
    const first = await run([user('Look up the value.')])
    const server = await mockServer([{ events: frames('second', false) }])
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ route: {
        api: 'anthropic-messages', baseURL: server.url, apiKeyEnv: 'PREFIX_BINDING_KEY', cacheRetention: 'none',
        models: [{ id: 'model' }], compat: { forceAdaptiveThinking: true },
      } }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })
    const messages = [user('<compacted-summary>'), first, result(callId(first), 'value')]
    for await (const _chunk of adapter.stream({ provider: 'route', model: 'model', messages, tools: [tool], system: 'system' })) { /* drain */ }
    expect(wire(server.requests[0])).not.toContain('"signature":"first"')
  })

  it('records no prefix digest for protocols without prefix binding', async () => {
    const { run } = await setup('openai-completions', [{ events: [
      JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'reply' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      '[DONE]',
    ] }])
    const reply = await run([user('Hello.')])
    expect((reply.source as { replayState: { response: object } }).replayState.response).not.toHaveProperty('prefixDigest')
  })
})
