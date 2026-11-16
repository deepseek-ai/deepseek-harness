/**
 * Connect DeepSeek model route settings to `ctx.deepseekAuth` the way the route plugins do. It reimplements their
 * connection over the plugins' config resolvers, so `composition.spec.ts`, which boots the real route plugins through
 * the Loader, is what covers the production path.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-auth'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Config as AccountConfig } from '@deepseek-ai/dsh-llm-deepseek-account'
import { plainAccountOptions, resolveAccountOptions } from '@deepseek-ai/dsh-llm-deepseek-account/src/config.ts'
import { Config as OfficialConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key/src/config.ts'

/** One model route row. */
export interface RouteRow {
  /** Provider id the route registers. */
  provider: 'deepseek-official' | 'deepseek-account'
  /** Route plugin config; the route package's own resolver turns it into the connected base URL and key reference. */
  config?: Record<string, unknown>
  /** Connect no deployment, as an adapter another package registers under this id does. Defaults to false. */
  withoutConnection?: boolean
  /** Value the route's settings throw instead of resolving. */
  throws?: unknown
  /** Base URL connected in place of the resolved one, as route settings naming an unparsable base would. */
  connectedBaseURL?: string
}

/**
 * Connect `routes` to the mounted `ctx.deepseekAuth`, each resolving its config per request as the route plugin does.
 * @param ctx - the root context, with the authentication service mounted.
 * @param routes - route rows, one per provider id.
 */
export function provideRoutes(ctx: Context, routes: readonly RouteRow[]): void {
  for (const route of routes) {
    if (route.withoutConnection === true) continue
    ctx.effect(() => ctx.deepseekAuth.connect(route.provider === 'deepseek-official' ? 'api-key' : 'account', route.provider, () => {
      if (route.throws !== undefined) throw route.throws
      const environment = launchEnvironmentOf(ctx)
      if (route.provider === 'deepseek-official') {
        const resolved = resolveAdapterOptions(plainOptions(OfficialConfig(route.config ?? {})), environment)
        return { baseURL: route.connectedBaseURL ?? resolved.baseURL, reference: resolved.apiKeyEnv, owner: 'llm-deepseek' }
      }
      const resolved = resolveAccountOptions(plainAccountOptions(AccountConfig(route.config ?? {})), environment)
      return { baseURL: route.connectedBaseURL ?? resolved.protocol.baseURL }
    }))
  }
}
