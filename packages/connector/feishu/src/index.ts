/**
 * Feishu plugin: registers the managed lark-cli and its account with `ctx.cliAccounts`, which tells the model the CLI's
 * absolute path and shows the account on the Plugins page, and lists the packaged `feishu` skill that indexes the
 * guides embedded in that CLI. The CLI's default account is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-feishu
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-skill'
import { perform } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './cli.ts'
import { dictionaries, type FeishuTextKey } from './locales.ts'
import { copy, FEISHU_PACKAGE, operations, presentAccount } from './presentation.ts'
import { FeishuSkillProvider } from './skills.ts'
import type { FeishuAccountState, FeishuCommand, FeishuOperationKind, FeishuPhase } from './types.ts'

/** Plugin name. */
export const name = 'feishu'

/** Services the CLI's account and its skill register with. */
export const inject = ['cliAccounts', 'skills']

/** The packaged entry skill; the guides it indexes stay in the CLI. */
const ENTRY = fileURLToPath(new URL('../skills/feishu/SKILL.md', import.meta.url))

/** Where lark-cli is. */
export interface Config {
  /** Absolute directory holding the `lark-cli` executable; defaults to the installed `@larksuite/cli` package. */
  binDir?: string
}

/** Validates {@link Config}. */
export const Config: z<Config> = z.object({
  binDir: z.string().min(1),
})

/**
 * Register the CLI with its account, and the skill.
 * @param ctx - Context carrying the CLI account Service and the skill registry.
 * @param config - CLI location.
 * @throws when `lark-cli` is not executable, or the packaged entry skill has no name or description.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.cliAccounts.register<FeishuAccountState, FeishuOperationKind, FeishuPhase, FeishuCommand, FeishuTextKey>({
    name,
    packageName: FEISHU_PACKAGE,
    cli: { product: 'Feishu', program: PROGRAM, executable: resolveCliExecutable(config.binDir) },
    account: { state: 'unchecked' },
    check: 'check',
    cancellable: ['configuring', 'authorizing'],
    authorizationHosts: ['feishu.cn', 'larksuite.com'],
    perform,
    dictionaries,
    operations,
    copy,
    present: presentAccount,
  })
  ctx.skills.registerProvider(() => new FeishuSkillProvider(ENTRY))
}
