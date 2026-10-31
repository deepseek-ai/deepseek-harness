/**
 * WeCom plugin: tells the model the managed wecom-cli's absolute path, registers
 * the `wecom` skill over the upstream guides it downloads, and shows the
 * authorization on the Plugins page through the CLI account registry. The CLI's
 * authorization is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-wecom-cli
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, registerCliPathContext } from '@deepseek-ai/dsh-cli-account'
import { registerUpstreamSkills, UpstreamSkillsConfig } from '@deepseek-ai/dsh-upstream-skills'
import type {} from '@deepseek-ai/dsh-client-ui-cli-account'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { WecomAccount } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './directory.ts'
import { COPY, OPERATIONS, presentAccount, WECOM_PACKAGE } from './presentation.ts'
import { ENTRY, WECOM_SKILLS } from './skills.ts'

export type * from './types.ts'

/** Plugin name. */
export const name = 'wecom'

/** Services the CLI, its skills, and its runtime context need. */
export const inject = ['skills', 'subprocess', 'systemPrompt']

/** Where wecom-cli and the upstream guides come from, a command's deadline, and a download's time limit. */
export type Config = CliAccountConfig & UpstreamSkillsConfig

/** Validates {@link Config}. */
export const Config: z<Config> = z.intersect([CliAccountConfig, UpstreamSkillsConfig])

/**
 * Register the CLI and its skills, and show the authorization on the Plugins page while the CLI account registry runs.
 * @param ctx - Context carrying the skill registry, subprocess runtime, and system prompt.
 * @param config - CLI location, command deadline, and where the upstream guides come from.
 * @throws when `wecom-cli` is not executable or `skillsDir` is not a directory.
 */
export function apply(ctx: Context, config: Config): void {
  const executable = resolveCliExecutable(config.binDir)
  registerCliPathContext(ctx, { name: 'wecom:cli', product: 'WeCom', program: PROGRAM, executable, scripts: true })
  const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable, commandTimeoutMs: config.commandTimeoutMs })
  const skills = registerUpstreamSkills(ctx, { name: 'wecom', entry: ENTRY, set: WECOM_SKILLS, config })
  const account = new WecomAccount(cli, ctx.logger, skills)
  ctx.effect(() => () => account.dispose(), 'wecom: account')
  ctx.effect(() => skills.watch((state) => { account.showSkills(state) }), 'wecom: guides')
  ctx.inject(['cliAccounts'], (scope) => {
    scope.effect(() => scope.cliAccounts.register({
      packageName: WECOM_PACKAGE, source: account, operations: OPERATIONS, copy: COPY, present: presentAccount,
    }), 'wecom: Plugins page authorization')
  })
}
