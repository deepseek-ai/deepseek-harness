/**
 * Tencent Meeting plugin: tells the model the managed tmeet's absolute path, registers its skill over the upstream guide
 * it downloads, and shows the account on the Plugins page through the connector account registry. The CLI's default sign-in is
 * shared with the user's own terminal.
 * @module @deepseek-ai/dsh-tencent-meeting-cli
 */

/* jscpd:ignore-start -- CLI app plugins compose the same kit, registry, and skill-loading imports. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, registerCliPathContext } from '@deepseek-ai/dsh-cli-account'
import { registerUpstreamSkills, UpstreamSkillsConfig } from '@deepseek-ai/dsh-upstream-skills'
import type {} from '@deepseek-ai/dsh-client-ui-connector-account'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { TencentMeetingAccount } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './directory.ts'
import { COPY, OPERATIONS, presentAccount, TENCENT_MEETING_PACKAGE } from './presentation.ts'
import { ENTRY, TMEET_SKILLS } from './skills.ts'
/* jscpd:ignore-end */

export type * from './types.ts'

/** Plugin name. */
export const name = 'tencent-meeting'

/* jscpd:ignore-start -- CLI app plugins with downloaded guides declare the same services, config, and registration. */
/** Services the CLI, its skill, and its runtime context need. */
export const inject = ['skills', 'subprocess', 'systemPrompt']

/** Where tmeet and the upstream guide come from, a command's deadline, and a download's time limit. */
export type Config = CliAccountConfig & UpstreamSkillsConfig

/** Validates {@link Config}. */
export const Config: z<Config> = z.intersect([CliAccountConfig, UpstreamSkillsConfig])

/**
 * Register the CLI and its skill, and show the account on the Plugins page while the connector account registry runs.
 * @param ctx - Context carrying the skill registry, subprocess runtime, and system prompt.
 * @param config - CLI location, command deadline, and where the upstream guide comes from.
 * @throws when this platform has no packaged `tmeet`, `tmeet` is not executable, or `skillsDir` is not a directory.
 */
export function apply(ctx: Context, config: Config): void {
  const executable = resolveCliExecutable(config.binDir)
  registerCliPathContext(ctx, { name: 'tencent-meeting:cli', product: 'Tencent Meeting', program: PROGRAM, executable })
  const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable, commandTimeoutMs: config.commandTimeoutMs })
  const skills = registerUpstreamSkills(ctx, { name: 'tencent-meeting', entry: ENTRY, set: TMEET_SKILLS, config })
  const account = new TencentMeetingAccount(cli, ctx.logger, skills)
  ctx.effect(() => () => account.dispose(), 'tencent-meeting: account')
  ctx.effect(() => skills.watch((state) => { account.showSkills(state) }), 'tencent-meeting: guide')
  ctx.inject(['connectorAccounts'], (scope) => {
    scope.effect(() => scope.connectorAccounts.register({
      key: TENCENT_MEETING_PACKAGE, packageName: TENCENT_MEETING_PACKAGE,
      source: account, operations: OPERATIONS, copy: COPY, present: presentAccount,
    }), 'tencent-meeting: Plugins page account')
  })
}
/* jscpd:ignore-end */
