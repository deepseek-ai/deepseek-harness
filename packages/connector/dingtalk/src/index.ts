/**
 * DingTalk plugin: installs dws and its upstream skills from the pinned release into the DSH cache, registers dws and
 * its account with `ctx.cliAccounts`, which tells the model dws's absolute path once both are installed and shows the
 * account on the Plugins page, and registers the `dingtalk` skill once its root is published. In a profile, the
 * release in place replaces the earlier ones in that profile's cache directory. The CLI's sign-in is shared with the
 * user's own terminal.
 * @module @deepseek-ai/dsh-dingtalk
 */

/* jscpd:ignore-start -- CLI app plugins compose the same Service, registry, and skill-loading imports. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
// Declares `Context.profileContext`, the launcher-provided profile that owns the downloads.
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-skill'
import { createPerform } from './account.ts'
import { dictionaries, type DingtalkTextKey } from './locales.ts'
import { copy, DINGTALK_PACKAGE, operations, presentAccount } from './presentation.ts'
import { DwsRelease, executableFileName, PROGRAM } from './release.ts'
import type { DingtalkAccountState, DingtalkCommand, DingtalkOperationKind, DingtalkPhase } from './types.ts'
/* jscpd:ignore-end */

/** Plugin name. */
export const name = 'dingtalk'

/** Services the CLI's account and its skill register with. */
export const inject = ['cliAccounts', 'skills']

/** Where dws and its skills come from, and how long one download may take. */
export interface Config {
  /** Absolute directory holding the `dws` executable; when set, dws is not downloaded. */
  binDir?: string
  /** Directory holding the upstream skills laid out as `multi/` in the release's `dws-skills.zip`; when set, they are not downloaded. */
  skillsDir?: string
  /** Release download prefixes tried in order for what `binDir` and `skillsDir` do not provide; each serves `v<version>/<asset name>`. */
  releaseUrls: string[]
  /** How long one prefix may take to deliver an asset before the next one is tried. */
  releaseTimeoutMs: number
}

/** Refuse a download prefix that the pattern admits but that does not parse as a URL, such as `https://[`. */
function parsedUrl(value: string): string {
  if (!URL.canParse(value)) throw new Error(`releaseUrls: ${value} is not a URL`)
  return value
}

/** Validates {@link Config}. */
export const Config: z<Config> = z.object({
  binDir: z.string().min(1),
  skillsDir: z.string().min(1),
  releaseUrls: z.array(z.transform(z.string().pattern(/^https:\/\/[^\s?#@]+$/), parsedUrl)).min(1).default([
    'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download',
    'https://gitee.com/dingtalk-real-ai/dingtalk-workspace-cli/releases/download',
  ]),
  releaseTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(300_000),
})

/**
 * Register dws with its account, and its skill, and start preparing both.
 * @param ctx - Context carrying the CLI account Service and the skill registry.
 * @param config - dws and skills locations, and download prefixes.
 * @throws when `binDir` holds no executable `dws`, `skillsDir` is not a directory, the pinned release has no archive for
 *   this platform, or the skill root cannot be written.
 */
export function apply(ctx: Context, config: Config): void {
  const { binDir, skillsDir, releaseUrls, releaseTimeoutMs } = config
  const release = new DwsRelease({ binDir, skillsDir, releaseUrls, releaseTimeoutMs, profile: ctx.get('profileContext') }, ctx.logger)
  const account = ctx.cliAccounts.register<DingtalkAccountState, DingtalkOperationKind, DingtalkPhase, DingtalkCommand, DingtalkTextKey>({
    name,
    packageName: DINGTALK_PACKAGE,
    cli: {
      product: 'DingTalk', program: PROGRAM, executable: join(release.directory, executableFileName(process.platform)),
      scripts: true,
    },
    prepare: {
      phase: 'downloading',
      unprepared: { state: 'not-installed' },
      ready: () => release.installed(),
      run: signal => release.install(signal),
    },
    account: { state: 'unchecked' },
    check: 'check',
    cancellable: ['downloading', 'authorizing'],
    authorizationHosts: ['login.dingtalk.com'],
    perform: createPerform(),
    dictionaries,
    operations,
    copy,
    present: presentAccount,
  })
  // Watched: the first download publishes the root after the catalog may have been listed.
  ctx.plugin(SkillFilesystem, {
    providerName: 'dingtalk',
    includeDefaultRoots: false,
    watch: true,
    bundledSkillDir: release.skillRoot,
  })
  // Prepare dws and its skills without waiting for the Plugins page, so a session without a browser finds them.
  account.refresh()
  // A release already in place runs no installation, so the ones it replaces are deleted here.
  void release.prune()
}
