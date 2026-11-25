import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as mock from '@deepseek-ai/dsh-llm-mock'

describe('llm-mock', () => {
  it('registers one mock model that streams the configured reply until disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = ctx.plugin(mock, { reply: 'Configured reply.' })
    await fiber

    expect(ctx.llm.listProviders()).toContainEqual({ id: 'mock', name: 'Mock' })
    expect(await ctx.llm.listModels('mock')).toEqual([
      { provider: 'mock', id: 'mock', name: 'Mock model', inputModalities: ['text'] },
    ])
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Configured reply.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Configured reply.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])

    await fiber.dispose()
    expect(ctx.llm.listProviders().map(provider => provider.id)).not.toContain('mock')
  })

  it('streams the default reply without configuration', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(mock)
    const texts: string[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] })) {
      if (chunk.type === 'text-delta') texts.push(chunk.text)
    }
    expect(texts).toEqual(['This is a mock model reply.'])
  })
})
