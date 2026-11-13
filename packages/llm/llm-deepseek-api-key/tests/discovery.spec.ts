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

it('reports malformed credentials during discovery under the settings namespace the provider directory lists', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'invalid\nheader')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, {})
    const [directory] = ctx.llm.listConfigurableProviders()
    expect(directory?.settingsNs).toBe('llm-deepseek-api-key')
    const failure = ctx.llm.listModels('deepseek-official')
    await expect(failure).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    await expect(failure).rejects.toThrow('llm-deepseek-api-key: the API key resolved from DEEPSEEK_API_KEY contains characters')
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('names the Loader entry id in credential diagnostics, as product profiles mount the route', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'invalid\nheader')
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin({
      name: ApiKey.name, inject: ApiKey.inject, Config: ApiKey.Config,
      apply: (inner: Context, config: ApiKey.Config) => {
        // The Loader attaches the entry before a plugin applies; product profiles use the id `llm-deepseek`.
        Object.defineProperty(inner.fiber, 'entry', { value: { options: { id: 'llm-deepseek' } } })
        ApiKey.apply(inner, config)
      },
    }, {})
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.settingsNs)).toEqual(['llm-deepseek'])
    await expect(ctx.llm.listModels('deepseek-official')).rejects.toThrow(
      'llm-deepseek: the API key resolved from DEEPSEEK_API_KEY contains characters no HTTP header can carry',
    )
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
    const credential = ctx.llm.providerCredential('deepseek-official')
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

it.each([
  'https://other-origin.example/v1/tools/search',
  'http://route.deepseek.test/v1/tools/search',
  'https://route.deepseek.test:8443/v1/tools/search',
  'https://user@route.deepseek.test/v1/tools/search',
  'https://:secret@route.deepseek.test/v1/tools/search',
])('releases no key for %s, a destination outside the origin of its base URL, without reading the credential store', async (endpoint) => {
  const resolve = vi.fn(async () => ({ value: 'stored-key' }))
  const describe = vi.fn(async () => ({ configured: true }))
  const ctx = new Context()
  try {
    ctx.provide('credentials', { resolve, describe } as never)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, { baseURL: 'https://route.deepseek.test/anthropic' })
    const credential = ctx.llm.providerCredential('deepseek-official')
    await expect(credential!.configured(endpoint)).resolves.toBe(false)
    await expect(credential!.resolve(endpoint)).resolves.toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
    expect(describe).not.toHaveBeenCalled()
    // The same store answers for a destination under the route's origin.
    const served = 'https://route.deepseek.test/v1/tools/search'
    await expect(credential!.configured(served)).resolves.toBe(true)
    await expect(credential!.resolve(served)).resolves.toEqual({ headers: { 'x-api-key': 'stored-key' }, value: 'stored-key' })
  } finally {
    await ctx.fiber.dispose()
  }
})
