/** Stand-in model and loader services that expose DeepSeek model routes the way the provider directory does. */
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { Config as AccountConfig } from '@deepseek-ai/dsh-llm-deepseek-account'
import { Config as OfficialConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'

/** One model route row. */
export interface RouteRow {
  /** Provider id the route registers. */
  provider: 'deepseek-official' | 'deepseek-account'
  /** Route plugin config, parsed by the route package's own schema. */
  config?: Record<string, unknown>
  /** Loader package name; defaults to the package that registers the provider. */
  name?: string
  /** Loader fiber state; defaults to active. */
  state?: FiberState
  /** Provider directory settings path; defaults to the entry root. */
  settingsPath?: string[]
}

const PACKAGES = {
  'deepseek-official': '@deepseek-ai/dsh-llm-deepseek-api-key',
  'deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
} as const

/**
 * Provide `llm` and `loader` stand-ins whose rows describe `routes`.
 * @param ctx - the root context.
 * @param routes - route rows; each gets its own loader entry.
 */
export function provideRoutes(ctx: Context, routes: readonly RouteRow[]): void {
  const rows = routes.map((route, index) => ({
    route,
    entry: {
      options: { id: `route-${String(index)}`, name: route.name ?? PACKAGES[route.provider] },
      fiber: {
        state: route.state ?? FiberState.ACTIVE,
        effectiveConfig: route.provider === 'deepseek-official' ? OfficialConfig(route.config ?? {}) : AccountConfig(route.config ?? {}),
      },
    },
  }))
  ctx.provide('llm', {
    listProviders: () => rows.map(({ route }) => ({ id: route.provider })),
    listConfigurableProviders: () => rows.map(({ route, entry }) => ({
      provider: route.provider, settingsNs: entry.options.id, settingsPath: route.settingsPath ?? [],
    })),
  } as never)
  ctx.provide('loader', { entries: () => rows.map(({ entry }) => entry).values() } as never)
}
