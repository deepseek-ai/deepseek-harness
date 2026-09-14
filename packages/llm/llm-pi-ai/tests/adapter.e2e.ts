import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, ReasoningEffortId  } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { assemble, type AssembledResult } from './assemble.ts'

/**
 * Real-API e2e for the pi-ai-backed adapter: V4 Flash defaults and
 * off/high/max reasoning. Mirrors the native adapter's StreamChunk contract
 * and exercises a replayed tool follow-up. Key-gated.
 */

const FLASH = 'deepseek-v4-flash'
const contexts: Context[] = []

async function harness(_model: string, config: Partial<PiAiProviderProfile> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: {
      deepseek: {
        ...process.env.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: process.env.DEEPSEEK_API_KEY },
        baseURL: LlmDeepSeek.PUBLIC_BASE_URL,
        ...config,
      },
    },
  })
  return ctx
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function ask(text: string): Message[] {
  return [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })]
}

function textOf(result: AssembledResult): string {
  return result.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function blockKinds(result: AssembledResult): string[] {
  return result.message.content.map(block => block.type)
}

const weatherTool: ToolSchema = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('llm-pi-ai e2e (real API)', () => {
  it(`${FLASH} + provider-default reasoning: plain text generation`, async () => {
    const ctx = await harness(FLASH)
    const result = await assemble(ctx,{
      model: FLASH,
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(textOf(result).toLowerCase()).toContain('pong')
  })

  it('flash + reasoning off: plain text without reasoning blocks', async () => {
    const ctx = await harness(FLASH)
    const result = await assemble(ctx,{
      model: FLASH,
      reasoningEffort: ReasoningEffortId('off'),
      messages: ask('Reply with exactly the word: pong'),
      maxTokens: 50,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(false)
    expect(textOf(result).toLowerCase()).toContain('pong')
  })

  it(`${FLASH} + reasoning high: reasoning blocks present`, async () => {
    const ctx = await harness(FLASH)
    const result = await assemble(ctx,{
      model: FLASH,
      reasoningEffort: ReasoningEffortId('high'),
      messages: ask('Which is larger, 9.11 or 9.8? Answer with just the number.'),
      maxTokens: 2000,
    })
    expect(result.finish.kind).toBe('stop')
    expect(result.message.content.some(block => block.type === 'reasoning')).toBe(true)
    expect(textOf(result)).toContain('9.8')
  })

  it('flash + reasoning max: tool-call round trip', async () => {
    const ctx = await harness(FLASH)

    const first = await assemble(ctx,{
      model: FLASH,
      reasoningEffort: ReasoningEffortId('max'),
      messages: ask('What is the weather in Paris right now? Use the get_weather tool.'),
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(
      first.finish.kind,
      `pi-ai Flash tool-call turn finished as ${JSON.stringify(first.finish)}`,
    ).toBe('tool-calls')
    const call = first.message.content.find(block => block.type === 'tool-call')
    expect(call).toBeDefined()
    expect(call!.name).toBe('get_weather')
    expect(JSON.parse(call!.arguments)).toMatchObject({ city: expect.stringMatching(/paris/i) as string })

    const second = await assemble(ctx,{
      model: FLASH,
      reasoningEffort: ReasoningEffortId('max'),
      messages: [
        ...ask('What is the weather in Paris right now? Use the get_weather tool.'),
        first.message,
        createUserMessage({
          content: [{
            type: 'tool-result',
            toolCallId: ToolCallId(call!.id),
            content: [{ type: 'text', text: 'Sunny, 22°C' }],
          }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
      ],
      tools: [weatherTool],
      maxTokens: 2000,
    })
    expect(
      second.finish.kind,
      `pi-ai Flash tool-result turn finished as ${JSON.stringify(second.finish)}`,
    ).toBe('stop')
    expect(textOf(second).toLowerCase()).toMatch(/sunny|22/)
  })

  it('produces the same block structure as llm-deepseek for the same prompt', async () => {
    // Loose structural equivalence between the two independent adapters:
    // same block KINDS in the same order for a deterministic prompt — the
    // cross-implementation check that the StreamChunk design holds.
    const deepseekCtx = new Context()
    contexts.push(deepseekCtx)
    await deepseekCtx.plugin(LlmRuntime)
    await deepseekCtx.plugin(LlmDeepSeek, { thinking: 'disabled' })

    const piCtx = await harness(FLASH)

    const prompt = ask('Reply with exactly the word: pong')
    const [fromDeepSeek, fromPiAi] = await Promise.all([
      assemble(deepseekCtx, { provider: 'deepseek-official', model: FLASH, messages: prompt, maxTokens: 50 }),
      assemble(piCtx, { model: FLASH, messages: prompt, maxTokens: 50 }),
    ])
    expect(blockKinds(fromPiAi)).toEqual(blockKinds(fromDeepSeek))
    expect(fromPiAi.finish.kind).toBe(fromDeepSeek.finish.kind)
  })
})
