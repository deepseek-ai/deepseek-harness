/**
 * A stand-in model service publishing DeepSeek route credentials the way the route plugins do. It reimplements their
 * publication over the plugins' config resolvers, so `composition.spec.ts`, which boots the real route plugins through
 * the Loader, is what covers the production path.
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRefConfigured, resolveCredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { ProviderCredential } from '@deepseek-ai/dsh-llm'
import { Config as AccountConfig } from '@deepseek-ai/dsh-llm-deepseek-account'
import { plainAccountOptions, resolveAccountOptions } from '@deepseek-ai/dsh-llm-deepseek-account/src/config.ts'
import { Config as OfficialConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key/src/config.ts'

/** One model route row. */
export interface RouteRow {
  /** Provider id the route registers. */
  provider: 'deepseek-official' | 'deepseek-account'
  /** Route plugin config; the route package's own resolver turns it into the published base URL and key reference. */
  config?: Record<string, unknown>
  /** Publish no credential, as an adapter another package registers under this id does. Defaults to false. */
  withoutCredential?: boolean
  /** Value `providerCredential()` throws instead of publishing. */
  throws?: unknown
  /** Base URL published in place of the resolved one, as a route publishing an unparsable base would. */
  publishedBaseURL?: string
  /** Credential kind published under this id, as another adapter registered under it can; defaults to the route's own kind. */
  publishes?: 'api-key' | 'account'
}

/** The credential `route` publishes, resolved from its config as the route plugin resolves it on each call. */
function credentialOf(ctx: Context, route: RouteRow): ProviderCredential {
  const environment = launchEnvironmentOf(ctx)
  if ((route.publishes ?? (route.provider === 'deepseek-official' ? 'api-key' : 'account')) === 'api-key') {
    const resolved = resolveAdapterOptions(plainOptions(OfficialConfig(route.config ?? {})), environment)
    const ref = resolved.apiKeyEnv
    return {
      kind: 'api-key', baseURL: route.publishedBaseURL ?? resolved.baseURL, reference: ref,
      configured: () => credentialRefConfigured(ctx, ref),
      resolve: async () => {
        const key = await resolveCredentialRef(ctx, ref)
        return key === undefined ? undefined : { headers: { 'x-api-key': key }, value: key }
      },
    }
  }
  const resolved = resolveAccountOptions(plainAccountOptions(AccountConfig(route.config ?? {})), environment)
  return {
    kind: 'account', baseURL: route.publishedBaseURL ?? resolved.protocol.baseURL,
    configured: async endpoint => (await ctx.get('deepseekAccount')?.resolveRequestCredential(endpoint)) !== undefined,
    resolve: endpoint => ctx.get('deepseekAccount')?.resolveRequestCredential(endpoint) ?? Promise.resolve(undefined),
  }
}

/**
 * Provide an `llm` stand-in whose `providerCredential()` answers for `routes`.
 * @param ctx - the root context.
 * @param routes - route rows, one per provider id.
 */
export function provideRoutes(ctx: Context, routes: readonly RouteRow[]): void {
  ctx.provide('llm', {
    providerCredential: (provider: string): ProviderCredential | undefined => {
      const route = routes.find(row => row.provider === provider)
      if (route === undefined || route.withoutCredential === true) return undefined
      if (route.throws !== undefined) throw route.throws
      return credentialOf(ctx, route)
    },
  } as never)
}
