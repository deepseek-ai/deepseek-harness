/**
 * Registers the GitLab provider of `ctx.forge`, which reads merge requests through the GitLab CLI on the host, and,
 * while forge-session runs, the `glab` commands that bind merge requests to a Session.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event and the optional `settings` service.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import type {} from '@deepseek-ai/dsh-experimental-forge-session'
import type {} from '@deepseek-ai/dsh-settings'
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
  /**
   * Host names this provider serves, at least one; list self-managed GitLab hosts explicitly. Editable live: the
   * provider registers again with the new list.
   */
  hosts: Volatile<string[]>
  /** Deadline in milliseconds for one `glab` invocation. */
  timeoutMs?: number
  /** Maximum captured bytes per `glab` output stream and combined JSON bytes of one complete check read or review read. */
  maxOutputBytes?: number
  /** Most review threads one review read returns, which reports itself truncated past it. */
  maxReviewThreads?: number
  /** Most commits one merge request commit listing returns, the oldest ones when there are more. */
  maxCommits?: number
  /**
   * Most merge requests one status query reads, 1 by default: in a query that reads several, GitLab 19.5 reports a
   * mergeable merge request after the first as conflicting. GitLab refuses a query over its complexity limit, which
   * halves the batch.
   */
  statusBatchSize?: number
  /** Most `glab` processes one status fetch runs at once. */
  maxConcurrentRequests?: number
  /** Most bytes of diff version patches kept in memory for the hunks of outdated review threads. */
  maxCachedVersionBytes?: number
}

/** A host name with an optional port, as `hosts` lists it. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

export const Config = z.object({
  glabCommand: z.string().default('glab'),
  hosts: z.array(z.string().pattern(HOST)).min(1).default(['gitlab.com']).volatile(),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
  maxReviewThreads: z.number().default(1_000),
  maxCommits: z.number().default(250),
  // One merge request per query. GitLab 19.5.1 answers `detailedMergeStatus: CONFLICT` for a mergeable merge request at
  // every alias after the first of one query when the aliases select `diffStatsSummary`, while the same answer carries
  // `mergeStatusEnum: CAN_BE_MERGED` and `conflicts: false`; read alone, the merge request answers `MERGEABLE`. A larger
  // default suits only GitLab versions on which a query of two such aliases answers `MERGEABLE` for both.
  statusBatchSize: z.number().default(1),
  maxConcurrentRequests: z.number().default(4),
  maxCachedVersionBytes: z.number().default(16_777_216),
})

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.glabCommand.trim().length === 0) throw new Error('forge-gitlab: glabCommand must not be empty')
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`forge-gitlab: timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const key of ['maxOutputBytes', 'maxReviewThreads', 'maxCommits', 'statusBatchSize', 'maxConcurrentRequests', 'maxCachedVersionBytes'] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-gitlab: ${key} must be a positive safe integer`)
  }
  const glab = glabRunner(resolved)
  /* jscpd:ignore-start -- the GitLab and GitHub providers wire their own registration; no package below both holds plugin wiring. */
  const provider = (): GitLabProvider => new GitLabProvider(glab, resolved.hosts.get(), resolved)
  const registration = ctx.forge.register(provider())
  // A list the registry refuses, because the GitHub provider serves one of its hosts, throws here: the Loader logs it
  // and the previous list keeps being served.
  ctx.on('loader/volatile-update', () => { registration.replace(provider()) })
  // The Forge panel draws the host list on this row's Plugins page.
  ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
  /* jscpd:ignore-end */
  ctx.inject(['forgeSession'], (scope) => {
    scope.forgeSession.registerCommands(GLAB_COMMANDS)
  })
}
