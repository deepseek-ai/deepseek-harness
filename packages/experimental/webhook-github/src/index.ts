/** Signed GitHub HTTP adapter for the provider-neutral webhook runtime. */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { createGitHubWebhookHandler } from './handler.ts'

export type * from './types.ts'

/** Cordis function-plugin name. */
export const name = 'webhook-github'
/** Host services required before the exact route can register. */
export const inject = ['webServer', 'webhookRuntime', 'credentials']

/** Required GitHub ingress configuration. */
export interface Config {
  /** Adapter instance name carried to rules. */
  readonly source: string
  /** Exact absolute route path. */
  readonly path: string
  /** Credential reference containing the shared webhook secret. */
  readonly secretEnv: string
  /** Positive raw body ceiling in bytes. */
  readonly maxBodyBytes: number
}

export const Config: z<Config> = z.object({
  source: z.string().required(),
  path: z.string().required(),
  secretEnv: z.string().role('credential-ref').required(),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
})

/** Validate route and source facts that Schemastery cannot express. */
function assertConfig(config: Config): void {
  if (config.source.trim() !== config.source || config.source === '') {
    throw new Error('webhook-github source must be a non-empty trimmed string')
  }
  if (!config.path.startsWith('/') || config.path === '/' || config.path.endsWith('/')
    || config.path.includes('?') || config.path.includes('#')) {
    throw new Error('webhook-github path must be an absolute non-root pathname without a trailing slash, query, or fragment')
  }
}

/** Register one signed GitHub endpoint on the injected WebServer. */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const route = {
    kind: 'exact' as const,
    path: config.path,
    handler: createGitHubWebhookHandler(ctx, {
      source: config.source,
      secretEnv: credentialRef(config.secretEnv),
      maxBodyBytes: config.maxBodyBytes,
    }),
  }
  ctx.effect(
    () => ctx.webServer.register(route),
    `webhook-github: ${config.path}`,
  )
}
