/** Messages request contributions settle with the HTTP request that carries them. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type { DeepSeekLlmApiExtensionRequest } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as DeepSeek from '../../src/index.ts'
import { assemble, options, sse, textEvents } from './helpers.ts'

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions' {
  interface DeepSeekLlmApiExtensionMap {
    dsh_messages_test: { value: string }
  }
}

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function boot() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-messages-extensions-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeekLlmApiExtensionRegistry)
  await ctx.plugin(DeepSeek, { baseURL: 'https://messages.example.test/root' })
  return ctx
}

describe('Messages request extensions', () => {
  it('prepares the native body and accepts its contribution before yielding content', async () => {
    const ctx = await boot()
    let request: DeepSeekLlmApiExtensionRequest | undefined
    const accepted = vi.fn()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', {
      prepare: (value) => {
        request = value
        return { value: { value: 'inventory' }, accept: accepted }
      },
    })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      expect(accepted).not.toHaveBeenCalled()
      return Promise.resolve(new Response(sse(textEvents)))
    })
    vi.stubGlobal('fetch', fetch)
    const stream = ctx.llm.stream(options({ sessionId: SessionId('session-parity'), purpose: 'compaction' }))
    for await (const chunk of stream) {
      expect(accepted).toHaveBeenCalledOnce()
      if (chunk.type === 'finish') expect(chunk.reason.kind).toBe('stop')
    }
    expect(request).toMatchObject({
      sessionId: 'session-parity', purpose: 'compaction',
      body: { thinking: { type: 'enabled' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    })
    expect(request?.body).not.toHaveProperty('dsh_messages_test')
    expect(fetch.mock.calls[0]?.[0]).toBe('https://messages.example.test/root/v1/messages')
    const body = fetch.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Expected a serialized Messages request')
    expect(JSON.parse(body)).toMatchObject({ dsh_messages_test: { value: 'inventory' } })
  })

  it('rejects preparation before dispatch', async () => {
    const ctx = await boot()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', { prepare() { throw new Error('inventory unavailable') } })
    const fetch = vi.fn<typeof globalThis.fetch>()
    vi.stubGlobal('fetch', fetch)
    const result = await assemble(ctx.llm.stream(options()))
    expect(result.assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'REQUEST_EXTENSION' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['http', 'transport', 'stream'] as const)('records acceptance only for HTTP success despite a later %s failure', async (failure) => {
    const ctx = await boot()
    const accept = vi.fn()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', { prepare: () => ({ value: { value: 'log' }, accept }) })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      if (failure === 'transport') return Promise.reject(new Error('connection lost'))
      if (failure === 'http') return Promise.resolve(Response.json({ error: { message: 'rejected' } }, { status: 400 }))
      return Promise.resolve(new Response(''))
    }))
    const result = await assemble(ctx.llm.stream(options()))
    expect(result.assembler.finish.kind).toBe('error')
    expect(accept).toHaveBeenCalledTimes(failure === 'stream' ? 1 : 0)
  })

  it('retains the extension error category when acceptance fails', async () => {
    const ctx = await boot()
    ctx.deepseekLlmApiExtensions.register('dsh_messages_test', {
      prepare: () => ({ value: { value: 'log' }, accept() { throw new Error('watermark storage failed') } }),
    })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(sse(textEvents))))
    const result = await assemble(ctx.llm.stream(options()))
    expect(result.assembler.finish).toMatchObject({ kind: 'error', failure: { code: 'REQUEST_EXTENSION' } })
    expect(result.message.content).toEqual([])
  })
})
