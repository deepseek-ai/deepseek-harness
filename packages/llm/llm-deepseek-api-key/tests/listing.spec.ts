/** The API-key route serves the official /models listing while its catalog is the built-in one. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as ApiKey from '../src/index.ts'

const LISTING_URL = 'https://api.deepseek.com/models'
const MESSAGES = { output_modalities: ['text'], api_capabilities: { anthropic_messages: {} } }
const FLASH = {
  id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1_048_576, max_output_tokens: 393_216,
  input_modalities: ['text', 'image'], output_modalities: ['text'],
  api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
}
const PRO = { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context_window: 1_048_576, input_modalities: ['text'], ...MESSAGES }
const requires = (version: string) => ({ client_requirements: { 'deepseek-harness': { min_version: version } } })
const BUILT_IN = ['deepseek-flash', 'deepseek-v4-pro']

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Answer the official listing URL with `reply`; any other request fails, so nothing reaches the network. */
function officialListing(reply: (request: Request, index: number) => Response) {
  const requests: Request[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const request = new Request(input, init)
    if (request.url !== LISTING_URL) return Promise.reject(new Error(`unexpected request to ${request.url}`))
    requests.push(request)
    return Promise.resolve(reply(request, requests.length - 1))
  })
  return requests
}
const listing = (...rows: object[]) => () => new Response(JSON.stringify({ object: 'list', data: rows }), { headers: { 'content-type': 'application/json' } })

async function host(key: string | undefined = 'fixture-api-key') {
  vi.stubEnv('DEEPSEEK_API_KEY', key)
  const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  return { ctx, diagnostics, warn }
}
const ids = async (ctx: Context) => (await ctx.llm.listModels('deepseek-official')).map(model => model.id)

it('follows the official listing while the catalog is the built-in one', async () => {
  const requests = officialListing(listing(FLASH, { ...PRO, id: 'deepseek-v5', ...requires('0.0.1') }, PRO))
  const { ctx, diagnostics } = await host()
  await ctx.plugin(ApiKey, {})
  expect(await ids(ctx)).toEqual(['deepseek-flash', 'deepseek-v5', 'deepseek-v4-pro'])
  await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
    context: { contextWindow: 1_048_576 }, systemPromptUpdate: 'in-history', toolUpdate: 'addition-only', inputModalities: ['text', 'image'],
  })
  expect(requests.map(request => request.headers.get('x-api-key'))).toEqual(['fixture-api-key'])
  expect(diagnostics).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-api-key]', expect.stringContaining('loaded 3 model(s), skipped 0 row(s)') as string)
})

it('keeps a customized catalog without requesting the listing', async () => {
  const requests = officialListing(listing(FLASH))
  const { ctx } = await host()
  await ctx.plugin(ApiKey, { models: [{ id: 'custom', name: 'Custom' }] })
  expect(await ids(ctx)).toEqual(['custom'])
  await expect(ctx.llm.resolveModelInfo('deepseek-official', 'custom')).resolves.toMatchObject({ name: 'Custom' })
  expect(requests).toEqual([])
})

it('serves the built-in catalog on another endpoint without requesting a listing', async () => {
  const requests = officialListing(listing(FLASH))
  const { ctx } = await host()
  await ctx.plugin(ApiKey, { baseURL: 'http://127.0.0.1:9/anthropic' })
  expect(await ids(ctx)).toEqual(BUILT_IN)
  expect(requests).toEqual([])
})

it('falls back to the built-in catalog when the listing fails', async () => {
  officialListing(() => new Response('down', { status: 503 }))
  const { ctx, warn } = await host()
  await ctx.plugin(ApiKey, {})
  expect(await ids(ctx)).toEqual(BUILT_IN)
  expect(warn).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-api-key]', expect.stringContaining('using the bundled catalog') as string)
})

it('refuses listed models this build cannot serve before any inference request', async () => {
  const requests = officialListing(listing(
    FLASH, { ...PRO, id: 'deepseek-v5' }, { ...PRO, id: 'deepseek-v5-next', ...requires('99.0.0-alpha.1') }, { id: 'deepseek-v4-pro' },
  ))
  const { ctx, warn } = await host()
  await ctx.plugin(ApiKey, {})
  expect(await ids(ctx)).toEqual(['deepseek-flash'])
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-v5' })).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-v5-next' })).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'unlisted-pass-through' })).resolves.toBeDefined()
  expect(warn).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-api-key]', 'model "deepseek-v4-pro" declares no api_capabilities.anthropic_messages')
  expect(requests).toHaveLength(1)
})

it("leaves a malformed replacement key to the request instead of refusing by the previous key's listing", async () => {
  const requests = officialListing(listing(FLASH, PRO, { ...PRO, id: 'deepseek-v5-next', ...requires('99.0.0-alpha.1') }))
  const { ctx } = await host()
  vi.stubEnv('MALFORMED_DEEPSEEK_API_KEY', 'invalid\nheader')
  const live = await liveConfig(ctx, ApiKey, {})
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-v5-next' })).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' })
  await live.update({ apiKeyEnv: 'MALFORMED_DEEPSEEK_API_KEY' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-official', model: 'deepseek-v5-next' })).resolves.toBeDefined()
  expect(requests).toHaveLength(1)
})

it('lets a caller abandon the first listing wait', async () => {
  const started = Promise.withResolvers<undefined>()
  vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
    started.resolve(undefined)
    init?.signal?.addEventListener('abort', () => {
      reject(new Error('listing request aborted', { cause: init.signal?.reason }))
    }, { once: true })
  }))
  const { ctx } = await host()
  await ctx.plugin(ApiKey, {})
  const caller = new AbortController()
  const pending = ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash', caller.signal)
  await started.promise
  caller.abort(new Error('caller left'))
  await expect(pending).rejects.toThrow('caller left')
})

it.each([[{}], [{ models: [{ id: 'custom' }] }]])('hides the route without a key and requests nothing for %j', async (config) => {
  const requests = officialListing(listing(FLASH))
  const { ctx } = await host('')
  await ctx.plugin(ApiKey, config)
  expect(await ids(ctx)).toEqual([])
  expect(requests).toEqual([])
})

it('reloads the listing once when the catalog returns to the built-in one', async () => {
  const requests = officialListing((_request, index) => (index === 0 ? listing(FLASH, PRO) : listing(FLASH, PRO, { ...PRO, id: 'deepseek-v5', ...requires('0.0.1') }))())
  const { ctx } = await host()
  const live = await liveConfig(ctx, ApiKey, {})
  expect(await ids(ctx)).toEqual(BUILT_IN)
  await live.update({ models: [{ id: 'custom' }] })
  expect(await ids(ctx)).toEqual(['custom'])
  expect(requests).toHaveLength(1)
  await live.replace({})
  expect(await ids(ctx)).toEqual([...BUILT_IN, 'deepseek-v5'])
  expect(requests).toHaveLength(2)
})

it('keeps following the listing across an update the adapter rejects', async () => {
  const requests = officialListing(listing(FLASH, PRO))
  const { ctx } = await host()
  const live = await liveConfig(ctx, ApiKey, {})
  expect(await ids(ctx)).toEqual(BUILT_IN)
  await live.update({ thinking: 'disabled', reasoningEffort: 'high' })
  await expect(ctx.llm.listModels('deepseek-official')).rejects.toThrow(/only reasoningEffort "off"/)
  await live.replace({})
  expect(await ids(ctx)).toEqual(BUILT_IN)
  expect(requests).toHaveLength(1)
})
