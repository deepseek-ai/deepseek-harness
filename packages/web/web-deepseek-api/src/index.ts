/**
 * Register the DeepSeek Search and Fetch APIs in `ctx.web` as `deepseek-search-api` and `deepseek-fetch-api`. Each
 * operation is one direct API request without an auxiliary model request. `web.searchProvider` and `web.fetchProvider`
 * select them. Each capability's billing setting chooses its credential. `auto` follows the conversation: a Session
 * whose latest model request used the `deepseek-account` route sends the account credential to that route's origin and
 * otherwise the API key; one on the `deepseek-official` route sends the API key; any other operation sends the API key
 * and, without a key, the signed-in account's credential. `account` sends only the account credential and `api-key`
 * only the API key. Each mounted DeepSeek model route publishes its credential and base URL through
 * `ctx.llm.providerCredential()`: the API key is that of the `deepseek-official` route, sent to its origin, or
 * `DEEPSEEK_API_KEY` sent to the official base without that route; the account credential is that of the
 * `deepseek-account` route, sent to its origin, or outside an account conversation without that route the signed-in
 * account's credential sent to the origin `DEEPSEEK_BASE_URL` names, by default the official one. An operation that
 * needs a mounted route whose settings do not resolve fails instead of changing its endpoint or credential. A capability
 * with its own `*BaseURL` or `*ApiKeyEnv` uses only that endpoint and key instead, whatever its billing
 * ([rationale](../../../../.agents/notes/implemented/architecture/2026-10-29-web-provider-selection.md#credential-resolution)).
 * Both providers report themselves not ready when their next operation would have no credential.
 * @module @deepseek-ai/dsh-web-deepseek-api
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef, credentialRefConfigured, resolveCredentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, type LlmCredentialKind } from '@deepseek-ai/dsh-llm'
import { extractTextContent } from '@deepseek-ai/dsh-llm/message'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { DeepSeekFetchApiProvider } from './fetch.ts'
import {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_REQUESTS_PER_SECOND, DEEPSEEK_WEB_API_BASE_URL, DeepSeekSearchApiProvider,
} from './search.ts'
import {
  isDeepSeekWebAuthReady, type DeepSeekWebAuth, type DeepSeekWebAuthSource, type DeepSeekWebGuidance,
} from './transport.ts'

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
 * `*ApiKeyEnv` gives that capability its own endpoint and key; with neither, its `*Billing` chooses its DeepSeek
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
   * Credential Search sends without {@link searchBaseURL} and {@link searchApiKeyEnv}. `auto` uses the conversation's
   * DeepSeek account or API key while it chats on a DeepSeek model route, and otherwise the API key, then the signed-in
   * account; `account` uses only the signed-in account; `api-key` uses only the API key. Defaults to `auto`.
   */
  searchBilling: Volatile<'auto' | 'account' | 'api-key'>
  /** Credential Fetch sends without {@link fetchBaseURL} and {@link fetchApiKeyEnv}, chosen as {@link searchBilling} is. */
  fetchBilling: Volatile<'auto' | 'account' | 'api-key'>
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
  searchBilling: z.union(['auto', 'account', 'api-key'] as const).default('auto').volatile(),
  fetchBilling: z.union(['auto', 'account', 'api-key'] as const).default('auto').volatile(),
  searchBaseURL: z.string().volatile(),
  searchApiKeyEnv: z.string().role('credential-ref').volatile(),
  fetchBaseURL: z.string().volatile(),
  fetchApiKeyEnv: z.string().role('credential-ref').volatile(),
})

/** A capability that resolves its endpoint and credential independently of the other. */
type Capability = 'search' | 'fetch'

/** Credential choice of one capability without its own endpoint settings. */
type Billing = Config['searchBilling'] extends Volatile<infer B> ? B : never

/**
 * Rule that ordered an operation's credentials: `auto` billing in a conversation on the account route, on the API-key
 * route, or anywhere else, or an explicit billing.
 */
type Rule = 'account-conversation' | 'official-conversation' | 'other-conversation' | 'account' | 'api-key'

/** Path prefix of the Search and Fetch APIs under a DeepSeek origin. */
const TOOLS_PATH = '/v1/tools'

/** Credential reference of the official DeepSeek API key. */
const DEEPSEEK_API_KEY = credentialRef('DEEPSEEK_API_KEY')

/** Provider id of the DeepSeek account route. */
const ACCOUNT_PROVIDER = 'deepseek-account'

/** Provider id of the DeepSeek API-key route. */
const OFFICIAL_PROVIDER = 'deepseek-official'

/** Model route whose published credential an operation can send. */
type RouteName = typeof ACCOUNT_PROVIDER | typeof OFFICIAL_PROVIDER

/**
 * Credential kind each DeepSeek model route publishes. Billing chooses between the two kinds by route id, so an
 * adapter registered under one of these ids that publishes the other kind is not that route.
 */
const ROUTE_CREDENTIAL_KIND = {
  [ACCOUNT_PROVIDER]: 'account',
  [OFFICIAL_PROVIDER]: 'api-key',
} as const satisfies Record<RouteName, LlmCredentialKind>

/**
 * Launch-environment variable naming the DeepSeek deployment the model routes default to. Without the account route,
 * its origin receives the signed-in account's credential.
 */
const DEEPSEEK_BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/** Display names, configuration prefix, and operation path of each capability. */
const CAPABILITY = {
  search: { subject: 'Search', prefix: 'search', path: '/search' },
  fetch: { subject: 'Fetch', prefix: 'fetch', path: '/fetch' },
} as const satisfies Record<Capability, { subject: DeepSeekWebGuidance['subject']; prefix: string; path: '/search' | '/fetch' }>

/**
 * Read the text of the latest human prompt, the question that triggered the
 * current turn. Injected user-role context carries another source kind.
 * @param session - the initiating Session, when the search runs inside one.
 * @returns the prompt's joined text blocks, or undefined without a prompt.
 */
function latestUserQuestion(session: Session | undefined): string | undefined {
  const prompt = session?.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')
  if (prompt === undefined) return undefined
  return extractTextContent(prompt.content, { separator: '\n' })
}

/**
 * Register the Search API and Fetch API providers over one live settings section. Each operation reads one settings
 * snapshot and the route of the initiating Session's latest model request; each `ready()` call reads one settings
 * snapshot and the route of the model request being prepared. Both resolve the same ordered credentials.
 * @param ctx - plugin context owning both registrations.
 * @param config - live settings, read once per operation.
 */
export function apply(ctx: Context, config: Config): void {
  const own = (capability: Capability) => capability === 'search'
    ? { baseURL: config.searchBaseURL.get(), ref: config.searchApiKeyEnv.get(), billing: config.searchBilling.get() }
    : { baseURL: config.fetchBaseURL.get(), ref: config.fetchApiKeyEnv.get(), billing: config.fetchBilling.get() }
  const target = (capability: Capability, llmProvider: string | undefined) =>
    resolveTarget(ctx, capability, own(capability), llmProvider)
  const current = (capability: Capability) =>
    target(capability, ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider)
  const ready = (capability: Capability) => (llmProvider: string | undefined): Promise<boolean> =>
    isDeepSeekWebAuthReady(target(capability, llmProvider).auth, CAPABILITY[capability].path)
  const searchApi = new DeepSeekSearchApiProvider(() => ({
    ...current('search'),
    count: config.count.get(),
    requestsPerSecond: config.searchRequestsPerSecond.get(),
    ...config.sendOriginalQuestion.get() ? {
      originalQuestion: () => latestUserQuestion(ctx.get('agents')?.currentInitiator()?.session),
    } : {},
  }))
  const fetchApi = new DeepSeekFetchApiProvider(() => current('fetch'))
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
 * Resolve the ordered credentials and endpoint guidance of one capability without reading credential values. Route
 * endpoints use the origin of the route's published base URL with `/v1/tools`.
 * @param ctx - context with the model, credential, and account services.
 * @param capability - the capability being resolved.
 * @param own - the capability's own base URL and credential reference, where empty values count as unset, and its
 *   billing.
 * @param llmProvider - provider route of the model request the operation serves.
 * @returns the authentication sources and the settings endpoint failures name.
 */
function resolveTarget(
  ctx: Context, capability: Capability,
  own: { baseURL: string | undefined; ref: string | undefined; billing: Billing }, llmProvider: string | undefined,
): { auth: DeepSeekWebAuth; guidance: DeepSeekWebGuidance } {
  const { subject, prefix } = CAPABILITY[capability]
  const guidance = (custom: boolean): DeepSeekWebGuidance =>
    ({ subject, plugin: name, custom, baseURLField: `${prefix}BaseURL`, apiKeyEnvField: `${prefix}ApiKeyEnv` })
  const ownBaseURL = nonEmpty(own.baseURL), ownRef = nonEmpty(own.ref)
  if (ownBaseURL !== undefined || ownRef !== undefined) {
    const ref = ownRef === undefined ? DEEPSEEK_API_KEY : credentialRef(ownRef)
    const json = JSON.stringify(ref)
    return { guidance: guidance(true), auth: {
      sources: [apiKeySource(ctx, ownBaseURL ?? DEEPSEEK_WEB_API_BASE_URL, ref)],
      missingCredentialMessage: `DeepSeek ${subject} API sends the API key under ${json} to its own endpoint, and no key is`
        + ` configured for ${json}. Guide the user to export ${json} in the launching environment, or to correct`
        + ` ${name}.${prefix}ApiKeyEnv.`,
    } }
  }
  const rule: Rule = own.billing !== 'auto' ? own.billing
    : llmProvider === ACCOUNT_PROVIDER ? 'account-conversation'
      : llmProvider === OFFICIAL_PROVIDER ? 'official-conversation' : 'other-conversation'
  const sources = ruleSources(ctx, capability, rule)
  const ref: string = sources.flatMap(keyReference)[0] ?? DEEPSEEK_API_KEY
  return { guidance: guidance(false), auth: { sources, missingCredentialMessage: missingMessage(capability, rule, ref) } }
}

/**
 * The credentials one rule tries, in order.
 * @param ctx - context with the model, credential, and account services.
 * @param capability - the capability whose diagnostics misconfigured sources name.
 * @param rule - the rule.
 * @returns the sources; the account source is absent in an account conversation without a mounted account route.
 */
function ruleSources(ctx: Context, capability: Capability, rule: Rule): DeepSeekWebAuthSource[] {
  switch (rule) {
    case 'account-conversation': {
      const account = routeSource(ctx, capability, ACCOUNT_PROVIDER)
      return account === undefined ? [officialSource(ctx, capability)] : [account, officialSource(ctx, capability)]
    }
    case 'official-conversation':
    case 'api-key': return [officialSource(ctx, capability)]
    case 'other-conversation': return [officialSource(ctx, capability), accountSource(ctx, capability)]
    case 'account': return [accountSource(ctx, capability)]
    /* v8 ignore next -- the switch is exhaustive. */
    default: return assertNever(rule)
  }
}

/**
 * The credential a mounted model route publishes, sent to the Search and Fetch APIs under the origin of the route's
 * base URL.
 * @param ctx - context with the optional model service.
 * @param capability - the capability whose diagnostics a misconfigured source names.
 * @param provider - the route.
 * @returns the source; undefined when no mounted route publishes a credential of that route's kind as `provider`; a
 *   misconfigured source when the route's settings do not resolve or its published base URL does not parse.
 */
function routeSource(ctx: Context, capability: Capability, provider: RouteName): DeepSeekWebAuthSource | undefined {
  try {
    const credential = ctx.get('llm')?.providerCredential(provider)
    if (credential === undefined || credential.kind !== ROUTE_CREDENTIAL_KIND[provider]) return undefined
    return { kind: 'route', baseURL: toolsBase(credential.baseURL), credential }
  } catch (error: unknown) {
    return misconfigured(capability, provider, error)
  }
}

/**
 * The API key of the DeepSeek API-key route sent to its origin, or `DEEPSEEK_API_KEY` sent to the official base
 * without that route.
 * @returns the source, or a misconfigured source when the route's settings do not resolve.
 */
function officialSource(ctx: Context, capability: Capability): DeepSeekWebAuthSource {
  return routeSource(ctx, capability, OFFICIAL_PROVIDER) ?? apiKeySource(ctx, DEEPSEEK_WEB_API_BASE_URL, DEEPSEEK_API_KEY)
}

/**
 * The account credential of the DeepSeek account route sent to its origin, or without that route the signed-in
 * account's credential sent to the origin `DEEPSEEK_BASE_URL` names, by default the official one. The account service
 * releases its credential only for destinations it allows.
 * @returns the source, or a misconfigured source when the route's settings or `DEEPSEEK_BASE_URL` do not resolve.
 */
function accountSource(ctx: Context, capability: Capability): DeepSeekWebAuthSource {
  const route = routeSource(ctx, capability, ACCOUNT_PROVIDER)
  if (route !== undefined) return route
  const configured = nonEmpty(launchEnvironmentOf(ctx).get(DEEPSEEK_BASE_URL_ENV)?.value)
  let baseURL = DEEPSEEK_WEB_API_BASE_URL
  if (configured !== undefined) {
    try { baseURL = toolsBase(deploymentURL(configured)) }
    catch (error: unknown) { return misconfiguredDeployment(capability, error) }
  }
  return { kind: 'route', baseURL, credential: {
    kind: 'account',
    configured: async endpoint => (await ctx.get('deepseekAccount')?.resolveRequestCredential(endpoint)) !== undefined,
    resolve: endpoint => ctx.get('deepseekAccount')?.resolveRequestCredential(endpoint) ?? Promise.resolve(undefined),
  } }
}

/** The key under `ref`, read from the credentials service or the launch environment, sent to `baseURL`. */
function apiKeySource(ctx: Context, baseURL: string, ref: CredentialRef): DeepSeekWebAuthSource {
  return { kind: 'api-key', baseURL, key: {
    ref,
    configured: () => credentialRefConfigured(ctx, ref),
    resolve: async () => {
      const value = await resolveCredentialRef(ctx, ref)
      return value === undefined ? undefined : assertUsableApiKey(value, name, ref)
    },
  } }
}

/** The credential reference an API-key source names in missing-credential diagnostics. */
function keyReference(source: DeepSeekWebAuthSource): string[] {
  switch (source.kind) {
    case 'api-key': return [source.key.ref]
    case 'route': return source.credential.kind === 'api-key' && source.credential.reference !== undefined ? [source.credential.reference] : []
    case 'misconfigured': return []
    /* v8 ignore next -- the switch is exhaustive. */
    default: return assertNever(source)
  }
}

/**
 * The source of a credential whose model route settings do not resolve.
 * @param capability - the capability that stops.
 * @param route - the route whose settings failed.
 * @param error - the route's failure.
 * @returns the source whose diagnostic names the route and both recoveries.
 */
function misconfigured(capability: Capability, route: RouteName, error: unknown): DeepSeekWebAuthSource {
  const provider = route === ACCOUNT_PROVIDER ? 'DeepSeek account model provider' : 'DeepSeek API-key model provider'
  const credential = route === ACCOUNT_PROVIDER ? 'the DeepSeek account sign-in' : 'that provider\'s API key'
  return unresolvedSource(capability, `${credential} to the origin of the ${provider}, and that provider's settings do not resolve`,
    error, 'correct that provider\'s settings on the Models page or in the deployment configuration')
}

/**
 * The source of the signed-in account's credential when `DEEPSEEK_BASE_URL` is not an HTTP(S) URL.
 * @param capability - the capability that stops.
 * @param error - the URL failure.
 * @returns the source whose diagnostic names the variable and both recoveries.
 */
function misconfiguredDeployment(capability: Capability, error: unknown): DeepSeekWebAuthSource {
  return unresolvedSource(capability, `the DeepSeek account sign-in to the origin of ${DEEPSEEK_BASE_URL_ENV}, and that value does not resolve`,
    error, `correct ${DEEPSEEK_BASE_URL_ENV} in the launching environment`)
}

/** A misconfigured source whose diagnostic names what the operation sends where, the failure, and both recoveries. */
function unresolvedSource(capability: Capability, destination: string, error: unknown, recovery: string): DeepSeekWebAuthSource {
  const { subject, prefix } = CAPABILITY[capability]
  return { kind: 'misconfigured', message: `DeepSeek ${subject} API sends ${destination}: ${errorMessage(error)}. ${subject} did not`
    + ` send the request. Guide the user to ${recovery}, or to set ${name}.${prefix}BaseURL and ${name}.${prefix}ApiKeyEnv so`
    + ` ${subject} uses its own endpoint.` }
}

/**
 * Model-facing diagnostic for an operation billed by `rule` that has no credential to send.
 * @param capability - the capability that stops.
 * @param rule - the rule that ordered its credentials.
 * @param keyRef - the reference of the API key the rule tries, or `DEEPSEEK_API_KEY` when it tries none.
 * @returns the diagnostic naming the missing credentials and their recoveries.
 */
function missingMessage(capability: Capability, rule: Rule, keyRef: string): string {
  const { subject, prefix } = CAPABILITY[capability]
  const ref = JSON.stringify(keyRef)
  const addKey = `add the DeepSeek API key on the Models page or export ${ref} in the launching environment`
  const billing = `${name}.${prefix}Billing`
  const settings = 'on the Web search and fetch settings page'
  switch (rule) {
    case 'account-conversation':
      return `DeepSeek ${subject} API uses the DeepSeek account sign-in of this conversation, then the DeepSeek API key, and`
        + ` neither is available: no signed-in DeepSeek account is available, and no key is configured for ${ref}. Guide the`
        + ` user to sign in to DeepSeek, or to ${addKey}.`
    case 'official-conversation':
      return `DeepSeek ${subject} API uses the DeepSeek API key, as this conversation's model provider does, and no key is`
        + ` configured for ${ref}. Guide the user to ${addKey}, or to sign in to DeepSeek and set ${billing} to "account"`
        + ` ${settings}.`
    case 'other-conversation':
      return `DeepSeek ${subject} API uses the DeepSeek API key, then the DeepSeek account sign-in, and neither is available:`
        + ` no key is configured for ${ref}, and no signed-in DeepSeek account is available. Guide the user to ${addKey}, or`
        + ' to sign in to DeepSeek.'
    case 'account':
      return `DeepSeek ${subject} API bills only the signed-in DeepSeek account, and no signed-in DeepSeek account is`
        + ` available. ${subject} did not send the request. Guide the user to sign in to DeepSeek, or to set ${billing} to`
        + ` "api-key" or "auto" ${settings}.`
    case 'api-key':
      return `DeepSeek ${subject} API bills only the DeepSeek API key, and no key is configured for ${ref}. Guide the user to`
        + ` ${addKey}, or to set ${billing} to "account" or "auto" ${settings}.`
    /* v8 ignore next -- the switch is exhaustive. */
    default: return assertNever(rule)
  }
}

/** The message of a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Accept a deployment base URL that may receive the account credential: HTTP(S) without embedded credentials.
 * @param value - the configured URL.
 * @returns the value.
 * @throws {Error} when the value is not such a URL.
 */
function deploymentURL(value: string): string {
  const url = new URL(value)
  if (!/^https?:$/u.test(url.protocol) || url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${DEEPSEEK_BASE_URL_ENV} must be an HTTP(S) URL without credentials`)
  }
  return value
}

/** The Search and Fetch API base under the origin of a Messages base URL. */
function toolsBase(messagesBaseURL: string): string {
  return `${new URL(messagesBaseURL).origin}${TOOLS_PATH}`
}

/** A string with content, or undefined for an absent or empty value. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

/* v8 ignore start -- reached only by a value outside a closed union, which the compiler rejects. */
/** Reject an unhandled member of a closed union. */
function assertNever(value: never): never {
  throw new Error(`web-deepseek-api: unexpected value ${String(value)}`)
}
/* v8 ignore stop */
