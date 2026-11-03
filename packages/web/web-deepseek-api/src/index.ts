/**
 * Register the DeepSeek Search and Fetch APIs in `ctx.web` as `deepseek-search-api`
 * and `deepseek-fetch-api`. Each operation is one direct API request without an
 * auxiliary model request. `web.searchProvider` and `web.fetchProvider` select them. Each capability follows the
 * DeepSeek credential of the conversation: a Session whose latest model request used the `deepseek-account` route sends
 * the account token to that route's origin, and every other operation sends the API key of the DeepSeek API-key route
 * to that route's origin, or `DEEPSEEK_API_KEY` to the official base without that route. An operation that needs a
 * mounted route whose settings do not resolve fails instead of changing its endpoint or credential. A capability with
 * its own `*BaseURL` or `*ApiKeyEnv` uses only that endpoint and key instead
 * ([rationale](../../../../.agents/notes/implemented/architecture/2026-10-29-web-provider-selection.md#credential-resolution)).
 * Both providers report themselves not ready when their next operation would have no credential.
 * @module @deepseek-ai/dsh-web-deepseek-api
 */
import { FiberState, type Context, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-llm'
import {
  deepSeekApiKeyConfigured, rejectDeepSeekAccountToken, resolveDeepSeekAccountToken, resolveDeepSeekApiKey,
} from '@deepseek-ai/dsh-llm-deepseek'
import {
  plainAccountOptions, resolveAccountOptions, type Config as AccountRouteConfig,
} from '@deepseek-ai/dsh-llm-deepseek-account'
import {
  plainOptions as plainOfficialOptions, resolveAdapterOptions as resolveOfficialOptions, type Config as OfficialRouteConfig,
} from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { DeepSeekFetchApiProvider } from './fetch.ts'
import {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_REQUESTS_PER_SECOND, DEEPSEEK_WEB_API_BASE_URL, DeepSeekSearchApiProvider,
} from './search.ts'
import type { DeepSeekWebAuth, DeepSeekWebGuidance } from './transport.ts'

export { DEEPSEEK_FETCH_API_PROVIDER_ID, DeepSeekFetchApiProvider } from './fetch.ts'
export type { DeepSeekFetchApiOptions } from './fetch.ts'
export {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_API_PROVIDER_ID, DEEPSEEK_SEARCH_REQUESTS_PER_SECOND, DEEPSEEK_WEB_API_BASE_URL,
  DeepSeekSearchApiProvider, mapSearchResponse,
} from './search.ts'
export type { DeepSeekSearchApiOptions } from './search.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-deepseek-api'

/** The web seam both providers register into. */
export const inject = ['web']

/**
 * Settings read by the next search or fetch without re-registering either provider. A non-empty `*BaseURL` or
 * `*ApiKeyEnv` gives that capability its own endpoint and key; with neither, it follows the conversation's DeepSeek
 * credential. Stored fields of earlier settings (`baseURL`, `apiKeyEnv`, `apiKey`) are not schema fields: they load
 * without error and have no effect.
 */
export interface Config {
  /** Search API results per search, from 1 through 50; a smaller request bound wins. Defaults to 10. */
  count: Volatile<number>
  /**
   * Most Search requests this plugin instance sends in any one-second window; later searches wait,
   * and the wait counts against the caller's timeout. Other processes and clients on the same account
   * share the account limit without coordination. Defaults to 5.
   */
  searchRequestsPerSecond: Volatile<number>
  /** Send the triggering user question, bounded to 128 characters, as `ori_question`. Defaults to true. */
  sendOriginalQuestion: Volatile<boolean>
  /**
   * Own Search API base including its path prefix; `/search` is appended. With only {@link searchApiKeyEnv} set, the
   * official base applies.
   */
  searchBaseURL: Volatile<string | undefined>
  /** Own Search API credential reference. With only {@link searchBaseURL} set, `DEEPSEEK_API_KEY` applies. */
  searchApiKeyEnv: Volatile<string | undefined>
  /**
   * Own Fetch API base including its path prefix; `/fetch` is appended. With only {@link fetchApiKeyEnv} set, the
   * official base applies.
   */
  fetchBaseURL: Volatile<string | undefined>
  /** Own Fetch API credential reference. With only {@link fetchBaseURL} set, `DEEPSEEK_API_KEY` applies. */
  fetchApiKeyEnv: Volatile<string | undefined>
}

export const Config = z.object({
  count: z.number().step(1).min(1).max(50).default(DEEPSEEK_DEFAULT_COUNT).volatile(),
  searchRequestsPerSecond: z.number().step(1).min(1).default(DEEPSEEK_SEARCH_REQUESTS_PER_SECOND).volatile(),
  sendOriginalQuestion: z.boolean().default(true).volatile(),
  searchBaseURL: z.string().volatile(),
  searchApiKeyEnv: z.string().role('credential-ref').volatile(),
  fetchBaseURL: z.string().volatile(),
  fetchApiKeyEnv: z.string().role('credential-ref').volatile(),
})

/** A capability that resolves its endpoint and credential independently of the other. */
type Capability = 'search' | 'fetch'

/** Endpoint and credential resolved for one operation or readiness check of one capability. */
type Plan = { capability: Capability } & (
  /** The capability's own endpoint and key; never the account token. */
  | { kind: 'custom'; baseURL: string; key: CredentialRef }
  /**
   * The conversation's DeepSeek credential: the account token on {@link account} when one is released, otherwise the
   * key. {@link invalid} names a mounted route whose settings do not resolve; the operation fails when it would use it.
   */
  | {
    kind: 'session'
    baseURL: string
    key: CredentialRef
    account?: { baseURL: string }
    invalid?: { route: keyof typeof ROUTE_PACKAGES; reason: string }
  }
)

/** A mounted, active model route whose settings its own resolver rejects. */
interface InvalidRoute {
  /** Resolver failure message. */
  invalid: string
}

/** Path prefix of the Search and Fetch APIs under a DeepSeek origin. */
const TOOLS_PATH = '/v1/tools'

/** Credential reference of the official DeepSeek API key. */
const DEEPSEEK_API_KEY = credentialRef('DEEPSEEK_API_KEY')

/** Provider id of the DeepSeek account route. */
const ACCOUNT_PROVIDER = 'deepseek-account'

/** Loader package that registers each model route. */
const ROUTE_PACKAGES = {
  'deepseek-official': '@deepseek-ai/dsh-llm-deepseek-api-key',
  'deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
} as const

/** Display and configuration names of each capability. */
const CAPABILITY = {
  search: { subject: 'Search', prefix: 'search' },
  fetch: { subject: 'Fetch', prefix: 'fetch' },
} as const satisfies Record<Capability, { subject: DeepSeekWebGuidance['subject']; prefix: string }>

/**
 * Read the text of the latest human prompt, the question that triggered the
 * current turn. Injected user-role context carries another source kind.
 * @param session - the initiating Session, when the search runs inside one.
 * @returns the prompt's joined text blocks, or undefined without a prompt.
 */
function latestUserQuestion(session: Session | undefined): string | undefined {
  const prompt = session?.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')
  if (prompt === undefined) return undefined
  return prompt.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Register the Search API and Fetch API providers over one live settings section. Each operation reads one settings
 * snapshot and the route of the initiating Session's latest model request; each `ready()` call reads one settings
 * snapshot and the route of the model request being prepared. Both resolve the same plan.
 * @param ctx - plugin context owning both registrations.
 * @param config - live settings, read once per operation.
 */
export function apply(ctx: Context, config: Config): void {
  const own = (capability: Capability) => capability === 'search'
    ? { baseURL: config.searchBaseURL.get(), ref: config.searchApiKeyEnv.get() }
    : { baseURL: config.fetchBaseURL.get(), ref: config.fetchApiKeyEnv.get() }
  const plan = (capability: Capability, llmProvider: string | undefined) =>
    resolvePlan(ctx, capability, own(capability), llmProvider)
  const target = (capability: Capability) => {
    const resolved = plan(capability, ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider)
    return { baseURL: resolved.baseURL, auth: planAuth(ctx, resolved), guidance: planGuidance(resolved) }
  }
  const ready = (capability: Capability) => (llmProvider: string | undefined): Promise<boolean> =>
    planReady(ctx, plan(capability, llmProvider))
  const searchApi = new DeepSeekSearchApiProvider(() => ({
    ...target('search'),
    count: config.count.get(),
    requestsPerSecond: config.searchRequestsPerSecond.get(),
    ...config.sendOriginalQuestion.get() ? {
      originalQuestion: () => latestUserQuestion(ctx.get('agents')?.currentInitiator()?.session),
    } : {},
  }))
  const fetchApi = new DeepSeekFetchApiProvider(() => target('fetch'))
  ctx.web.registerSearchProvider({
    id: searchApi.id,
    description: searchApi.description,
    available: () => searchApi.available(),
    ready: ready('search'),
    search: (request, signal) => searchApi.search(request, signal),
  })
  ctx.web.registerFetchProvider({
    id: fetchApi.id,
    description: fetchApi.description,
    available: () => fetchApi.available(),
    ready: ready('fetch'),
    fetch: (request, signal) => fetchApi.fetch(request, signal),
  })
}

/**
 * Resolve the endpoint and credential of one capability without reading credential values. Route endpoints use the
 * origin of the route's resolved Messages base URL with `/v1/tools`.
 * @param ctx - context with the model and loader services.
 * @param capability - the capability being resolved.
 * @param own - the capability's own base URL and credential reference; empty values count as unset.
 * @param llmProvider - provider route of the model request the operation serves.
 * @returns the plan.
 */
function resolvePlan(
  ctx: Context, capability: Capability, own: { baseURL: string | undefined; ref: string | undefined }, llmProvider: string | undefined,
): Plan {
  const ownBaseURL = nonEmpty(own.baseURL), ownRef = nonEmpty(own.ref)
  if (ownBaseURL !== undefined || ownRef !== undefined) {
    return {
      capability, kind: 'custom', baseURL: ownBaseURL ?? DEEPSEEK_WEB_API_BASE_URL,
      key: ownRef === undefined ? DEEPSEEK_API_KEY : credentialRef(ownRef),
    }
  }
  const official = officialRoute(ctx)
  const account = llmProvider === ACCOUNT_PROVIDER ? accountRoute(ctx) : undefined
  // An invalid route keeps the official base only as an unused placeholder: the transport fails before it would send.
  const officialValid = official !== undefined && !('invalid' in official) ? official : undefined
  const invalid: { route: keyof typeof ROUTE_PACKAGES; reason: string } | undefined =
    account !== undefined && 'invalid' in account ? { route: ACCOUNT_PROVIDER, reason: account.invalid }
      : official !== undefined && 'invalid' in official ? { route: 'deepseek-official', reason: official.invalid }
        : undefined
  return {
    capability, kind: 'session',
    baseURL: officialValid === undefined ? DEEPSEEK_WEB_API_BASE_URL : toolsBase(officialValid.baseURL),
    key: officialValid?.apiKeyEnv ?? DEEPSEEK_API_KEY,
    ...account === undefined || 'invalid' in account ? {} : { account: { baseURL: toolsBase(account.baseURL) } },
    ...invalid === undefined ? {} : { invalid },
  }
}

/**
 * Build the authentication sources of one planned operation without reading secret values.
 * @param ctx - context with the account, credential, and launch-environment services.
 * @param plan - the operation's plan.
 * @returns the sources the transport resolves.
 */
function planAuth(ctx: Context, plan: Plan): DeepSeekWebAuth {
  return {
    ...plan.kind === 'session' && plan.account !== undefined ? {
      account: {
        baseURL: plan.account.baseURL,
        resolveToken: endpoint => resolveDeepSeekAccountToken(ctx, endpoint),
        rejectToken: token => rejectDeepSeekAccountToken(ctx, token),
      },
    } : {},
    resolveApiKey: () => resolveDeepSeekApiKey(ctx, plan.key),
    apiKeyEnv: plan.key,
    missingKeyMessage: missingKeyMessage(plan),
    ...plan.kind === 'session' && plan.invalid !== undefined ? {
      invalidRoute: {
        stage: plan.invalid.route === ACCOUNT_PROVIDER ? 'account' : 'api-key',
        message: invalidRouteMessage(plan.capability, plan.invalid.route, plan.invalid.reason),
      },
    } : {},
  }
}

/**
 * Whether an operation planned as `plan` has a credential, checked in the order {@link planAuth} resolves them. A
 * failed read, or a needed route whose settings do not resolve, answers false, because the operation fails on the same
 * step. Only presence is checked: the key's value
 * is not read and the endpoint is not contacted, so a wrong key still counts as configured.
 * @param ctx - context with the account, credential, and launch-environment services.
 * @param plan - the operation's plan.
 * @returns whether the operation has a credential to send.
 */
async function planReady(ctx: Context, plan: Plan): Promise<boolean> {
  if (plan.kind === 'session' && plan.invalid?.route === ACCOUNT_PROVIDER) return false
  if (plan.kind === 'session' && plan.account !== undefined) {
    let token: string | undefined
    try { token = await resolveDeepSeekAccountToken(ctx, plan.account.baseURL) }
    catch (_unreadableGrant) { return false /* The operation fails on this read before it tries the API key. */ }
    if (token !== undefined && token.length > 0) return true
  }
  if (plan.kind === 'session' && plan.invalid !== undefined) return false
  try { return await deepSeekApiKeyConfigured(ctx, plan.key) }
  catch (_unreadableStore) { return false /* A store that cannot be read supplies no key to the operation either. */ }
}

/** Settings named by endpoint failures of one planned operation. */
function planGuidance(plan: Plan): DeepSeekWebGuidance {
  const { subject, prefix } = CAPABILITY[plan.capability]
  return {
    subject, plugin: name, custom: plan.kind === 'custom', baseURLField: `${prefix}BaseURL`, apiKeyEnvField: `${prefix}ApiKeyEnv`,
  }
}

/** Model-facing diagnostic for an operation that has no credential to send. */
function missingKeyMessage(plan: Plan): string {
  const { subject, prefix } = CAPABILITY[plan.capability]
  const ref = JSON.stringify(plan.key)
  if (plan.kind === 'custom') {
    return `DeepSeek ${subject} API sends the API key under ${ref} to its own endpoint, and no key is configured for ${ref}.`
      + ` Guide the user to export ${ref} in the launching environment, or to correct ${name}.${prefix}ApiKeyEnv.`
  }
  return `DeepSeek ${subject} API uses the DeepSeek API key, and no key is configured for ${ref}. Guide the user to add the`
    + ` DeepSeek API key on the Models page or export ${ref} in the launching environment, or to sign in to DeepSeek and`
    + ' chat on the DeepSeek account model provider.'
}

/**
 * Model-facing diagnostic for an operation that would use a mounted model route whose settings do not resolve.
 * @param capability - the capability that stopped.
 * @param route - the route whose settings failed.
 * @param reason - the route resolver's failure message.
 * @returns the diagnostic naming the route and both recoveries.
 */
function invalidRouteMessage(capability: Capability, route: keyof typeof ROUTE_PACKAGES, reason: string): string {
  const { subject, prefix } = CAPABILITY[capability]
  const provider = route === ACCOUNT_PROVIDER ? 'DeepSeek account model provider' : 'DeepSeek API-key model provider'
  const credential = route === ACCOUNT_PROVIDER ? 'the DeepSeek account sign-in' : 'that provider\'s API key'
  return `DeepSeek ${subject} API sends ${credential} to the origin of the ${provider}, and that provider's settings do not`
    + ` resolve: ${reason}. ${subject} did not send the request. Guide the user to correct that provider's settings on the`
    + ` Models page or in the deployment configuration, or to set ${name}.${prefix}BaseURL and ${name}.${prefix}ApiKeyEnv`
    + ` so ${subject} uses its own endpoint.`
}

/**
 * Read the active DeepSeek API-key model route.
 * @returns its Messages base URL and credential reference, the resolver failure when its settings do not resolve, or
 *   undefined when none is mounted and active.
 */
function officialRoute(ctx: Context): { baseURL: string; apiKeyEnv: CredentialRef } | InvalidRoute | undefined {
  const config = routeConfig(ctx, 'deepseek-official') as OfficialRouteConfig | undefined
  if (config === undefined) return undefined
  try {
    const resolved = resolveOfficialOptions(plainOfficialOptions(config), launchEnvironmentOf(ctx))
    return { baseURL: resolved.baseURL, apiKeyEnv: resolved.apiKeyEnv }
  } catch (error: unknown) { return { invalid: errorMessage(error) } }
}

/**
 * Read the active DeepSeek account model route.
 * @returns its Messages base URL, the resolver failure when its settings do not resolve, or undefined when none is
 *   mounted and active.
 */
function accountRoute(ctx: Context): { baseURL: string } | InvalidRoute | undefined {
  const config = routeConfig(ctx, 'deepseek-account') as AccountRouteConfig | undefined
  if (config === undefined) return undefined
  try { return { baseURL: resolveAccountOptions(plainAccountOptions(config), launchEnvironmentOf(ctx)).protocol.baseURL } }
  catch (error: unknown) { return { invalid: errorMessage(error) } }
}

/** The message of a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Find the effective config of the active loader entry that registers `provider`, as the model provider directory
 * names it. A route registered by another package, nested settings, or an inactive entry counts as absent.
 */
function routeConfig(ctx: Context, provider: keyof typeof ROUTE_PACKAGES): unknown {
  const llm = ctx.get('llm'), loader = ctx.get('loader')
  if (llm === undefined || loader === undefined || !llm.listProviders().some(row => row.id === provider)) return undefined
  const directory = llm.listConfigurableProviders().find(row => row.provider === provider)
  if (directory === undefined || directory.settingsPath.length !== 0) return undefined
  const entry = [...loader.entries()].find(row => row.options.id === directory.settingsNs && row.options.name === ROUTE_PACKAGES[provider])
  if (entry?.fiber?.state !== FiberState.ACTIVE) return undefined
  return entry.fiber.effectiveConfig
}

/** The Search and Fetch API base under the origin of a Messages base URL. */
function toolsBase(messagesBaseURL: string): string {
  return `${new URL(messagesBaseURL).origin}${TOOLS_PATH}`
}

/** A string with content, or undefined for an absent or empty value. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
