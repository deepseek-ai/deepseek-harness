/** The account route serves its /models listing, gates models, and keeps discovery independent of the API-key route. */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import * as ApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as Account from '../src/index.ts'

const MESSAGES = { output_modalities: ['text'], api_capabilities: { anthropic_messages: {} } }
const FLASH = {
  id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1_048_576, max_output_tokens: 393_216,
  input_modalities: ['text', 'image'], output_modalities: ['text'],
  effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
  api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
}
const PRO = { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ['text'], ...MESSAGES }
const requires = (version: string) => ({ client_requirements: { 'deepseek-harness': { min_version: version } } })

const contexts: Context[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Loopback listing endpoint: `reply` answers GET /models; any other request fails the test through its status. */
async function listing(reply: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: IncomingMessage[] = []
  const server = createServer((request, response) => {
    requests.push(request)
    if (request.method === 'GET' && request.url === '/models') reply(request, response)
    else response.writeHead(500).end('unexpected request')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const origin = `http://127.0.0.1:${address.port}`
  return { origin, requests, baseURL: `${origin}/anthropic` }
}
const json = (body: unknown) => (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function host(origin: string, token: () => string | undefined = () => 'fixture-account-token') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.provide('deepseekAccount', {
    resolveToken: (url: string) => Promise.resolve(new URL(url).origin === origin ? token() : undefined),
  } as DeepSeekAccount)
  return ctx
}

it('keeps discovery and disposal independent across the two credential routes', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const server = await listing(json({ data: [FLASH, PRO] }))
  let token: string | undefined = 'fixture-account-token'
  const ctx = await host(server.origin, () => token)
  const account = ctx.plugin(Account, { baseURL: server.baseURL })
  await account
  const official = ctx.plugin(ApiKey, { models: [{ id: 'api-key-model', name: 'API-key model' }] })
  await official
  expect((await ctx.llm.listModels('deepseek-account')).map(row => [row.id, row.name])).toEqual([
    ['deepseek-flash', 'DeepSeek-V4.1-Flash'], ['deepseek-v4-pro', 'DeepSeek-V4-Pro'],
  ])
  expect((await ctx.llm.listModels('deepseek-official')).map(row => row.id)).toEqual(['api-key-model'])
  expect(ctx.llm.listConfigurableProviders().map(row => [row.provider, row.settingsNs])).toEqual([
    ['deepseek-account', 'llm-deepseek-account'], ['deepseek-official', 'llm-deepseek-api-key'],
  ])
  expect(Account.Config({})).not.toHaveProperty('apiKeyEnv')
  token = undefined
  expect(await ctx.llm.listModels('deepseek-account')).toEqual([])
  token = 'second-account-token'
  expect(await ctx.llm.listModels('deepseek-account')).toHaveLength(2)
  expect(server.requests.map(request => request.headers['x-dsh-auth-token'])).toEqual(['fixture-account-token', 'second-account-token'])
  await account.dispose()
  expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['deepseek-official'])
  await official.dispose()
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
})

it('resolves listed capabilities with this build\'s model knowledge', async () => {
  const server = await listing(json({ data: [FLASH, PRO] }))
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')).resolves.toMatchObject({
    name: 'DeepSeek-V4.1-Flash', context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000,
    systemPromptUpdate: 'in-history', toolUpdate: 'addition-only', inputModalities: ['text', 'image'],
    reasoning: { defaultEffort: ReasoningEffortId('high') },
  })
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-v4-pro')).resolves.not.toHaveProperty('systemPromptUpdate')
  expect(server.requests).toHaveLength(1)
  expect(server.requests[0]?.headers['user-agent']).toMatch(/^deepseek-harness\//)
})

it('falls back to the bundled catalog when the listing fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const server = await listing((_request, response) => { response.writeHead(503).end('down') })
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  expect((await ctx.llm.listModels('deepseek-account')).map(row => row.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  expect(warn).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-account]', expect.stringContaining('using the bundled catalog') as string)
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')).resolves.toMatchObject({ context: { contextWindow: 1_000_000 } })
})

it('hides and refuses listed models this build cannot serve before any inference request', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const server = await listing(json({ data: [
    FLASH,
    { ...PRO, id: 'deepseek-v5' },
    { ...PRO, id: 'deepseek-v5-open', ...requires('0.0.1') },
    { ...PRO, id: 'deepseek-v5-next', ...requires('99.0.0-alpha.1') },
    { id: 'deepseek-v4-pro' },
  ] }))
  const ctx = await host(server.origin)
  await ctx.plugin(Account, { baseURL: server.baseURL })
  expect((await ctx.llm.listModels('deepseek-account')).map(row => row.id)).toEqual(['deepseek-flash', 'deepseek-v5-open'])
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-v5' })).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-v4-pro' })).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-v5-next' }))
    .rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED', message: expect.stringMatching(/requires DeepSeek Harness 99\.0\.0-alpha\.1 or later; current version is /) as string })
  await expect(ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'unlisted-pass-through' })).resolves.toBeDefined()
  expect(server.requests.map(request => request.url)).toEqual(['/models'])
  expect(info).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-account]', expect.stringContaining('loaded 5 model(s), skipped 0 row(s)') as string)
  expect(warn).toHaveBeenCalledExactlyOnceWith('[llm-deepseek-account]', 'model "deepseek-v4-pro" declares no api_capabilities.anthropic_messages')
})

it('applies model overrides and reports stale ones on the provider directory until they resolve', async () => {
  let token = 'first-account'
  const server = await listing((request, response) => {
    const rows = request.headers['x-dsh-auth-token'] === 'first-account' ? [FLASH] : [FLASH, { ...PRO, id: 'deepseek-v5', ...requires('0.0.1') }]
    json({ data: rows })(request, response)
  })
  const ctx = await host(server.origin, () => token)
  await ctx.plugin(Account, { baseURL: server.baseURL, modelOverrides: { 'deepseek-flash': { contextWindow: 524_288 }, 'deepseek-v5': { contextWindow: 9 } } })
  await ctx.llm.listModels('deepseek-account')
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')).resolves.toMatchObject({ context: { contextWindow: 524_288 } })
  expect(ctx.llm.listConfigurableProviders()[0]?.error).toContain('"deepseek-v5"')
  await ctx.llm.listModels('deepseek-account')
  expect(ctx.llm.listConfigurableProviders()[0]?.error).toContain('"deepseek-v5"')
  token = 'second-account'
  await ctx.llm.listModels('deepseek-account')
  expect(ctx.llm.listConfigurableProviders()[0]).not.toHaveProperty('error')
  await expect(ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-v5')).resolves.toMatchObject({ context: { contextWindow: 9 } })
})

it('rejects the retired models setting at load', async () => {
  const ctx = await host('http://127.0.0.1:1')
  await expect(ctx.plugin(Account, { models: [] })).rejects.toThrow(/models is no longer configurable/)
  expect(ctx.llm.listProviders()).toEqual([])
})

it('aborts an in-flight listing request when the plugin is disposed', async () => {
  const held = Promise.withResolvers<IncomingMessage>()
  const server = await listing((request) => { held.resolve(request) })
  const ctx = await host(server.origin)
  const account = ctx.plugin(Account, { baseURL: server.baseURL })
  await account
  const pending = ctx.llm.listModels('deepseek-account')
  const request = await held.promise
  const closed = new Promise(resolve => request.socket.once('close', resolve))
  await account.dispose()
  await closed
  await expect(pending).resolves.toEqual(expect.any(Array))
})
