/**
 * Feishu plugin: registers the managed lark-cli and its account with `ctx.cliAccounts`, which tells the model the CLI's
 * absolute path once the CLI is installed and shows the account on the Plugins page, and lists the packaged `feishu`
 * skill that indexes the guides embedded in that CLI. An installation whose `@larksuite/cli` install script did not run
 * has no lark-cli: the plugin then downloads it after loading. The CLI's default account is shared with the user's own
 * terminal.
 * @module @deepseek-ai/dsh-feishu
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { perform } from './account.ts'
import { LarkCli, PROGRAM } from './cli.ts'
import { dictionaries, type FeishuTextKey } from './locales.ts'
import { copy, FEISHU_PACKAGE, operations, presentAccount } from './presentation.ts'
import { FeishuSkillProvider } from './skills.ts'
import type { FeishuAccountState, FeishuCommand, FeishuOperationKind, FeishuPhase } from './types.ts'

/** Plugin name. */
export const name = 'feishu'

/** Services the CLI's account and its skill register with, and the one that runs the CLI's install script. */
export const inject = ['cliAccounts', 'skills', 'subprocess']

/** The packaged entry skill; the guides it indexes stay in the CLI. */
const ENTRY = fileURLToPath(new URL('../skills/feishu/SKILL.md', import.meta.url))

/** Where lark-cli is. */
export interface Config {
  /**
   * Absolute directory holding the `lark-cli` executable, which the plugin then never downloads. Defaults to the
   * installed `@larksuite/cli` package.
   */
  binDir?: string
}

/** Validates {@link Config}. */
export const Config: z<Config> = z.object({
  binDir: z.string().min(1),
})

/**
 * Register the CLI with its account, and the skill, and start downloading a missing CLI.
 * @param ctx - Context carrying the CLI account Service, the skill registry, and the subprocess runtime.
 * @param config - CLI location.
 * @throws when `binDir` holds no executable `lark-cli`, or the packaged entry skill has no name or description.
 */
export function apply(ctx: Context, config: Config): void {
  const cli = new LarkCli(config.binDir, ctx.subprocess, ctx.logger)
  let skill: FeishuSkillProvider
  ctx.skills.registerProvider((control) => {
    skill = new FeishuSkillProvider(ENTRY, () => cli.installed(), control.invalidate)
    return skill
  })
  const account = ctx.cliAccounts.register<FeishuAccountState, FeishuOperationKind, FeishuPhase, FeishuCommand, FeishuTextKey>({
    name,
    packageName: FEISHU_PACKAGE,
    cli: { product: 'Feishu', program: PROGRAM, executable: cli.executable },
    prepare: {
      phase: 'downloading',
      unprepared: { state: 'not-installed' },
      ready: () => cli.installed(),
      run: async (signal) => {
        // A cancelled or failed install script may already have put lark-cli in place.
        try { await cli.install(signal) } finally { skill.relist() }
      },
    },
    account: { state: 'unchecked' },
    check: 'check',
    cancellable: ['downloading', 'configuring', 'authorizing'],
    authorizationHosts: ['feishu.cn', 'larksuite.com'],
    perform: async (kind, control, signal) => {
      // lark-cli may have been installed outside this plugin's download since the catalog was listed.
      skill.relist()
      await perform(kind, control, signal)
    },
    dictionaries,
    operations,
    copy,
    present: presentAccount,
  })
  // Download a missing lark-cli without waiting for the Plugins page, so a session without a browser gets it.
  if (!cli.installed()) account.refresh()
}
