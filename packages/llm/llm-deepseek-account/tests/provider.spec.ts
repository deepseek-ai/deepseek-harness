/** Account and API-key plugins own independent route registrations and catalogs. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import * as ApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { afterEach, expect, it, vi } from 'vitest'
import * as Account from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
})

it('keeps discovery and disposal independent across the two credential routes', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  let token: string | undefined = 'fixture-account-token'
  ctx.provide('deepseekAccount', { resolveToken: async (_baseURL: string): Promise<string | undefined> => token } as DeepSeekAccount)
  const account = ctx.plugin(Account, { models: [{ id: 'account-model', name: 'Account model' }] })
  await account
  expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['deepseek-account'])
  const official = ctx.plugin(ApiKey, { models: [{ id: 'api-key-model', name: 'API-key model' }] })
  await official
  expect((await ctx.llm.listModels('deepseek-account')).map(row => row.id)).toEqual(['account-model'])
  expect((await ctx.llm.listModels('deepseek-official')).map(row => row.id)).toEqual(['api-key-model'])
  expect(ctx.llm.listConfigurableProviders().map(row => [row.provider, row.settingsNs])).toEqual([
    ['deepseek-account', 'llm-deepseek-account'], ['deepseek-official', 'llm-deepseek-api-key'],
  ])
  expect(Account.Config({})).not.toHaveProperty('apiKeyEnv')
  token = undefined
  expect(await ctx.llm.listModels('deepseek-account')).toEqual([])
  expect(await ctx.llm.listModels('deepseek-official')).toHaveLength(1)
  token = 'new-account-token'
  expect(await ctx.llm.listModels('deepseek-account')).toHaveLength(1)
  await account.dispose()
  expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['deepseek-official'])
  expect(ctx.llm.listConfigurableProviders().map(row => row.provider)).toEqual(['deepseek-official'])
  await official.dispose()
  expect(ctx.llm.listProviders()).toEqual([])
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
})
