/**
 * One pi-ai provider route as its own plugin row, for a composition layer that adds a route without restating
 * the `providers` dict of the `llm-pi-ai` adapter row: a deployment's home patch, a `--patch` overlay, a bundle.
 * The row's config is the route key in `provider` and the route's profile fields beside it; the row registers
 * them with the adapter row, which serves the route. A catalog route needs only its credential; a route pi-ai
 * does not ship declares its protocol, endpoint, and models.
 *
 * ```yaml
 * - id: llm-pi-ai-team-gateway
 *   name: '@deepseek-ai/dsh-llm-pi-ai/provider'
 *   config:
 *     provider: team-gateway
 *     displayName: Team Gateway
 *     apiKeyEnv: TEAM_GATEWAY_API_KEY
 *     api: openai-completions
 *     baseURL: https://gateway.team.example/v1
 *     models:
 *       - id: team-large
 *         contextWindow: 65536
 *         maxTokens: 4096
 * ```
 *
 * A row and the adapter row's dict, or several rows, may name one route; the declaration that comes last in the
 * composed entry list is the one in effect, and the dict takes the position of the adapter's row.
 *
 * @module @deepseek-ai/dsh-llm-pi-ai/provider
 */
import type { Context } from '@deepseek-ai/cordis'

import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import { ProviderConfig, resolveProfiles, rowProfile } from './config.ts'
import type { ProviderRowConfig } from './config.ts'
import type {} from './registry.ts'

export const name = 'llm-pi-ai-provider'
export const inject = ['piAiProviders']
export const Config = ProviderConfig

/** Register this row's provider route and keep it current with the row's config. */
export function apply(ctx: Context, config: ProviderRowConfig): void {
  // Outermost, so the candidate arrives parsed. A config that is written must be serviceable: the row starts
  // with catalog diagnostics that a stored file carries from an upgrade, and refuses them in an added or edited one.
  ctx.on('internal/config', (fiber, next) => {
    const candidate = next() as ProviderRowConfig
    if (fiber === ctx.fiber) resolveProfiles({ [candidate.provider]: structuredClone(rowProfile(candidate)) })
    return candidate
  }, { prepend: true })
  const registration = ctx.piAiProviders.register(config.provider, rowProfile(config))
  ctx.on('loader/volatile-update', () => { registration.replace(rowProfile(config)) })
  // The Models page shows this row's route, so settings generates no page of its own for the row.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
