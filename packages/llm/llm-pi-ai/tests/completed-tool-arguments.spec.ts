/** Completed provider arguments fail before a malformed call can enter successful history or dispatch. */

import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { anthropicFrame, anthropicMessageStart, closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

type Api = 'anthropic-messages' | 'openai-completions' | 'openai-responses'
type WireEvent = string | { event: string; data: string }

function completionsEvents(raw: string, stop: 'tool_calls' | 'length' = 'tool_calls'): WireEvent[] {
  return [
    JSON.stringify({ choices: [{ index: 0, delta: {
      role: 'assistant', content: 'before tool',
      tool_calls: [{ index: 0, id: 'call_invalid', type: 'function', function: { name: 'count', arguments: raw } }],
    }, finish_reason: null }] }),
    JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: stop }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    '[DONE]',
  ]
}

function anthropicEvents(raw: string, stop: 'tool_use' | 'max_tokens' = 'tool_use'): WireEvent[] {
  return [
    anthropicMessageStart,
    anthropicFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'before tool' } }),
    anthropicFrame({ type: 'content_block_stop', index: 0 }),
    anthropicFrame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_invalid', name: 'count', input: {} } }),
    anthropicFrame({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: raw } }),
    anthropicFrame({ type: 'content_block_stop', index: 1 }),
    // Anthropic reports the reason after the tool block closes.
    anthropicFrame({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } }),
    anthropicFrame({ type: 'message_stop' }),
  ]
}

function responsesEvents(raw: string, prefix?: string, priorValid = false, priorArguments = '{}'): WireEvent[] {
  const valid = { type: 'function_call', call_id: 'call_valid', id: 'item_valid', name: 'count', arguments: priorArguments }
  const invalid = { type: 'function_call', call_id: 'call_invalid', id: 'item_invalid', name: 'count', arguments: raw }
  const outputIndex = priorValid ? 1 : 0
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'response_arguments' } }),
    ...priorValid ? [
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...valid, arguments: '' } }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: valid }),
    ] : [],
    JSON.stringify({ type: 'response.output_item.added', output_index: outputIndex, item: { ...invalid, arguments: '' } }),
    ...prefix === undefined ? [] : [JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: outputIndex, delta: prefix })],
    JSON.stringify({ type: 'response.output_item.done', output_index: outputIndex, item: invalid }),
    JSON.stringify({ type: 'response.completed', response: {
      id: 'response_arguments', status: 'completed', output: priorValid ? [valid, invalid] : [invalid],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    } }),
  ]
}

function registerAdapter(ctx: Context, api: Api, baseURL: string): void {
  ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new PiAiAdapter({
    profiles: () => resolveProfiles({ fixture: { api, baseURL, models: [{ id: 'm' }], transport: 'sse' } }),
    resolveApiKey: () => Promise.resolve('fixture-key'),
    auth: memoryAuth(),
  })))
}

async function collect(api: Api, events: WireEvent[]) {
  const server = await mockServer([{ events }])
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  registerAdapter(ctx, api, server.url)
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'fixture', model: 'm', messages: [] })) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { chunks, assembler, server }
}

describe('completed tool-call arguments through the public runtime', () => {
  it.each([
    ['anthropic-messages', anthropicEvents],
    ['openai-completions', completionsEvents],
    ['openai-responses', responsesEvents],
  ] as const)('%s rejects malformed completed arguments without successful replay', async (api, events) => {
    const raw = '{"value":"unfinished'
    const { chunks, assembler, server } = await collect(api, events(raw))
    expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } })
    expect(assembler.finish).toHaveProperty('failure.message', expect.stringContaining(raw))
    expect(assembler.replayState).toBeUndefined()
    expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    expect(server.requests).toHaveLength(1)
  })

  it.each(['null', '[]', '42'])('rejects non-object completed arguments %s', async (raw) => {
    const { assembler } = await collect('openai-completions', completionsEvents(raw))
    expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } })
    expect(assembler.replayState).toBeUndefined()
  })

  it('uses authoritative invalid Responses arguments after a valid streamed prefix', async () => {
    const raw = '{"value":"final-invalid'
    const { chunks, assembler } = await collect('openai-responses', responsesEvents(raw, '{"value":"valid-prefix"}'))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-call-delta', argumentsDelta: '{"value":"valid-prefix"}' }))
    expect(assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } })
    expect(assembler.finish).toHaveProperty('failure.message', expect.stringContaining(raw))
    expect(assembler.replayState).toBeUndefined()
  })

  it('retains the first completed-argument failure when several calls are invalid', async () => {
    const { assembler } = await collect('openai-responses', responsesEvents('[]', undefined, true, '[1]'))
    expect(assembler.finish).toEqual({ kind: 'error', failure: {
      code: 'MALFORMED_RESPONSE', message: 'Tool call "count": Tool arguments must be a JSON object\n\nReceived arguments:\n[1]',
    } })
    expect(assembler.replayState).toBeUndefined()
  })

  it('retains a native provider failure after malformed argument output', async () => {
    const events = responsesEvents('[]').slice(0, -1)
    events.push(JSON.stringify({ type: 'response.failed', response: {
      id: 'response_arguments', status: 'failed', error: { code: 'server_error', message: 'upstream failure' },
    } }))
    const { assembler } = await collect('openai-responses', events)
    expect(assembler.finish).toMatchObject({ kind: 'error' })
    expect(assembler.finish).toHaveProperty('failure.message', expect.stringContaining('upstream failure'))
    expect(assembler.finish).not.toMatchObject({ failure: { code: 'MALFORMED_RESPONSE' } })
    expect(assembler.replayState).toBeUndefined()
  })

  it('accepts authoritative valid Responses arguments after an incomplete prefix', async () => {
    const { assembler } = await collect('openai-responses', responsesEvents('{"value":"complete"}', '{"value":'))
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.blocks()).toEqual([{ type: 'tool-call', id: 'call_invalid|item_invalid', name: 'count', arguments: '{"value":"complete"}' }])
    expect(assembler.replayState?.blocks).toEqual([{ type: 'tool-call' }])
  })

  it('preserves repaired invalid Unicode escapes as complete arguments', async () => {
    const { assembler } = await collect('openai-completions', completionsEvents(String.raw`{"value":"\usepackage{x}"}`))
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(assembler.blocks()).toContainEqual(expect.objectContaining({ type: 'tool-call', arguments: JSON.stringify({ value: String.raw`\usepackage{x}` }) }))
    expect(assembler.replayState).toBeDefined()
  })

  it.each([
    ['anthropic-messages', anthropicEvents('{"value":', 'max_tokens')],
    ['openai-completions', completionsEvents('{"value":', 'length')],
  ] as const)('%s keeps max-token truncation and prunes its incomplete call', async (api, events) => {
    const { assembler } = await collect(api, [...events])
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'before tool' }])
    expect(assembler.replayState?.blocks).toEqual([{ type: 'text' }])
    expect(assembler.replayState?.response).toMatchObject({ stopReason: 'length' })
  })

  it('does not dispatch an earlier valid parallel call when a later call is malformed', async () => {
    const raw = '{"value":"unfinished'
    const server = await mockServer([{ events: responsesEvents(raw, undefined, true) }])
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    registerAdapter(ctx, 'openai-responses', server.url)
    const loop = await mountAgentLoopTestHarness(ctx)
    let executions = 0
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name: 'count', description: 'Count executions', parameters: {},
      isConcurrencySafe: () => true,
      async execute() { executions++; return [{ type: 'text', text: 'counted' }] },
    })))
    const agent = await loop.create(SessionId('malformed-parallel'), { provider: 'fixture', model: 'm' })
    const idle = new Promise<void>((resolve) => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { dispose(); resolve() }
      })
    })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'count twice' }] }))
    await idle
    const events = agent.session.snapshotEvents()
    expect(executions).toBe(0)
    expect(events.filter(event => event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'assistant/message')).toEqual([])
    const attempts = events.filter(event => event.type === 'assistant/attempt')
    expect(attempts).toHaveLength(1)
    expect(JSON.stringify(attempts)).toContain('call_valid|item_valid')
    expect(JSON.stringify(attempts)).toContain('MALFORMED_RESPONSE')
    expect(JSON.stringify(attempts)).not.toContain('replayState')
    expect(events.find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'MALFORMED_RESPONSE' } } },
    })
    expect(server.requests).toHaveLength(1)
  })
})
