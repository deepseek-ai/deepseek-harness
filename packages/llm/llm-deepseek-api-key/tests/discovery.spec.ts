/** Model discovery requires the API-key route's own credential. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import * as ApiKey from '../src/index.ts'

it.each([undefined, ''])('hides models without an API key: %j', async (key) => {
  vi.stubEnv('DEEPSEEK_API_KEY', key)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, {})
    expect(await ctx.llm.listModels('deepseek-official')).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('advertises configured models with an API key', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, { models: [{ id: 'configured-model' }] })
    expect(await ctx.llm.listModels('deepseek-official')).toEqual([
      expect.objectContaining({ provider: 'deepseek-official', id: 'configured-model' }),
    ])
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('reports malformed credentials during discovery', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'invalid\nheader')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, {})
    await expect(ctx.llm.listModels('deepseek-official')).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('publishes the route API key for its consumers from the credential planes it reads itself', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, { baseURL: 'https://route.deepseek.test/anthropic' })
    const credential = ctx.llm.routeCredential('deepseek-official')
    expect(credential).toMatchObject({ kind: 'api-key', baseURL: 'https://route.deepseek.test/anthropic', reference: 'DEEPSEEK_API_KEY' })
    const endpoint = 'https://route.deepseek.test/v1/tools/search'
    await expect(credential!.configured(endpoint)).resolves.toBe(true)
    await expect(credential!.resolve(endpoint)).resolves.toEqual({ headers: { 'x-api-key': 'fixture-api-key' }, value: 'fixture-api-key' })
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await expect(credential!.configured(endpoint)).resolves.toBe(false)
    await expect(credential!.resolve(endpoint)).resolves.toBeUndefined()
    vi.stubEnv('DEEPSEEK_API_KEY', 'invalid\nheader')
    await expect(credential!.configured(endpoint)).resolves.toBe(true)
    await expect(credential!.resolve(endpoint)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})
