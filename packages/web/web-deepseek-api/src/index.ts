/**
 * Register the DeepSeek Search and Fetch APIs in `ctx.web` as `deepseek-search-api`
 * and `deepseek-fetch-api`. Each operation is one direct API request without an
 * auxiliary model request. `web.searchProvider` and `web.fetchProvider` select them. Each capability's billing setting
 * chooses its credential. `auto` follows the conversation: a Session whose latest model request used the
 * `deepseek-account` route sends the account token to that route's origin and otherwise the API key; one on the
 * `deepseek-official` route sends the API key; any other operation sends the API key and, without a key, the signed-in
 * account's token. `account` sends only the account token and `api-key` only the API key. The API key is that of the
 * DeepSeek API-key route, sent to its origin, or `DEEPSEEK_API_KEY` sent to the official base without that route. The
 * account token goes to the account route's origin, or outside an account conversation without that route to the origin
 * of its default base URL. An operation that needs a mounted route whose settings do not resolve fails instead of
 * changing its endpoint or credential. A capability with its own `*BaseURL` or `*ApiKeyEnv` uses only that endpoint and
 * key instead, whatever its billing
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

/** Model route whose settings an operation can depend on. */
type RouteName = keyof typeof ROUTE_PACKAGES

/**
 * Rule that ordered an operation's credentials: `auto` billing in a conversation on the account route, on the API-key
 * route, or anywhere else, or an explicit billing.
 */
type Rule = 'account-conversation' | 'official-conversation' | 'other-conversation' | 'account' | 'api-key'

/** One credential an operation can send, or the failure of the route it needs for it. */
type Step =
  /** The account token, sent to {@link baseURL}. */
  | { source: 'account'; baseURL: string }
  /** The API key under {@link key}, sent to {@link baseURL}. */
  | { source: 'api-key'; baseURL: string; key: CredentialRef }
  /** The route this credential needs is mounted, and its resolver rejects its settings with {@link reason}. */
  | { source: 'account' | 'api-key'; invalid: string }

/** Endpoint and credential resolved for one operation or readiness check of one capability. */
type Plan = { capability: Capability } & (
  /** The capability's own endpoint and key; never the account token. */
  | { kind: 'custom'; baseURL: string; key: CredentialRef }
  /** The credentials {@link rule} selects, tried in order; the operation sends the first one available. */
  | { kind: 'billing'; rule: Rule; steps: readonly [Step, ...Step[]] }
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

/** Provider id of the DeepSeek API-key route. */
const OFFICIAL_PROVIDER = 'deepseek-official'

/** Loader package that registers each model route. */
const ROUTE_PACKAGES = {
  [OFFICIAL_PROVIDER]: '@deepseek-ai/dsh-llm-deepseek-api-key',
  [ACCOUNT_PROVIDER]: '@deepseek-ai/dsh-llm-deepseek-account',
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
    ? { baseURL: config.searchBaseURL.get(), ref: config.searchApiKeyEnv.get(), billing: config.searchBilling.get() }
    : { baseURL: config.fetchBaseURL.get(), ref: config.fetchApiKeyEnv.get(), billing: config.fetchBilling.get() }
  const plan = (capability: Capability, llmProvider: string | undefined) =>
    resolvePlan(ctx, capability, own(capability), llmProvider)
  const target = (capability: Capability) => {
    const resolved = plan(capability, ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider)
    return { baseURL: planBaseURL(resolved), auth: planAuth(ctx, resolved), guidance: planGuidance(resolved) }
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
 * @param own - the capability's own base URL and credential reference, where empty values count as unset, and its
 *   billing.
 * @param llmProvider - provider route of the model request the operation serves.
 * @returns the plan.
 */
function resolvePlan(
  ctx: Context, capability: Capability,
  own: { baseURL: string | undefined; ref: string | undefined; billing: Billing }, llmProvider: string | undefined,
): Plan {
  const ownBaseURL = nonEmpty(own.baseURL), ownRef = nonEmpty(own.ref)
  if (ownBaseURL !== undefined || ownRef !== undefined) {
    return {
      capability, kind: 'custom', baseURL: ownBaseURL ?? DEEPSEEK_WEB_API_BASE_URL,
      key: ownRef === undefined ? DEEPSEEK_API_KEY : credentialRef(ownRef),
    }
  }
  const rule: Rule = own.billing !== 'auto' ? own.billing
    : llmProvider === ACCOUNT_PROVIDER ? 'account-conversation'
      : llmProvider === OFFICIAL_PROVIDER ? 'official-conversation' : 'other-conversation'
  return { capability, kind: 'billing', rule, steps: ruleSteps(ctx, rule) }
}

/**
 * The credentials one rule tries, in order.
 * @param ctx - context with the model and loader services.
 * @param rule - the rule.
 * @returns the steps; the account step is absent in an account conversation without a mounted account route.
 */
function ruleSteps(ctx: Context, rule: Rule): [Step, ...Step[]] {
  switch (rule) {
    case 'account-conversation': {
      const account = accountStep(ctx, false)
      return account === undefined ? [apiKeyStep(ctx)] : [account, apiKeyStep(ctx)]
    }
    case 'official-conversation':
    case 'api-key': return [apiKeyStep(ctx)]
    case 'other-conversation': return [apiKeyStep(ctx), accountStep(ctx, true)]
    case 'account': return [accountStep(ctx, true)]
    /* v8 ignore next -- the switch is exhaustive. */
    default: return assertNever(rule)
  }
}

/** The API-key step: the DeepSeek API-key route's key and origin, or `DEEPSEEK_API_KEY` and the official base without it. */
function apiKeyStep(ctx: Context): Step {
  const official = officialRoute(ctx)
  if (official === undefined) return { source: 'api-key', baseURL: DEEPSEEK_WEB_API_BASE_URL, key: DEEPSEEK_API_KEY }
  if ('invalid' in official) return { source: 'api-key', invalid: official.invalid }
  return { source: 'api-key', baseURL: toolsBase(official.baseURL), key: official.apiKeyEnv }
}

/**
 * The account step: the account route's origin, or without that route the origin of its default base URL.
 * @param ctx - context with the model, loader, and launch-environment services.
 * @param unmountedDefault - whether a missing account route uses its default base URL rather than omitting the step.
 * @returns the step, or undefined without the route when {@link unmountedDefault} is false.
 */
function accountStep(ctx: Context, unmountedDefault: true): Step
function accountStep(ctx: Context, unmountedDefault: boolean): Step | undefined
function accountStep(ctx: Context, unmountedDefault: boolean): Step | undefined {
  const account = accountRoute(ctx) ?? (unmountedDefault ? defaultAccountRoute(ctx) : undefined)
  if (account === undefined) return undefined
  if ('invalid' in account) return { source: 'account', invalid: account.invalid }
  return { source: 'account', baseURL: toolsBase(account.baseURL) }
}

/** Whether a step's route resolved. */
function resolvedStep(step: Step): step is Exclude<Step, { invalid: string }> {
  return !('invalid' in step)
}

/** The base an operation's API key goes to; a plan without one names a base no credential is sent to. */
function planBaseURL(plan: Plan): string {
  if (plan.kind === 'custom') return plan.baseURL
  const step = plan.steps.filter(resolvedStep).find(row => row.source === 'api-key') ?? plan.steps.find(resolvedStep)
  return step?.baseURL ?? DEEPSEEK_WEB_API_BASE_URL
}

/**
 * Build the authentication sources of one planned operation without reading secret values.
 * @param ctx - context with the account, credential, and launch-environment services.
 * @param plan - the operation's plan.
 * @returns the sources the transport resolves.
 */
function planAuth(ctx: Context, plan: Plan): DeepSeekWebAuth {
  if (plan.kind === 'custom') {
    return {
      resolveApiKey: () => resolveDeepSeekApiKey(ctx, plan.key), apiKeyEnv: plan.key, missingKeyMessage: missingKeyMessage(plan),
    }
  }
  const [first, second] = plan.steps
  if (!resolvedStep(first)) {
    // Fails before any credential is read; the resolver only keeps the transport from reporting no credential source.
    return {
      /* v8 ignore next -- the transport fails at the account stage before it resolves a key. */
      resolveApiKey: () => Promise.resolve(undefined),
      invalidRoute: { stage: 'account', message: invalidRouteMessage(plan.capability, stepRoute(first), first.invalid) },
    }
  }
  const account = plan.steps.filter(resolvedStep).find(row => row.source === 'account')
  const apiKey = plan.steps.filter(resolvedStep).find(row => row.source === 'api-key')
  const keyRef = apiKey?.source === 'api-key' ? apiKey.key : undefined
  // With the key first, the account releases no token while a key is configured, so the transport sends the key.
  const keyFirst = first.source === 'api-key' && keyRef !== undefined
  return {
    ...account === undefined ? {} : {
      account: {
        baseURL: account.baseURL,
        resolveToken: keyFirst
          ? async (endpoint: string) => await deepSeekApiKeyConfigured(ctx, keyRef)
            ? undefined : await resolveDeepSeekAccountToken(ctx, endpoint)
          : (endpoint: string) => resolveDeepSeekAccountToken(ctx, endpoint),
        rejectToken: (token: string) => rejectDeepSeekAccountToken(ctx, token),
      },
    },
    ...keyRef === undefined ? {} : { resolveApiKey: () => resolveDeepSeekApiKey(ctx, keyRef), apiKeyEnv: keyRef },
    missingKeyMessage: missingKeyMessage(plan),
    ...second !== undefined && !resolvedStep(second) && second.source === 'api-key' ? {
      invalidRoute: { stage: 'api-key', message: invalidRouteMessage(plan.capability, stepRoute(second), second.invalid) },
    } : {},
  }
}

/** The model route a step's credential depends on. */
function stepRoute(step: Step): RouteName {
  return step.source === 'account' ? ACCOUNT_PROVIDER : OFFICIAL_PROVIDER
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
  const steps: readonly Step[] = plan.kind === 'custom'
    ? [{ source: 'api-key', baseURL: plan.baseURL, key: plan.key }] : plan.steps
  for (const step of steps) {
    if (!resolvedStep(step)) return false
    if (step.source === 'account') {
      let token: string | undefined
      try { token = await resolveDeepSeekAccountToken(ctx, step.baseURL) }
      catch (_unreadableGrant) { return false /* The operation fails on this read before it tries another credential. */ }
      if (token !== undefined && token.length > 0) return true
      continue
    }
    try { if (await deepSeekApiKeyConfigured(ctx, step.key)) return true }
    catch (_unreadableStore) { return false /* A store that cannot be read fails the operation on this step too. */ }
  }
  return false
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
  if (plan.kind === 'custom') {
    const ref = JSON.stringify(plan.key)
    return `DeepSeek ${subject} API sends the API key under ${ref} to its own endpoint, and no key is configured for ${ref}.`
      + ` Guide the user to export ${ref} in the launching environment, or to correct ${name}.${prefix}ApiKeyEnv.`
  }
  const key = plan.steps.find(step => step.source === 'api-key' && resolvedStep(step))
  const ref = JSON.stringify(key !== undefined && 'key' in key ? key.key : DEEPSEEK_API_KEY)
  const addKey = `add the DeepSeek API key on the Models page or export ${ref} in the launching environment`
  const billing = `${name}.${prefix}Billing`
  const settings = 'on the Web search and fetch settings page'
  switch (plan.rule) {
    case 'account-conversation':
      return `DeepSeek ${subject} API uses the DeepSeek account sign-in of this conversation, then the DeepSeek API key, and`
        + ` neither is available: no signed-in DeepSeek account is available, and no key is configured for ${ref}. Guide the`
        + ` user to sign in to DeepSeek, or to ${addKey}.`
    case 'official-conversation':
      return `DeepSeek ${subject} API uses the DeepSeek API key, as this conversation's model provider does, and no key is`
        + ` configured for ${ref}. Guide the user to ${addKey}, or to sign in to DeepSeek and set ${billing} to "account"`
        + ` ${settings}.`
    case 'other-conversation': {
      const account = plan.steps.find(step => step.source === 'account')
      const accountState = account !== undefined && !resolvedStep(account)
        ? `the settings of the DeepSeek account model provider do not resolve: ${account.invalid}`
        : 'no signed-in DeepSeek account is available'
      const accountRecovery = account !== undefined && !resolvedStep(account)
        ? 'to correct the DeepSeek account model provider\'s settings on the Models page or in the deployment configuration'
        : 'to sign in to DeepSeek'
      return `DeepSeek ${subject} API uses the DeepSeek API key, then the DeepSeek account sign-in, and neither is available:`
        + ` no key is configured for ${ref}, and ${accountState}. Guide the user to ${addKey}, or ${accountRecovery}.`
    }
    case 'account':
      return `DeepSeek ${subject} API bills only the signed-in DeepSeek account, and no signed-in DeepSeek account is`
        + ` available. ${subject} did not send the request. Guide the user to sign in to DeepSeek, or to set ${billing} to`
        + ` "api-key" or "auto" ${settings}.`
    case 'api-key':
      return `DeepSeek ${subject} API bills only the DeepSeek API key, and no key is configured for ${ref}. Guide the user to`
        + ` ${addKey}, or to set ${billing} to "account" or "auto" ${settings}.`
    /* v8 ignore next -- the switch is exhaustive. */
    default: return assertNever(plan.rule)
  }
}

/**
 * Model-facing diagnostic for an operation that would use a mounted model route whose settings do not resolve.
 * @param capability - the capability that stopped.
 * @param route - the route whose settings failed.
 * @param reason - the route resolver's failure message.
 * @returns the diagnostic naming the route and both recoveries.
 */
function invalidRouteMessage(capability: Capability, route: RouteName, reason: string): string {
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
  const config = routeConfig(ctx, OFFICIAL_PROVIDER) as OfficialRouteConfig | undefined
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
  const config = routeConfig(ctx, ACCOUNT_PROVIDER) as AccountRouteConfig | undefined
  if (config === undefined) return undefined
  try { return { baseURL: resolveAccountOptions(plainAccountOptions(config), launchEnvironmentOf(ctx)).protocol.baseURL } }
  catch (error: unknown) { return { invalid: errorMessage(error) } }
}

/**
 * Resolve the account route's default settings, as an entry without settings would, including `DEEPSEEK_BASE_URL`.
 * @returns its Messages base URL, or the resolver failure.
 */
function defaultAccountRoute(ctx: Context): { baseURL: string } | InvalidRoute {
  try { return { baseURL: resolveAccountOptions({}, launchEnvironmentOf(ctx)).protocol.baseURL } }
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
function routeConfig(ctx: Context, provider: RouteName): unknown {
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

/* v8 ignore start -- reached only by a value outside a closed union, which the compiler rejects. */
/** Reject an unhandled member of a closed union. */
function assertNever(value: never): never {
  throw new Error(`web-deepseek-api: unexpected value ${String(value)}`)
}
/* v8 ignore stop */
