/**
 * Feishu plugin: tells the model the managed lark-cli's absolute path, lists the
 * packaged `feishu` skill that indexes the guides embedded in that CLI, and shows the account on the Plugins page
 * through the connector account registry. The CLI's default account is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-feishu
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, registerCliPathContext } from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-client-ui-connector-account'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { FeishuAccount } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './cli.ts'
import { COPY, FEISHU_PACKAGE, OPERATIONS, presentAccount } from './presentation.ts'
import { FeishuSkillProvider } from './skills.ts'

export type * from './types.ts'

/** Plugin name. */
export const name = 'feishu'

/** Services the CLI, its skill, and its runtime context need. */
export const inject = ['skills', 'subprocess', 'systemPrompt']

/** The packaged entry skill; the guides it indexes stay in the CLI. */
const ENTRY = fileURLToPath(new URL('../skills/feishu/SKILL.md', import.meta.url))

/** Where lark-cli is and how long a command that does not wait for the user may run. */
export type Config = CliAccountConfig

/** Validates {@link Config}. */
export const Config: z<Config> = CliAccountConfig

/**
 * Register the CLI and its skill, and show the account on the Plugins page while the connector account registry runs.
 * @param ctx - Context carrying the skill registry, subprocess runtime, and system prompt.
 * @param config - CLI location and command deadline.
 * @throws when `lark-cli` is not executable, or the packaged entry skill has no name or description.
 */
export function apply(ctx: Context, config: Config): void {
  const executable = resolveCliExecutable(config.binDir)
  registerCliPathContext(ctx, { name: 'feishu:cli', product: 'Feishu', program: PROGRAM, executable })
  const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable, commandTimeoutMs: config.commandTimeoutMs })
  const account = new FeishuAccount(cli, ctx.logger)
  ctx.effect(() => () => account.dispose(), 'feishu: account')
  ctx.skills.registerProvider(() => new FeishuSkillProvider(ENTRY))
  ctx.inject(['connectorAccounts'], (scope) => {
    scope.effect(() => scope.connectorAccounts.register({
      key: FEISHU_PACKAGE, packageName: FEISHU_PACKAGE, source: account, operations: OPERATIONS, copy: COPY, present: presentAccount,
    }), 'feishu: Plugins page account')
  })
}
