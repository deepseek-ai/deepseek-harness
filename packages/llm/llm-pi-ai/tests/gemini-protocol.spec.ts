/** A hand-declared route can speak the Gemini API protocol. */

import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage } from '@deepseek-ai/dsh-llm'
import * as PiAi from '../src/index.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
})

/** One complete Gemini stream reply carrying `parts`. */
function reply(parts: Record<string, unknown>[]): { events: string[] } {
  return { events: [JSON.stringify({
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  })] }
}

async function gateway(url: string): Promise<Context> {
  vi.stubEnv('GEMINI_GATEWAY_KEY', 'gemini-key')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(PiAi, { providers: { 'gemini-gateway': {
    apiKeyEnv: 'GEMINI_GATEWAY_KEY',
    api: 'google-generative-ai',
    baseURL: `${url}/v1beta`,
    models: [{ id: 'gemini-test' }],
  } } })
  return ctx
}

it('streams a hand-declared Gemini route from its configured endpoint', async () => {
  const server = await mockServer([reply([{ text: 'hello' }])])
  const ctx = await gateway(server.url)

  const result = await assemble(ctx, {
    provider: 'gemini-gateway',
    model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })

  expect(result.finish).toEqual({ kind: 'stop' })
  expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
  expect(server.paths).toEqual(['/v1beta/models/gemini-test:streamGenerateContent?alt=sse'])
  expect(server.headers[0]?.['x-goog-api-key']).toBe('gemini-key')
})

it('returns a Gemini function call and replays it with its result', async () => {
  const server = await mockServer([
    reply([{ functionCall: { name: 'count', args: { value: 2 } }, thoughtSignature: 'c2ln' }]),
    reply([{ text: 'two' }]),
  ])
  const ctx = await gateway(server.url)
  const tools = [{ name: 'count', description: 'Count', parameters: { type: 'object', properties: { value: { type: 'number' } } } }]
  const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'count' }] }

  const call = await assemble(ctx, { provider: 'gemini-gateway', model: 'gemini-test', tools, messages: [user] })
  const [block] = call.message.content
  if (block?.type !== 'tool-call') throw new Error('expected a tool call')
  expect(call.finish).toEqual({ kind: 'tool-calls' })
  expect(block).toMatchObject({ name: 'count', arguments: '{"value":2}' })
  expect(server.requests[0]).toMatchObject({ tools: [{ functionDeclarations: [{ name: 'count' }] }] })

  const answer = await assemble(ctx, {
    provider: 'gemini-gateway',
    model: 'gemini-test',
    tools,
    messages: [user, call.message, createMessage({
      role: 'tool', source: { kind: 'tool', callId: block.id }, toolCallId: block.id, content: [{ type: 'text', text: '2' }],
    })],
  })
  expect(answer.message.content).toEqual([{ type: 'text', text: 'two' }])
  expect(server.requests[1]).toMatchObject({ contents: [
    { role: 'user' },
    { role: 'model', parts: [{ functionCall: { name: 'count', args: { value: 2 } }, thoughtSignature: 'c2ln' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'count' } }] },
  ] })
})
