/**
 * Tencent Meeting plugin: registers the `tencent-meeting` entry skill with `ctx.upstreamSkills`, which downloads the
 * upstream guide it indexes, and registers the managed tmeet and its account with `ctx.cliAccounts`, which tells the
 * model the CLI's absolute path once the guide is in place and shows the account on the Plugins page. The CLI's default
 * sign-in is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-tencent-meeting
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-upstream-skills'
import { perform } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './directory.ts'
import { dictionaries, type TencentMeetingTextKey } from './locales.ts'
import { copy, operations, presentAccount, TENCENT_MEETING_PACKAGE } from './presentation.ts'
import { ENTRY, TMEET_SKILLS } from './skills.ts'
import type { TencentMeetingAccountState, TencentMeetingCommand, TencentMeetingOperationKind, TencentMeetingPhase } from './types.ts'

/** Plugin name. */
export const name = 'tencent-meeting'

/* jscpd:ignore-start -- CLI app plugins with downloaded guides declare the same services, config, and registration. */
/** Services the CLI's account and the entry skill register with. */
export const inject = ['cliAccounts', 'upstreamSkills']

/** Where tmeet and the upstream guide are. */
export interface Config {
  /** Absolute directory holding the `tmeet` executable; defaults to the installed `@tencentcloud/tmeet` executable for this platform. */
  binDir?: string
  /** Absolute directory holding the upstream guide at its repository paths; when set, nothing is downloaded. */
  skillsDir?: string
}

/** Validates {@link Config}. */
export const Config: z<Config> = z.object({
  binDir: z.string().min(1),
  skillsDir: z.string().min(1),
})

/**
 * Register the entry skill, and the CLI with its account, whose check first waits for the guide's download.
 * @param ctx - Context carrying the CLI account Service and the upstream skills Service.
 * @param config - CLI location and the guide's directory.
 * @throws when this platform has no packaged `tmeet`, `tmeet` is not executable, or `skillsDir` is not a directory.
 */
export function apply(ctx: Context, config: Config): void {
  const executable = resolveCliExecutable(config.binDir)
  const guides = ctx.upstreamSkills.register({ name, entry: ENTRY, set: TMEET_SKILLS, skillsDir: config.skillsDir })
  ctx.cliAccounts.register<
    TencentMeetingAccountState, TencentMeetingOperationKind, TencentMeetingPhase, TencentMeetingCommand, TencentMeetingTextKey
  >({
    name,
    packageName: TENCENT_MEETING_PACKAGE,
    cli: { product: 'Tencent Meeting', program: PROGRAM, executable },
    prepare: {
      phase: 'downloading',
      unprepared: { state: 'not-installed' },
      ready: () => guides.installed(),
      run: signal => guides.install(signal),
    },
    account: { state: 'unchecked' },
    check: 'check',
    cancellable: ['downloading', 'authorizing'],
    authorizationHosts: ['meeting.tencent.com'],
    perform,
    dictionaries,
    operations,
    copy,
    present: presentAccount,
  })
}
/* jscpd:ignore-end */
