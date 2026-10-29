/**
 * Whether the Search and Fetch APIs have a credential for a model request, on any route. Both
 * providers read one credential, so every case runs for both operations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as webApiPlugin from '@deepseek-ai/dsh-web-deepseek-api'

type Operation = 'search' | 'fetch'

const OPERATIONS: readonly Operation[] = ['search', 'fetch']

const mounted: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(mounted.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Setup {
  /** web-deepseek-api config. */
  config?: Record<string, unknown>
  /** Launch-environment variables, the credential plane without a credentials service. */
  environment?: Record<string, string>
  /** Credentials service stand-in. */
  credentials?: { describe(ref: string): Promise<{ configured: boolean }> }
  /** Account service stand-in. */
  account?: Pick<DeepSeekAccount, 'resolveToken'>
}

/**
 * Mount the web seam with both APIs selected, as the settings switch selects them.
 * @param setup - plugin config and credential planes.
 * @returns the root context.
 */
async function mount(setup: Setup): Promise<Context> {
  const ctx = new Context()
  mounted.push(ctx)
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: setup.environment ?? {} }]))
  if (setup.credentials !== undefined) ctx.provide('credentials', setup.credentials as never)
  if (setup.account !== undefined) ctx.provide('deepseekAccount', setup.account as DeepSeekAccount)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
  await ctx.plugin(webApiPlugin, setup.config ?? {})
  return ctx
}

/** Ask the seam whether `operation` is ready for a model request on `route`. */
function ready(ctx: Context, operation: Operation, route: string | undefined): Promise<boolean> {
  return operation === 'search' ? ctx.web.searchReady(route) : ctx.web.fetchReady(route)
}

/**
 * Run `operation` for a Session whose latest model request ran on `route`.
 * @param ctx - the mounted context.
 * @param operation - search or fetch.
 * @param route - the provider route of the initiating Session's request.
 * @returns the settled operation.
 */
async function operateOnRoute(ctx: Context, operation: Operation, route: string): Promise<unknown> {
  const session = ctx.sessions.create(SessionId(`web-api-${operation}-${route}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/context', { provider: route, model: 'test-model' })
  return await ctx.agents.withInitiator({ session } as Agent, () => operation === 'search'
    ? ctx.web.search({ query: 'q' })
    : ctx.web.fetch({ url: 'https://example.test/' }))
}

/** Stub both API endpoints with successful responses and record each request's bearer credential. */
function stubApis(): () => (string | null)[] {
  // The providers dispatch to a string endpoint.
  const fetchMock = vi.fn(async (endpoint: string, _init?: RequestInit) => new Response(
    JSON.stringify(endpoint.endsWith('/search') ? { results: [] } : { content: '# Page' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  return () => fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
}

describe.each(OPERATIONS)('%s readiness', (operation) => {
  it('is not ready without any credential', async () => {
    const ctx = await mount({})
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(false)
  })

  it('is ready with the DeepSeek chat key on the DeepSeek routes and outside a model request', async () => {
    const ctx = await mount({ environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(true)
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(true)
    expect(await ready(ctx, operation, undefined)).toBe(true)
  })

  it('is ready with a literal key on a DeepSeek route', async () => {
    const ctx = await mount({ config: { apiKey: 'own-key' } })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(true)
  })

  it.each<[string, Setup, boolean]>([
    ['the DeepSeek key', { environment: { DEEPSEEK_API_KEY: 'chat-key' } }, true],
    ['a literal key', { config: { apiKey: 'own-key' } }, true],
    ['their own key reference', { config: { apiKeyEnv: 'DSH_WEB_API_KEY' }, environment: { DSH_WEB_API_KEY: 'own-key' } }, true],
    ['no key', {}, false],
  ])('answers on another provider\'s route, as on any route, when the APIs have %s', async (_label, setup, expected) => {
    const ctx = await mount(setup)
    expect(await ready(ctx, operation, 'moonshotai')).toBe(expected)
  })

  it('treats an empty environment value as no key', async () => {
    const ctx = await mount({ environment: { DEEPSEEK_API_KEY: '' } })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(false)
  })

  it.each<[string, NonNullable<Setup['credentials']>, boolean]>([
    ['holds the key', { describe: () => Promise.resolve({ configured: true }) }, true],
    ['lacks the key', { describe: () => Promise.resolve({ configured: false }) }, false],
    ['cannot be read', { describe: () => Promise.reject(new Error('store locked')) }, false],
  ])('answers from the credential store when it %s', async (_label, credentials, expected) => {
    const ctx = await mount({ credentials, environment: { DEEPSEEK_API_KEY: 'ignored-env-key' } })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(expected)
  })

  it('is ready on the account route with the account token alone, asking for the API base', async () => {
    const asked: string[] = []
    const ctx = await mount({
      account: { resolveToken: (url: string) => { asked.push(url); return Promise.resolve('account-token') } },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(true)
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(false)
    expect(asked).toEqual(['https://api.deepseek.com/v1/tools'])
  })

  it.each<[string, Pick<DeepSeekAccount, 'resolveToken'>, boolean]>([
    ['releases no token and the chat key is set', { resolveToken: () => Promise.resolve(undefined) }, true],
    ['cannot read its grant', { resolveToken: () => Promise.reject(new Error('grant unreadable')) }, false],
  ])('answers on the account route when the account %s', async (_label, account, expected) => {
    const ctx = await mount({ account, environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(expected)
  })
})

describe.each(OPERATIONS)('%s on any model route', (operation) => {
  it.each(['deepseek-official', 'moonshotai'])('sends the DeepSeek key for a conversation on the %s route', async (route) => {
    const authorization = stubApis()
    const ctx = await mount({ environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    await operateOnRoute(ctx, operation, route)
    expect(authorization()).toEqual(['Bearer chat-key'])
  })
})
