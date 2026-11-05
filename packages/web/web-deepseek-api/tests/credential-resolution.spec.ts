/**
 * Endpoint and credential of the Search and Fetch APIs: each capability's billing chooses its DeepSeek credential, by
 * default following the conversation, unless it has its own base URL or key reference, and readiness answers what the
 * operation would send.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as webApiPlugin from '@deepseek-ai/dsh-web-deepseek-api'
import { provideRoutes, type RouteRow } from './routes.ts'

/** A value the API-key route resolver throws instead of resolving; undefined lets it resolve normally. */
const resolverThrow = vi.hoisted(() => ({ value: undefined as string | undefined }))

vi.mock('@deepseek-ai/dsh-llm-deepseek-api-key', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-llm-deepseek-api-key')>()
  return {
    ...original,
    resolveAdapterOptions: (...args: Parameters<typeof original.resolveAdapterOptions>) => {
      if (resolverThrow.value !== undefined) throw resolverThrow.value
      return original.resolveAdapterOptions(...args)
    },
  }
})

type Operation = 'search' | 'fetch'

const OPERATIONS: readonly Operation[] = ['search', 'fetch']
const OFFICIAL = 'https://api.deepseek.com/v1/tools'
const ROUTE = 'https://route.deepseek.test/v1/tools'
const ACCOUNT = 'https://account.deepseek.test/v1/tools'
const OWN = 'https://own.deepseek.test/api/v1/tools'

const mounted: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  resolverThrow.value = undefined
  await Promise.all(mounted.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Setup {
  /** web-deepseek-api config. */
  config?: Record<string, unknown>
  /** Launch-environment variables. */
  environment?: Record<string, string>
  /** Model routes the provider directory lists. */
  routes?: readonly RouteRow[]
  /** Account service stand-in. */
  account?: Pick<DeepSeekAccount, 'resolveToken'> & Partial<Pick<DeepSeekAccount, 'rejectToken'>>
  /** Credentials service stand-in. */
  credentials?: object
  /** API response status. */
  status?: number
}

/** One dispatched request: endpoint and credential headers. */
interface Sent {
  endpoint: string
  authorization: string | null
  token: string | null
}

/**
 * Mount both APIs with stubbed endpoints.
 * @param setup - config, routes, and credential planes.
 * @returns the context and the requests sent so far.
 */
async function mount(setup: Setup): Promise<{ ctx: Context; sent: () => Sent[] }> {
  const fetchMock = vi.fn(async (endpoint: string, _init?: RequestInit) => new Response(
    JSON.stringify(setup.status === undefined ? endpoint.endsWith('/search') ? { results: [] } : { content: '# Page' } : {}),
    { status: setup.status ?? 200, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  const ctx = new Context()
  mounted.push(ctx)
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: setup.environment ?? {} }]))
  if (setup.account !== undefined) ctx.provide('deepseekAccount', setup.account as DeepSeekAccount)
  if (setup.credentials !== undefined) ctx.provide('credentials', setup.credentials as never)
  if (setup.routes !== undefined) provideRoutes(ctx, setup.routes)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(WebRuntime, { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
  await ctx.plugin(webApiPlugin, setup.config ?? {})
  return {
    ctx,
    sent: () => fetchMock.mock.calls.map(([endpoint, init]) => {
      const headers = new Headers(init?.headers)
      return { endpoint, authorization: headers.get('authorization'), token: headers.get('x-dsh-auth-token') }
    }),
  }
}

let sessions = 0

/**
 * Run one operation, inside a Session whose latest model request used `route` when one is given.
 * @param ctx - the mounted context.
 * @param operation - search or fetch.
 * @param route - provider route of the initiating Session's latest model request; undefined runs outside a Session.
 * @returns the settled operation.
 */
async function operate(ctx: Context, operation: Operation, route?: string): Promise<unknown> {
  const run = () => operation === 'search' ? ctx.web.search({ query: 'q' }) : ctx.web.fetch({ url: 'https://example.test/' })
  if (route === undefined) return await run()
  const session = ctx.sessions.create(SessionId(`web-api-${String(sessions++)}`))
  session.append('turn/start', { turn: 1 })
  session.append('request/context', { provider: route, model: 'test-model' })
  return await ctx.agents.withInitiator({ session } as Agent, run)
}

/** Ask whether one operation is ready for a model request on `route`. */
function ready(ctx: Context, operation: Operation, route: string | undefined): Promise<boolean> {
  return operation === 'search' ? ctx.web.searchReady(route) : ctx.web.fetchReady(route)
}

/** The account service of a signed-in user, recording the URLs it is asked for. */
function signedIn(asked: string[] = []): Pick<DeepSeekAccount, 'resolveToken'> {
  return { resolveToken: async (url: string) => { asked.push(url); return 'account-token' } }
}

const officialRoute = (config: Record<string, unknown> = { baseURL: 'https://route.deepseek.test/anthropic' }): RouteRow =>
  ({ provider: 'deepseek-official', config })
const accountRoute = (config: Record<string, unknown> = { baseURL: 'https://account.deepseek.test/anthropic' }): RouteRow =>
  ({ provider: 'deepseek-account', config })
const bothRoutes = [officialRoute(), accountRoute()]

describe.each(OPERATIONS)('%s in a conversation on the DeepSeek account route', (operation) => {
  it('sends only the account token to the account route origin, asking for that endpoint', async () => {
    const asked: string[] = []
    const { ctx, sent } = await mount({ routes: bothRoutes, account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(true)
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `${ACCOUNT}/${operation}`, authorization: null, token: 'account-token' }])
    expect(asked).toEqual([`${ACCOUNT}/${operation}`, `${ACCOUNT}/${operation}`])
  })

  it('derives the account endpoint from DEEPSEEK_BASE_URL', async () => {
    const { ctx, sent } = await mount({
      routes: [accountRoute({})], account: signedIn(), environment: { DEEPSEEK_BASE_URL: 'https://internal.deepseek.test/anthropic' },
    })
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `https://internal.deepseek.test/v1/tools/${operation}`, authorization: null, token: 'account-token' }])
  })

  it('invalidates the token the API rejects with 401', async () => {
    const rejectToken = vi.fn(async () => {})
    const { ctx } = await mount({ routes: bothRoutes, account: { ...signedIn(), rejectToken }, status: 401 })
    const failure = operate(ctx, operation, 'deepseek-account')
    await expect(failure).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(failure).rejects.toThrow('HTTP 401')
    expect(rejectToken).toHaveBeenCalledExactlyOnceWith('account-token')
  })

  it.each<[string, Setup['account']]>([
    ['the user is not signed in', { resolveToken: async () => undefined }],
    ['the account releases an empty token', { resolveToken: async () => '' }],
    ['no account service is mounted', undefined],
  ])('sends the API key to the API-key endpoint when %s', async (_label, account) => {
    const { ctx, sent } = await mount({
      routes: bothRoutes, ...account === undefined ? {} : { account }, environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(true)
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `${ROUTE}/${operation}`, authorization: 'Bearer chat-key', token: null }])
  })

  it('is not ready and names both recoveries when neither a sign-in nor the key is available', async () => {
    const subject = operation === 'search' ? 'Search' : 'Fetch'
    const { ctx, sent } = await mount({ routes: bothRoutes, account: { resolveToken: async () => undefined } })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(false)
    await expect(operate(ctx, operation, 'deepseek-account')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      message: `DeepSeek ${subject} API uses the DeepSeek account sign-in of this conversation, then the DeepSeek API key,`
        + ' and neither is available: no signed-in DeepSeek account is available, and no key is configured for'
        + ' "DEEPSEEK_API_KEY". Guide the user to sign in to DeepSeek, or to add the DeepSeek API key on the Models page or'
        + ' export "DEEPSEEK_API_KEY" in the launching environment.',
    })
    expect(sent()).toEqual([])
  })

  it('sends the API key without asking the account when the account route is not mounted', async () => {
    const asked: string[] = []
    const { ctx, sent } = await mount({ routes: [officialRoute()], account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(true)
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `${ROUTE}/${operation}`, authorization: 'Bearer chat-key', token: null }])
    expect(asked).toEqual([])
  })

  it('is not ready and fails without a token or key when the mounted account route settings do not resolve', async () => {
    const subject = operation === 'search' ? 'Search' : 'Fetch'
    const asked: string[] = []
    const { ctx, sent } = await mount({
      routes: [officialRoute(), accountRoute({ thinking: 'disabled', reasoningEffort: 'high' })],
      account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(false)
    await expect(operate(ctx, operation, 'deepseek-account')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_MISCONFIGURED',
      message: `DeepSeek ${subject} API sends the DeepSeek account sign-in to the origin of the DeepSeek account model`
        + ' provider, and that provider\'s settings do not resolve: llm-deepseek: only reasoningEffort "off" can be configured'
        + ` when thinking is disabled. ${subject} did not send the request. Guide the user to correct that provider's settings`
        + ' on the Models page or in the deployment configuration, or to set'
        + ` web-deepseek-api.${operation}BaseURL and web-deepseek-api.${operation}ApiKeyEnv so ${subject} uses its own endpoint.`,
    })
    expect(sent()).toEqual([])
    expect(asked).toEqual([])
  })

  it('sends the account token while the mounted API-key route settings do not resolve', async () => {
    const { ctx, sent } = await mount({
      routes: [officialRoute({ thinking: 'disabled', reasoningEffort: 'high' }), accountRoute()],
      account: signedIn(), environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(true)
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `${ACCOUNT}/${operation}`, authorization: null, token: 'account-token' }])
  })

  it('fails instead of sending DEEPSEEK_API_KEY when there is no sign-in and the API-key route settings do not resolve', async () => {
    const { ctx, sent } = await mount({
      routes: [officialRoute({ thinking: 'disabled', reasoningEffort: 'high' }), accountRoute()],
      account: { resolveToken: async () => undefined }, environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(false)
    await expect(operate(ctx, operation, 'deepseek-account')).rejects.toMatchObject({ code: 'WEB_PROVIDER_MISCONFIGURED' })
    expect(sent()).toEqual([])
  })

  it('is not ready and fails without trying the key when the account grant cannot be read', async () => {
    const { ctx, sent } = await mount({
      routes: bothRoutes, account: { resolveToken: () => Promise.reject(new Error('grant unreadable')) },
      environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(false)
    await expect(operate(ctx, operation, 'deepseek-account')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR', message: 'DeepSeek web credential resolution failed: Error: grant unreadable',
    })
    expect(sent()).toEqual([])
  })
})

describe.each(OPERATIONS)('%s in any other conversation', (operation) => {
  const others = ['deepseek-official', 'moonshotai', undefined] as const

  it.each(others)('sends the key of the DeepSeek API-key route to its origin for route %s, never the account token', async (route) => {
    const asked: string[] = []
    const { ctx, sent } = await mount({ routes: bothRoutes, account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(ctx, operation, route)).toBe(true)
    await operate(ctx, operation, route)
    expect(sent()).toEqual([{ endpoint: `${ROUTE}/${operation}`, authorization: 'Bearer chat-key', token: null }])
    expect(asked).toEqual([])
  })

  it('is not ready on the DeepSeek API-key route with only a sign-in, and names the account billing', async () => {
    const subject = operation === 'search' ? 'Search' : 'Fetch'
    const asked: string[] = []
    const { ctx, sent } = await mount({ routes: bothRoutes, account: signedIn(asked) })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(false)
    await expect(operate(ctx, operation, 'deepseek-official')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      message: `DeepSeek ${subject} API uses the DeepSeek API key, as this conversation's model provider does, and no key is`
        + ' configured for "DEEPSEEK_API_KEY". Guide the user to add the DeepSeek API key on the Models page or export'
        + ' "DEEPSEEK_API_KEY" in the launching environment, or to sign in to DeepSeek and set'
        + ` web-deepseek-api.${operation}Billing to "account" on the Web search and fetch settings page.`,
    })
    expect(sent()).toEqual([])
    expect(asked).toEqual([])
  })

  it.each(['moonshotai', undefined])('sends the account token to the account route origin without a key for route %s', async (route) => {
    const asked: string[] = []
    const { ctx, sent } = await mount({ routes: bothRoutes, account: signedIn(asked) })
    expect(await ready(ctx, operation, route)).toBe(true)
    await operate(ctx, operation, route)
    expect(sent()).toEqual([{ endpoint: `${ACCOUNT}/${operation}`, authorization: null, token: 'account-token' }])
    expect(asked).toEqual([`${ACCOUNT}/${operation}`, `${ACCOUNT}/${operation}`])
  })

  it('sends the account token to the default account origin without the account route', async () => {
    const { ctx, sent } = await mount({
      routes: [officialRoute()], account: signedIn(), environment: { DEEPSEEK_BASE_URL: 'https://internal.deepseek.test/anthropic' },
    })
    expect(await ready(ctx, operation, 'moonshotai')).toBe(true)
    await operate(ctx, operation, 'moonshotai')
    expect(sent()).toEqual([{ endpoint: `https://internal.deepseek.test/v1/tools/${operation}`, authorization: null, token: 'account-token' }])
  })

  it('sends the account token to the official origin without any model route', async () => {
    const { ctx, sent } = await mount({ account: signedIn() })
    await operate(ctx, operation)
    expect(sent()).toEqual([{ endpoint: `${OFFICIAL}/${operation}`, authorization: null, token: 'account-token' }])
  })

  it('is not ready and names both recoveries without a key and a sign-in', async () => {
    const subject = operation === 'search' ? 'Search' : 'Fetch'
    for (const account of [{ resolveToken: async () => undefined }, undefined]) {
      const { ctx, sent } = await mount({ routes: bothRoutes, ...account === undefined ? {} : { account } })
      expect(await ready(ctx, operation, 'moonshotai')).toBe(false)
      await expect(operate(ctx, operation, 'moonshotai')).rejects.toMatchObject({
        code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
        message: `DeepSeek ${subject} API uses the DeepSeek API key, then the DeepSeek account sign-in, and neither is available:`
          + ' no key is configured for "DEEPSEEK_API_KEY", and no signed-in DeepSeek account is available. Guide the user to'
          + ' add the DeepSeek API key on the Models page or export "DEEPSEEK_API_KEY" in the launching environment, or to'
          + ' sign in to DeepSeek.',
      })
      expect(sent()).toEqual([])
    }
  })

  it('sends the key while the mounted account route settings do not resolve, and is misconfigured without the key', async () => {
    const subject = operation === 'search' ? 'Search' : 'Fetch'
    const routes = [officialRoute(), accountRoute({ thinking: 'disabled', reasoningEffort: 'high' })]
    const withKey = await mount({ routes, account: signedIn(), environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(withKey.ctx, operation, 'moonshotai')).toBe(true)
    await operate(withKey.ctx, operation, 'moonshotai')
    expect(withKey.sent()).toEqual([{ endpoint: `${ROUTE}/${operation}`, authorization: 'Bearer chat-key', token: null }])
    const asked: string[] = []
    const withoutKey = await mount({ routes, account: signedIn(asked) })
    expect(await ready(withoutKey.ctx, operation, 'moonshotai')).toBe(false)
    await expect(operate(withoutKey.ctx, operation, 'moonshotai')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_MISCONFIGURED',
      message: `DeepSeek ${subject} API sends the DeepSeek account sign-in to the origin of the DeepSeek account model`
        + ' provider, and that provider\'s settings do not resolve: llm-deepseek: only reasoningEffort "off" can be configured'
        + ` when thinking is disabled. ${subject} did not send the request. Guide the user to correct that provider's settings`
        + ' on the Models page or in the deployment configuration, or to set'
        + ` web-deepseek-api.${operation}BaseURL and web-deepseek-api.${operation}ApiKeyEnv so ${subject} uses its own endpoint.`,
    })
    expect(withoutKey.sent()).toEqual([])
    expect(asked).toEqual([])
  })

  it('fails without asking the account when the credential store cannot be read', async () => {
    const asked: string[] = []
    const { ctx, sent } = await mount({
      routes: bothRoutes, account: signedIn(asked),
      credentials: { describe: () => Promise.reject(new Error('store locked')), resolve: () => Promise.reject(new Error('store locked')) },
    })
    expect(await ready(ctx, operation, 'moonshotai')).toBe(false)
    await expect(operate(ctx, operation, 'moonshotai')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR', message: 'DeepSeek web credential resolution failed: Error: store locked',
    })
    expect(sent()).toEqual([])
    expect(asked).toEqual([])
  })

  it('sends the key under the route apiKeyEnv to the origin DEEPSEEK_BASE_URL names, from the credential store', async () => {
    const { ctx, sent } = await mount({
      routes: [officialRoute({ apiKeyEnv: 'TEAM_KEY' })],
      credentials: { describe: async (ref: string) => ({ configured: ref === 'TEAM_KEY' }), resolve: async (ref: string) => ref === 'TEAM_KEY' ? { value: 'team-key' } : undefined },
      environment: { DEEPSEEK_API_KEY: 'chat-key', DEEPSEEK_BASE_URL: 'https://internal.deepseek.test/anthropic' },
    })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(true)
    await operate(ctx, operation, 'deepseek-official')
    expect(sent()).toEqual([{ endpoint: `https://internal.deepseek.test/v1/tools/${operation}`, authorization: 'Bearer team-key', token: null }])
  })

  it.each<[string, readonly RouteRow[] | undefined]>([
    ['no model provider directory is mounted', undefined],
    ['the route entry is not active', [{ provider: 'deepseek-official', config: { apiKeyEnv: 'TEAM_KEY' }, state: FiberState.DISPOSED }]],
    ['another package registers the route', [{ provider: 'deepseek-official', config: { apiKeyEnv: 'TEAM_KEY' }, name: '@example/other-llm' }]],
    ['the route settings are nested', [{ provider: 'deepseek-official', config: { apiKeyEnv: 'TEAM_KEY' }, settingsPath: ['routes', 'official'] }]],
  ])('sends DEEPSEEK_API_KEY to the official base when %s', async (_label, routes) => {
    const { ctx, sent } = await mount({
      ...routes === undefined ? {} : { routes },
      environment: { DEEPSEEK_API_KEY: 'chat-key', TEAM_KEY: 'team-key', DEEPSEEK_BASE_URL: 'https://internal.deepseek.test/anthropic' },
    })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(true)
    await operate(ctx, operation, 'deepseek-official')
    expect(sent()).toEqual([{ endpoint: `${OFFICIAL}/${operation}`, authorization: 'Bearer chat-key', token: null }])
  })

  it.each<[string, Record<string, unknown>, string]>([
    [
      'thinking is disabled with a reasoning effort', { thinking: 'disabled', reasoningEffort: 'high' },
      'llm-deepseek: only reasoningEffort "off" can be configured when thinking is disabled',
    ],
    [
      'the base URL carries credentials', { baseURL: 'https://user:secret@internal.deepseek.test/anthropic' },
      'llm-deepseek: Messages baseURL must be an HTTP(S) root without credentials, query, or fragment',
    ],
  ])('is not ready and fails without sending when the mounted route settings do not resolve because %s', async (_label, config, reason) => {
    const subject = operation === 'search' ? 'Search' : 'Fetch'
    const { ctx, sent } = await mount({
      routes: [officialRoute({ apiKeyEnv: 'TEAM_KEY', ...config })],
      environment: { DEEPSEEK_API_KEY: 'chat-key', TEAM_KEY: 'team-key' },
    })
    for (const route of ['deepseek-official', 'moonshotai', undefined]) {
      expect(await ready(ctx, operation, route)).toBe(false)
      await expect(operate(ctx, operation, route)).rejects.toMatchObject({
        code: 'WEB_PROVIDER_MISCONFIGURED',
        message: `DeepSeek ${subject} API sends that provider's API key to the origin of the DeepSeek API-key model provider,`
          + ` and that provider's settings do not resolve: ${reason}. ${subject} did not send the request. Guide the user to`
          + ' correct that provider\'s settings on the Models page or in the deployment configuration, or to set'
          + ` web-deepseek-api.${operation}BaseURL and web-deepseek-api.${operation}ApiKeyEnv so ${subject} uses its own endpoint.`,
      })
    }
    expect(sent()).toEqual([])
  })

  it('uses its own endpoint settings while the mounted route settings do not resolve', async () => {
    const { ctx, sent } = await mount({
      config: { [`${operation}BaseURL`]: OWN },
      routes: [officialRoute({ thinking: 'disabled', reasoningEffort: 'high' })], environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(true)
    await operate(ctx, operation, 'deepseek-official')
    expect(sent()).toEqual([{ endpoint: `${OWN}/${operation}`, authorization: 'Bearer chat-key', token: null }])
  })

  it('is not ready when the credential store cannot be read', async () => {
    const { ctx } = await mount({ routes: [officialRoute()], credentials: { describe: () => Promise.reject(new Error('store locked')) } })
    expect(await ready(ctx, operation, 'deepseek-official')).toBe(false)
  })

  it('follows a route change at the next operation', async () => {
    const { ctx, sent } = await mount({ environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    await operate(ctx, operation)
    provideRoutes(ctx, [officialRoute({ baseURL: 'https://next.deepseek.test/anthropic' })])
    await operate(ctx, operation)
    expect(sent().map(row => row.endpoint)).toEqual([`${OFFICIAL}/${operation}`, `https://next.deepseek.test/v1/tools/${operation}`])
  })

  it('names the model provider base URL and the own fields in endpoint guidance', async () => {
    const subject = operation === 'search' ? 'Search' : 'Fetch'
    const { ctx } = await mount({ routes: [officialRoute()], environment: { DEEPSEEK_API_KEY: 'chat-key' }, status: 404 })
    await expect(operate(ctx, operation)).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'DeepSeek API error (HTTP 404)\n\n'
        + `The web request used endpoint "${ROUTE}/${operation}". ${subject} derives this endpoint from the base URL of the`
        + ' DeepSeek model provider whose credential it uses. If that endpoint is not intended, guide the user to check that'
        + ` provider's base URL on the Models page, or to set web-deepseek-api.${operation}BaseURL to a trusted DeepSeek`
        + ` endpoint and web-deepseek-api.${operation}ApiKeyEnv to the credential reference of its API key. Only the user`
        + ' should choose or change the endpoint.',
    })
  })
})

const ROUTES = ['deepseek-account', 'deepseek-official', 'moonshotai', undefined] as const

describe.each(OPERATIONS)('%s billed to the signed-in DeepSeek account', (operation) => {
  const subject = operation === 'search' ? 'Search' : 'Fetch'
  const config = { [`${operation}Billing`]: 'account' }

  it.each(ROUTES)('sends only the account token to the account route origin for route %s, despite a key', async (route) => {
    const asked: string[] = []
    const { ctx, sent } = await mount({ config, routes: bothRoutes, account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(ctx, operation, route)).toBe(true)
    await operate(ctx, operation, route)
    expect(sent()).toEqual([{ endpoint: `${ACCOUNT}/${operation}`, authorization: null, token: 'account-token' }])
    expect(asked).toEqual([`${ACCOUNT}/${operation}`, `${ACCOUNT}/${operation}`])
  })

  it('sends the token to the default account origin without the account route', async () => {
    const { ctx, sent } = await mount({
      config, routes: [officialRoute()], account: signedIn(),
      environment: { DEEPSEEK_API_KEY: 'chat-key', DEEPSEEK_BASE_URL: 'https://internal.deepseek.test/anthropic' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(true)
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `https://internal.deepseek.test/v1/tools/${operation}`, authorization: null, token: 'account-token' }])
  })

  it.each<[string, Setup['account']]>([
    ['the user is not signed in', { resolveToken: async () => undefined }],
    ['the account releases an empty token', { resolveToken: async () => '' }],
    ['no account service is mounted', undefined],
  ])('is not ready and never sends the key when %s', async (_label, account) => {
    const { ctx, sent } = await mount({
      config, routes: bothRoutes, ...account === undefined ? {} : { account }, environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    for (const route of ROUTES) {
      expect(await ready(ctx, operation, route)).toBe(false)
      await expect(operate(ctx, operation, route)).rejects.toMatchObject({
        code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
        message: `DeepSeek ${subject} API bills only the signed-in DeepSeek account, and no signed-in DeepSeek account is`
          + ` available. ${subject} did not send the request. Guide the user to sign in to DeepSeek, or to set`
          + ` web-deepseek-api.${operation}Billing to "api-key" or "auto" on the Web search and fetch settings page.`,
      })
    }
    expect(sent()).toEqual([])
  })

  it('is not ready and fails without a token when the mounted account route settings do not resolve', async () => {
    const asked: string[] = []
    const { ctx, sent } = await mount({
      config, routes: [officialRoute(), accountRoute({ thinking: 'disabled', reasoningEffort: 'high' })],
      account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'moonshotai')).toBe(false)
    const failure = operate(ctx, operation, 'moonshotai')
    await expect(failure).rejects.toMatchObject({ code: 'WEB_PROVIDER_MISCONFIGURED' })
    await expect(failure).rejects.toThrow('DeepSeek account model provider, and that provider\'s settings do not resolve')
    expect(sent()).toEqual([])
    expect(asked).toEqual([])
  })

  it('is not ready and fails without a token when the default account settings do not resolve', async () => {
    const { ctx, sent } = await mount({
      config, account: signedIn(), environment: { DEEPSEEK_BASE_URL: 'https://user:secret@internal.deepseek.test/anthropic' },
    })
    expect(await ready(ctx, operation, undefined)).toBe(false)
    await expect(operate(ctx, operation)).rejects.toMatchObject({ code: 'WEB_PROVIDER_MISCONFIGURED' })
    expect(sent()).toEqual([])
  })

  it('is not ready and fails when the account grant cannot be read', async () => {
    const { ctx, sent } = await mount({
      config, routes: bothRoutes, account: { resolveToken: () => Promise.reject(new Error('grant unreadable')) },
      environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'moonshotai')).toBe(false)
    await expect(operate(ctx, operation, 'moonshotai')).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(sent()).toEqual([])
  })

  it('invalidates the token the API rejects with 401', async () => {
    const rejectToken = vi.fn(async () => {})
    const { ctx } = await mount({ config, routes: bothRoutes, account: { ...signedIn(), rejectToken }, status: 401 })
    await expect(operate(ctx, operation, 'moonshotai')).rejects.toThrow('HTTP 401')
    expect(rejectToken).toHaveBeenCalledExactlyOnceWith('account-token')
  })
})

describe.each(OPERATIONS)('%s billed to the DeepSeek API key', (operation) => {
  const subject = operation === 'search' ? 'Search' : 'Fetch'
  const config = { [`${operation}Billing`]: 'api-key' }

  it.each(ROUTES)('sends only the route key to the route origin for route %s, despite a sign-in', async (route) => {
    const asked: string[] = []
    const { ctx, sent } = await mount({ config, routes: bothRoutes, account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect(await ready(ctx, operation, route)).toBe(true)
    await operate(ctx, operation, route)
    expect(sent()).toEqual([{ endpoint: `${ROUTE}/${operation}`, authorization: 'Bearer chat-key', token: null }])
    expect(asked).toEqual([])
  })

  it('sends DEEPSEEK_API_KEY to the official base without the API-key route', async () => {
    const { ctx, sent } = await mount({ config, routes: [accountRoute()], account: signedIn(), environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `${OFFICIAL}/${operation}`, authorization: 'Bearer chat-key', token: null }])
  })

  it('is not ready and never sends the token without a key', async () => {
    const asked: string[] = []
    const { ctx, sent } = await mount({ config, routes: bothRoutes, account: signedIn(asked) })
    for (const route of ROUTES) {
      expect(await ready(ctx, operation, route)).toBe(false)
      await expect(operate(ctx, operation, route)).rejects.toMatchObject({
        code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
        message: `DeepSeek ${subject} API bills only the DeepSeek API key, and no key is configured for "DEEPSEEK_API_KEY".`
          + ' Guide the user to add the DeepSeek API key on the Models page or export "DEEPSEEK_API_KEY" in the launching'
          + ` environment, or to set web-deepseek-api.${operation}Billing to "account" or "auto" on the Web search and fetch`
          + ' settings page.',
      })
    }
    expect(sent()).toEqual([])
    expect(asked).toEqual([])
  })

  it('is not ready and fails without sending when the mounted API-key route settings do not resolve', async () => {
    const { ctx, sent } = await mount({
      config, routes: [officialRoute({ thinking: 'disabled', reasoningEffort: 'high' }), accountRoute()],
      account: signedIn(), environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(false)
    const failure = operate(ctx, operation, 'deepseek-account')
    await expect(failure).rejects.toMatchObject({ code: 'WEB_PROVIDER_MISCONFIGURED' })
    await expect(failure).rejects.toThrow('DeepSeek API-key model provider, and that provider\'s settings do not resolve')
    expect(sent()).toEqual([])
  })
})

describe.each(OPERATIONS)('%s billing under its own endpoint settings', (operation) => {
  it.each(['account', 'api-key'])('ignores %s billing and sends the own key to the own base', async (billing) => {
    const asked: string[] = []
    const { ctx, sent } = await mount({
      config: { [`${operation}Billing`]: billing, [`${operation}BaseURL`]: OWN }, routes: bothRoutes, account: signedIn(asked),
      environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    for (const route of ROUTES) {
      expect(await ready(ctx, operation, route)).toBe(true)
      await operate(ctx, operation, route)
    }
    expect(sent()).toEqual(ROUTES.map(() => ({ endpoint: `${OWN}/${operation}`, authorization: 'Bearer chat-key', token: null })))
    expect(asked).toEqual([])
  })
})

describe.each(OPERATIONS)('%s with its own endpoint settings', (operation) => {
  const subject = operation === 'search' ? 'Search' : 'Fetch'
  const baseURL = `${operation}BaseURL`, apiKeyEnv = `${operation}ApiKeyEnv`

  it.each<[string, Record<string, unknown>, Sent]>([
    ['only a base URL', { [baseURL]: OWN }, { endpoint: `${OWN}/${operation}`, authorization: 'Bearer chat-key', token: null }],
    ['only a key reference', { [apiKeyEnv]: 'OWN_KEY' }, { endpoint: `${OFFICIAL}/${operation}`, authorization: 'Bearer own-key', token: null }],
    ['both', { [baseURL]: OWN, [apiKeyEnv]: 'OWN_KEY' }, { endpoint: `${OWN}/${operation}`, authorization: 'Bearer own-key', token: null }],
  ])('uses %s on every conversation route and never the account token', async (_label, config, expected) => {
    const asked: string[] = []
    const { ctx, sent } = await mount({
      config, routes: bothRoutes, account: signedIn(asked), environment: { DEEPSEEK_API_KEY: 'chat-key', OWN_KEY: 'own-key' },
    })
    for (const route of ['deepseek-account', 'deepseek-official', 'moonshotai']) {
      expect(await ready(ctx, operation, route)).toBe(true)
      await operate(ctx, operation, route)
    }
    expect(sent()).toEqual([expected, expected, expected])
    expect(asked).toEqual([])
  })

  it('is not ready without its key, despite a sign-in and the route key', async () => {
    const { ctx, sent } = await mount({
      config: { [apiKeyEnv]: 'OWN_KEY' }, routes: bothRoutes, account: signedIn(), environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    expect(await ready(ctx, operation, 'deepseek-account')).toBe(false)
    await expect(operate(ctx, operation, 'deepseek-account')).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
      message: `DeepSeek ${subject} API sends the API key under "OWN_KEY" to its own endpoint, and no key is configured for`
        + ' "OWN_KEY". Guide the user to export "OWN_KEY" in the launching environment, or to correct'
        + ` web-deepseek-api.${operation}ApiKeyEnv.`,
    })
    expect(sent()).toEqual([])
  })

  it('treats empty values as unset and follows the conversation', async () => {
    const { ctx, sent } = await mount({
      config: { [baseURL]: '', [apiKeyEnv]: '' }, routes: bothRoutes, account: signedIn(), environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    await operate(ctx, operation, 'deepseek-account')
    expect(sent()).toEqual([{ endpoint: `${ACCOUNT}/${operation}`, authorization: null, token: 'account-token' }])
  })

  it('reports an unparseable base URL as an unavailable provider', async () => {
    const { ctx, sent } = await mount({ config: { [baseURL]: 'not a url' }, environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    await expect(operate(ctx, operation)).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    expect(sent()).toEqual([])
  })
})

describe('independent capabilities', () => {
  it('resolves Search from its own settings while Fetch follows the conversation', async () => {
    const { ctx, sent } = await mount({
      config: { searchBaseURL: OWN }, routes: bothRoutes, account: signedIn(), environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    await operate(ctx, 'search', 'deepseek-account')
    await operate(ctx, 'fetch', 'deepseek-account')
    expect(sent()).toEqual([
      { endpoint: `${OWN}/search`, authorization: 'Bearer chat-key', token: null },
      { endpoint: `${ACCOUNT}/fetch`, authorization: null, token: 'account-token' },
    ])
  })

  it('bills Search to the account and Fetch to the API key from their own settings', async () => {
    const { ctx, sent } = await mount({
      config: { searchBilling: 'account', fetchBilling: 'api-key' }, routes: bothRoutes, account: signedIn(),
      environment: { DEEPSEEK_API_KEY: 'chat-key' },
    })
    await operate(ctx, 'search', 'moonshotai')
    await operate(ctx, 'fetch', 'moonshotai')
    expect(sent()).toEqual([
      { endpoint: `${ACCOUNT}/search`, authorization: null, token: 'account-token' },
      { endpoint: `${ROUTE}/fetch`, authorization: 'Bearer chat-key', token: null },
    ])
  })

  it('reports one capability not ready while the other is ready', async () => {
    const { ctx } = await mount({ config: { fetchApiKeyEnv: 'UNSET_KEY' }, routes: [officialRoute()], environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    expect([await ready(ctx, 'search', undefined), await ready(ctx, 'fetch', undefined)]).toEqual([true, false])
  })
})

describe('route resolver failures', () => {
  it('reports a thrown non-Error value as its string', async () => {
    const { ctx, sent } = await mount({ routes: [officialRoute()], environment: { DEEPSEEK_API_KEY: 'chat-key' } })
    resolverThrow.value = 'route resolver unavailable'
    const failure = operate(ctx, 'search', 'deepseek-official')
    await expect(failure).rejects.toMatchObject({ code: 'WEB_PROVIDER_MISCONFIGURED' })
    await expect(failure).rejects.toThrow('that provider\'s settings do not resolve: route resolver unavailable. Search did not send')
    expect(sent()).toEqual([])
  })
})

describe('billing settings', () => {
  it('defaults both capabilities to automatic billing and rejects an unknown billing', () => {
    const config = webApiPlugin.Config({})
    expect([config.searchBilling.get(), config.fetchBilling.get()]).toEqual(['auto', 'auto'])
    // @ts-expect-error A stored settings file can carry a value outside the billing union.
    expect(() => webApiPlugin.Config({ searchBilling: 'session' })).toThrow()
  })
})

describe('stored settings', () => {
  const removed = {
    baseURL: 'https://legacy.deepseek.test/v1/tools', apiKeyEnv: 'LEGACY_KEY', apiKey: 'legacy-key',
  }

  it('loads stored removed fields without error and leaves both capabilities unset', () => {
    const config = webApiPlugin.Config(removed)
    expect([config.searchBaseURL.get(), config.searchApiKeyEnv.get(), config.fetchBaseURL.get(), config.fetchApiKeyEnv.get()])
      .toEqual([undefined, undefined, undefined, undefined])
  })

  it.each(OPERATIONS)('ignores removed fields when a %s runs', async (operation) => {
    const { ctx, sent } = await mount({ config: removed, environment: { DEEPSEEK_API_KEY: 'chat-key', LEGACY_KEY: 'legacy-env-key' } })
    await operate(ctx, operation)
    expect(sent()).toEqual([{ endpoint: `${OFFICIAL}/${operation}`, authorization: 'Bearer chat-key', token: null }])
  })
})

describe('provider registration', () => {
  it('lists both APIs with their descriptions for the provider menus', async () => {
    const { ctx } = await mount({})
    const { search, fetch } = ctx.web.listProviders()
    expect(search.map(({ id }) => id)).toEqual(['deepseek-search-api'])
    expect(fetch.map(({ id }) => id)).toEqual(['deepseek-fetch-api'])
    expect(search[0]?.description).toMatchObject({
      en: 'Incurs charges, paid by the account or API key chosen under Billing.',
      zh: '会产生费用，由「计费方式」选定的账号或 API Key 支付。',
    })
    expect(fetch[0]?.description).toMatchObject({
      en: "Can't reach intranet or local addresses. Incurs charges, paid by the account or API key chosen under Billing.",
      zh: '无法访问内网和本机。会产生费用，由「计费方式」选定的账号或 API Key 支付。',
    })
  })
})
