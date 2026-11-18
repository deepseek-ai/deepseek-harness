/**
 * Registers the GitLab provider of `ctx.forge`, which reads merge requests through the GitLab CLI on the host, and,
 * while forge-session runs, the `glab` commands that bind merge requests to a Session.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import type {} from '@deepseek-ai/dsh-experimental-forge-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { GLAB_COMMANDS } from './commands.ts'
import { glabRunner } from './glab.ts'
import { GitLabProvider } from './provider.ts'

export const name = 'forge-gitlab'
export const inject = ['forge']

/** GitLab CLI executable, served hosts, and read limits. */
export interface Config {
  /** GitLab CLI executable name or absolute host path. */
  glabCommand?: string
  /** Host names this provider serves; list self-managed GitLab hosts explicitly. */
  hosts?: string[]
  /** Deadline in milliseconds for one `glab` invocation. */
  timeoutMs?: number
  /** Maximum captured bytes per `glab` output stream and combined JSON bytes of one complete check read or review read. */
  maxOutputBytes?: number
  /** Most review threads one review read returns, which reports itself truncated past it. */
  maxReviewThreads?: number
  /** Most commits one merge request commit listing returns, the oldest ones when there are more. */
  maxCommits?: number
  /** Most merge requests one status query reads; GitLab refuses a query over its complexity limit, which halves the batch. */
  statusBatchSize?: number
  /** Most `glab` processes one status fetch runs at once. */
  maxConcurrentRequests?: number
  /** Most bytes of diff version patches kept in memory for the hunks of outdated review threads. */
  maxCachedVersionBytes?: number
}

export const Config: z<Config> = z.object({
  glabCommand: z.string().default('glab'),
  hosts: z.array(z.string()).default(['gitlab.com']),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
  maxReviewThreads: z.number().default(1_000),
  maxCommits: z.number().default(250),
  statusBatchSize: z.number().default(2),
  maxConcurrentRequests: z.number().default(4),
  maxCachedVersionBytes: z.number().default(16_777_216),
})

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.glabCommand.trim().length === 0) throw new Error('forge-gitlab: glabCommand must not be empty')
  if (resolved.hosts.length === 0) throw new Error('forge-gitlab: hosts must list at least one host')
  for (const host of resolved.hosts) {
    if (!HOST.test(host)) throw new Error(`forge-gitlab: invalid host ${JSON.stringify(host)}`)
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`forge-gitlab: timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const key of ['maxOutputBytes', 'maxReviewThreads', 'maxCommits', 'statusBatchSize', 'maxConcurrentRequests', 'maxCachedVersionBytes'] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-gitlab: ${key} must be a positive safe integer`)
  }
  ctx.forge.register(new GitLabProvider(glabRunner(resolved), resolved.hosts, resolved))
  ctx.inject(['forgeSession'], (scope) => {
    scope.forgeSession.registerCommands(GLAB_COMMANDS)
  })
}
