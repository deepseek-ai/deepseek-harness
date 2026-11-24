/**
 * Registers the GitHub provider of `ctx.forge`, which reads pull requests through the GitHub CLI on the host, and, while
 * forge-session runs, the `gh` commands that bind pull requests to a Session.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event and the optional `settings` service.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-experimental-forge'
import type {} from '@deepseek-ai/dsh-experimental-forge-session'
import type {} from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { GH_COMMANDS } from './commands.ts'
import { ghRunner } from './gh.ts'
import { GitHubProvider } from './provider.ts'

export const name = 'forge-github'
export const inject = ['forge']

/** GitHub CLI executable, served hosts, and invocation limits. */
export interface Config {
  /** GitHub CLI executable name or absolute host path. */
  ghCommand?: string
  /**
   * Host names this provider serves, at least one; list GitHub Enterprise hosts explicitly. Editable live: the
   * provider registers again with the new list.
   */
  hosts: Volatile<string[]>
  /** Deadline in milliseconds for one `gh` invocation. */
  timeoutMs?: number
  /** Maximum captured bytes per `gh` output stream and combined JSON bytes of one complete check read or review read. */
  maxOutputBytes?: number
  /**
   * Most review threads counted per pull request in one status read, which reports a lower bound past it, and read in
   * one review read, which reports itself truncated past it.
   */
  maxReviewThreads?: number
  /**
   * Most pull requests one snapshot query reads. The forge registry polls that many pull requests of a host per call,
   * each call within its own fetch deadline; a read of more pull requests on one host sends several queries in turn.
   */
  snapshotBatchSize?: number
  /** The same bound for one brief query. */
  briefBatchSize?: number
  /** Most commits one pull request commit listing returns; GitHub lists at most 250 commits of a pull request. */
  maxCommits?: number
  /** Most files whose viewed marks one read lists; GitHub lists at most 3,000 files of a pull request. */
  maxViewedFiles?: number
  /** Most pull requests one viewer list read returns, at most 100, the size of one GitHub search page. */
  maxViewerItems?: number
}

/** A host name with an optional port, as `hosts` lists it. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i

export const Config = z.object({
  ghCommand: z.string().default('gh'),
  hosts: z.array(z.string().pattern(HOST)).min(1).default(['github.com']).volatile(),
  timeoutMs: z.number().default(30_000),
  maxOutputBytes: z.number().default(8_388_608),
  maxReviewThreads: z.number().default(1_000),
  snapshotBatchSize: z.number().default(8),
  briefBatchSize: z.number().default(25),
  maxCommits: z.number().default(250),
  maxViewedFiles: z.number().default(3_000),
  maxViewerItems: z.number().default(50),
})

/** Most results one GitHub search page returns. */
const SEARCH_PAGE = 100

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (resolved.ghCommand.trim().length === 0) throw new Error('forge-github: ghCommand must not be empty')
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0 || resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`forge-github: timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  for (const key of [
    'maxOutputBytes', 'maxReviewThreads', 'snapshotBatchSize', 'briefBatchSize', 'maxCommits', 'maxViewedFiles', 'maxViewerItems',
  ] as const) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] <= 0) throw new Error(`forge-github: ${key} must be a positive safe integer`)
  }
  if (resolved.maxViewerItems > SEARCH_PAGE) throw new Error(`forge-github: maxViewerItems must be no greater than ${SEARCH_PAGE}`)
  const gh = ghRunner(resolved)
  const provider = (): GitHubProvider => new GitHubProvider(gh, resolved.hosts.get(), resolved)
  const registration = ctx.forge.register(provider())
  // A list the registry refuses, because the GitLab provider serves one of its hosts, throws here: the Loader logs it
  // and the previous list keeps being served.
  ctx.on('loader/volatile-update', () => { registration.replace(provider()) })
  // The Forge panel draws the host list on this row's Plugins page.
  ctx.inject(['settings'], (scope) => { scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.inject(['forgeSession'], (scope) => {
    scope.forgeSession.registerCommands(GH_COMMANDS)
  })
}
