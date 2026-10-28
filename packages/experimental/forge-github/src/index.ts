/** Registers the GitHub provider of `ctx.forge`, which reads pull requests through the GitHub CLI on the host. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { ghRunner } from './gh.ts'
import { GitHubProvider } from './provider.ts'

export const name = 'forge-github'
export const inject = ['forge']

/** GitHub CLI executable, served hosts, and invocation limits. */
export interface Config {
  /** GitHub CLI executable name or absolute host path. */
  ghCommand?: string
  /** Host names this provider serves; list GitHub Enterprise hosts explicitly. */
  hosts?: string[]
  /** Deadline in milliseconds for one `gh` invocation. */
  timeoutMs?: number
  /** Maximum captured bytes per `gh` output stream. */
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  ghCommand: z.string().default('gh'),
  hosts: z.array(z.string()).default(['github.com']),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
})

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.ghCommand.trim().length === 0) throw new Error('forge-github: ghCommand must not be empty')
  if (resolved.hosts.length === 0) throw new Error('forge-github: hosts must list at least one host')
  for (const host of resolved.hosts) {
    if (!HOST.test(host)) throw new Error(`forge-github: invalid host ${JSON.stringify(host)}`)
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`forge-github: timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isSafeInteger(resolved.maxOutputBytes) || resolved.maxOutputBytes <= 0) {
    throw new Error('forge-github: maxOutputBytes must be a positive safe integer')
  }
  ctx.forge.register(new GitHubProvider(ghRunner(resolved), resolved.hosts))
}
