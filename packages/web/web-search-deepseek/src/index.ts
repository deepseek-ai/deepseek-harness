/**
 * Register a DeepSeek-backed provider in `ctx.web`. It calls the Anthropic-compatible Messages API
 * with native `web_search_20250305`. A search initiated by a Session whose latest model request used
 * a route that publishes an account credential through `ctx.llm.providerCredential()` authenticates with
 * that credential when the search endpoint has the origin of that route's base URL and the
 * credential's owner allows the endpoint; every other search reuses `DEEPSEEK_API_KEY`. The provider
 * does not reuse `DEEPSEEK_BASE_URL`; auxiliary search has its own endpoint configuration. The
 * provider reports itself not ready for a model request whose search would have no credential.
 * @module @deepseek-ai/dsh-web-search-deepseek
 */
import type { Volatile } from '@deepseek-ai/cordis'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef, credentialRefConfigured, resolveCredentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import type { ProviderCredential } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from './provider.ts'
import type { DeepSeekSearchProviderOptions } from './provider.ts'

export {
  DeepSeekSearchProvider,
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_PROVIDER_ID,
} from './provider.ts'
export type { DeepSeekSearchLlmRequest, DeepSeekSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-deepseek'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal DeepSeek API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey: Volatile<string | undefined>
  /** Credential reference resolved for each search; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv: Volatile<string>
  /** Anthropic-compatible endpoint base; `/messages` is appended. */
  baseURL: Volatile<string | undefined>
  /** Anthropic-format model name. Defaults to `deepseek-v4-flash`. */
  model: Volatile<string>
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion: Volatile<string>
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens: Volatile<number>
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses: Volatile<number>
}

export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().volatile(),
  model: z.string().default(DEEPSEEK_DEFAULT_MODEL).volatile(),
  apiVersion: z.string().default(DEEPSEEK_DEFAULT_API_VERSION).volatile(),
  maxTokens: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_TOKENS).volatile(),
  maxUses: z.number().step(1).min(1).default(DEEPSEEK_DEFAULT_MAX_USES).volatile(),
})

/**
 * Auxiliary-search endpoint, independent of the conversation adapter's
 * `$DEEPSEEK_BASE_URL` and selected protocol.
 */
const SEARCH_BASE_URL_ENV = 'DEEPSEEK_SEARCH_BASE_URL'

/** Settings namespace carrying this provider's endpoint, model, and key reference. */
export const WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE = 'web-search-deepseek'

/** Options for one search, with the key reference the readiness check reads. */
type SearchOptions = DeepSeekSearchProviderOptions & { readonly apiKeyEnv: CredentialRef }

/**
 * The account credential the model route `route` publishes for the deployment that serves `endpoint`. A route's
 * account credential is sent only to the origin of that route's base URL, whatever destinations its owner would
 * release it for.
 * @param ctx - plugin context supplying the optional model service.
 * @param route - provider route of a model request; undefined names none.
 * @param endpoint - absolute URL the search dispatches to.
 * @returns the route's account credential, or undefined for another kind, another origin, no credential, or no route.
 * @throws when the route's settings do not resolve, or its published base URL or `endpoint` does not parse.
 */
function accountCredentialOf(ctx: Context, route: string | undefined, endpoint: string): ProviderCredential | undefined {
  const credential = route === undefined ? undefined : ctx.get('llm')?.providerCredential(route)
  if (credential?.kind !== 'account') return undefined
  return new URL(credential.baseURL).origin === new URL(endpoint).origin ? credential : undefined
}

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential, model, and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(
  ctx: Context, config: { [K in keyof Config]: ReturnType<Config[K]['get']> },
): SearchOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveAccountCredential: async (endpoint) => {
      // The latest request context names the route that served the model
      // request which called this search, as account sign-out reads it.
      const route = ctx.get('agents')?.currentInitiator()?.session.requestContext()?.provider
      const credential = accountCredentialOf(ctx, route, endpoint)
      return credential === undefined ? undefined : await credential.resolve(endpoint)
    },
    resolveApiKey: async () => {
      const value = await resolveCredentialRef(ctx, apiKeyEnv)
      return value === undefined ? undefined : assertUsableApiKey(value, name, apiKeyEnv)
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: config.model,
    apiVersion: config.apiVersion,
    maxTokens: config.maxTokens,
    maxUses: config.maxUses,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/deepseek-search-llm-request',
        request,
      )
    },
  }
}

/**
 * Whether the search a model request on `route` would make has a credential, checked in the order
 * the search resolves them: the account credential the route publishes for the origin of the search
 * endpoint first, then the API key. A route whose settings do not resolve or whose published base URL
 * does not parse, or a failed read, answers false, because the search fails there
 * instead of trying the next credential. Only presence is checked: the API key's value is not read
 * and the endpoint is not contacted, so a wrong key or an endpoint without native search still
 * counts as configured.
 * @param ctx - plugin context supplying the model, credential, and environment planes.
 * @param options - options the next search would use.
 * @param route - provider route of the model request being assembled.
 * @returns whether the account credential or an API key is available to that search.
 */
async function searchConfigured(
  ctx: Context, options: SearchOptions, route: string | undefined,
): Promise<boolean> {
  const endpoint = `${options.baseURL}/messages`
  let account: ProviderCredential | undefined
  try { account = accountCredentialOf(ctx, route, endpoint) }
  catch (_unresolvedRoute) { return false /* The search fails on this route before it reads any credential. */ }
  if (account !== undefined) {
    try { if (await account.configured(endpoint)) return true }
    catch (_unreadableGrant) { return false /* The search fails on this read before it tries the API key. */ }
  }
  if (options.apiKey !== undefined) return true
  try { return await credentialRefConfigured(ctx, options.apiKeyEnv) }
  catch (_unreadableStore) { return false /* A store that cannot be read supplies no key to the search either. */ }
}

/**
 * Register the DeepSeek search provider with `ctx.web`. Its `ready()` answers whether a
 * search for a model request on the given route would have a credential to send.
 */
export function apply(ctx: Context, config: Config): void {
  const options = () => resolveOptions(ctx, {
    apiKey: config.apiKey.get(), apiKeyEnv: config.apiKeyEnv.get(), baseURL: config.baseURL.get(), model: config.model.get(),
    apiVersion: config.apiVersion.get(), maxTokens: config.maxTokens.get(), maxUses: config.maxUses.get(),
  })
  const provider = new DeepSeekSearchProvider(options)
  ctx.web.registerSearchProvider({
    id: provider.id,
    description: provider.description,
    available: () => provider.available(),
    ready: llmProvider => searchConfigured(ctx, options(), llmProvider),
    search: (request, signal) => provider.search(request, signal),
  })
}
