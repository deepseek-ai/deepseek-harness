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
  /** Maximum captured bytes per `gh` output stream and combined JSON bytes of one complete check read or review read. */
  maxOutputBytes?: number
  /**
   * Most review threads counted per pull request in one status read, which reports a lower bound past it, and read in
   * one review read, which reports itself truncated past it.
   */
  maxReviewThreads?: number
  /** Most commits one pull request commit listing returns; GitHub lists at most 250 commits of a pull request. */
  maxCommits?: number
  /** Most files whose viewed marks one read lists; GitHub lists at most 3,000 files of a pull request. */
  maxViewedFiles?: number
}

export const Config: z<Config> = z.object({
  ghCommand: z.string().default('gh'),
  hosts: z.array(z.string()).default(['github.com']),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
  maxReviewThreads: z.number().default(1_000),
  maxCommits: z.number().default(250),
  maxViewedFiles: z.number().default(3_000),
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
  for (const key of ['maxOutputBytes', 'maxReviewThreads', 'maxCommits', 'maxViewedFiles'] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-github: ${key} must be a positive safe integer`)
  }
  ctx.forge.register(new GitHubProvider(ghRunner(resolved), resolved.hosts, resolved))
}
