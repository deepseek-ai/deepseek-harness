/** The configured model catalog is independent of request credentials. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import * as ApiKey from '../src/index.ts'

it.each(['', 'invalid\nheader'])('advertises configured models without a usable API key: %j', async (key) => {
  vi.stubEnv('DEEPSEEK_API_KEY', key)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, {})
    expect(await ctx.llm.listModels('deepseek-official')).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'deepseek-official', id: 'deepseek-flash' }),
    ]))
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})
