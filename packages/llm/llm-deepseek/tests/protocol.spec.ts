/** Same-provider protocol changes retain prepared requests and durable conversation content. */
import { afterEach, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { Config, DeepSeekAdapter, resolveAdapterOptions } from '../src/index.ts'
import type { DeepSeekConnectionOptions } from '../src/index.ts'
import { assemble, chunks, end, MODEL, options, server, sse, start, textEvents, user } from './messages/helpers.ts'

const close: (() => Promise<void>)[] = []
afterEach(async () => {
  while (close.length) await close.pop()!()
})
async function endpoint(...args: Parameters<typeof server>) {
  const instance = await server(...args)
  close.push(() => instance.close())
  return instance
}
const chat = 'data: {"choices":[{"delta":{"content":"Chat answer"}}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
function adapter(connection: () => DeepSeekConnectionOptions) {
  return new DeepSeekAdapter({
    options: connection,
    resolveApiKey: snapshot => Promise.resolve(`key-for-${snapshot.apiKeyEnv}`),
    resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
    prepareExtensions: () => Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  })
}

it.each([false, true])('uses Messages when protocol is omitted, schema=%s', async (schema) => {
  const http = await endpoint()
  const raw = { baseURL: http.url }
  const connection = resolveAdapterOptions(schema ? Config(raw) : raw)
  const response = await assemble(adapter(() => connection).stream(options()))

  expect(response.message.content).toEqual([{ type: 'text', text: 'Hello 世界' }])
  expect(http.requests).toHaveLength(1)
  expect(http.requests[0]).toMatchObject({
    path: '/anthropic/v1/messages',
    headers: { 'x-api-key': 'key-for-DEEPSEEK_API_KEY', 'anthropic-version': '2023-06-01' },
    body: { model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
  })
})

it('keeps the prepared Messages protocol, credential reference and endpoint after switching to Chat', async () => {
  const first = await endpoint(), second = await endpoint(response => response.end(chat))
  let connection = resolveAdapterOptions({ protocol: 'messages', baseURL: first.url, apiKeyEnv: 'MESSAGES_KEY', maxTokens: 12 })
  const llm = adapter(() => connection)
  const prepared = await llm.prepareCall('deepseek-official', MODEL)
  connection = resolveAdapterOptions({ protocol: 'chat-completions', baseURL: second.url, apiKeyEnv: 'CHAT_KEY', maxTokens: 24 })
  await chunks(prepared.stream(options()))
  await chunks(prepared.stream(options()))
  expect(prepared.model.defaultMaxTokens).toBe(12)
  expect((await llm.resolveModel('deepseek-official', MODEL)).defaultMaxTokens).toBe(24)
  await chunks(llm.stream(options()))
  expect(first.requests).toHaveLength(2)
  for (const request of first.requests) expect(request).toMatchObject({
    path: '/anthropic/v1/messages', headers: { 'x-api-key': 'key-for-MESSAGES_KEY' }, body: { max_tokens: 12 },
  })
  expect(second.requests).toHaveLength(1)
  expect(second.requests[0]).toMatchObject({ path: '/anthropic/chat/completions', headers: { authorization: 'Bearer key-for-CHAT_KEY' } })
})

it('continues Messages → Chat → Messages with the same provider and without leaking native signatures to Chat', async () => {
  const signed = [start,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Reasoning', signature: 'native-signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Messages answer' } },
    { type: 'content_block_stop', index: 1 }, ...end(),
  ]
  const http = await endpoint((response, count) => response.end(count === 1 ? sse(signed) : count === 2 ? chat : sse(textEvents)))
  let connection = resolveAdapterOptions({ protocol: 'messages', baseURL: http.url })
  const llm = adapter(() => connection)
  const history: Message[] = [user()]
  const first = await assemble(llm.stream(options({ messages: history })))
  history.push(first.message, user('continue with Chat'))
  const saved = JSON.stringify(history)
  connection = resolveAdapterOptions({ protocol: 'chat-completions', baseURL: http.url })
  const second = await assemble(llm.stream(options({ messages: history })))
  expect(JSON.stringify(http.requests[1]?.body)).not.toContain('signature')
  expect(http.requests[1]?.body.messages).toContainEqual({ role: 'assistant', content: 'Messages answer', reasoning_content: 'Reasoning' })
  expect(JSON.stringify(history)).toBe(saved)
  expect(second.message.source.replayState).toBeUndefined()
  history.push(second.message, user('continue with Messages'))
  connection = resolveAdapterOptions({ protocol: 'messages', baseURL: http.url })
  const third = await assemble(llm.stream(options({ messages: history })))
  expect(third.assembler.finish.kind).toBe('stop')
  const messages = http.requests[2]?.body.messages as { role: string; content: unknown[] }[]
  expect(messages.filter(message => message.role === 'assistant')).toEqual([
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Reasoning', signature: 'native-signature' }, { type: 'text', text: 'Messages answer' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Chat answer' }] },
  ])
})
