/**
 * WeCom plugin: registers the managed wecom-cli and its authorization with `ctx.cliAccounts`, which tells the model the
 * CLI's absolute path and shows the authorization on the Plugins page, and registers the `wecom` entry skill with
 * `ctx.upstreamSkills`, which downloads the upstream guides it indexes. The CLI's authorization is shared with the
 * user's own terminal.
 * @module @deepseek-ai/dsh-wecom
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-cli-account'
import type {} from '@deepseek-ai/dsh-upstream-skills'
import { performWith } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './directory.ts'
import { dictionaries, type WecomTextKey } from './locales.ts'
import { copy, operations, presentAccount, WECOM_PACKAGE } from './presentation.ts'
import { ENTRY, WECOM_SKILLS } from './skills.ts'
import type { WecomAccountState, WecomCommand, WecomOperationKind, WecomPhase } from './types.ts'

/** Plugin name. */
export const name = 'wecom'

/* jscpd:ignore-start -- CLI app plugins with downloaded guides declare the same services, config, and registration. */
/** Services the CLI's authorization and the entry skill register with. */
export const inject = ['cliAccounts', 'upstreamSkills']

/** Where wecom-cli and the upstream guides are. */
export interface Config {
  /** Absolute directory holding the `wecom-cli` executable; defaults to the installed platform package of `@wecom/cli`. */
  binDir?: string
  /** Absolute directory holding the upstream guides at their repository paths; when set, nothing is downloaded. */
  skillsDir?: string
}

/** Validates {@link Config}. */
export const Config: z<Config> = z.object({
  binDir: z.string().min(1),
  skillsDir: z.string().min(1),
})

/**
 * Register the entry skill, and the CLI with its authorization, whose view follows the guides' download.
 * @param ctx - Context carrying the CLI account Service and the upstream skills Service.
 * @param config - CLI location and the guides' directory.
 * @throws when `wecom-cli` is not executable or `skillsDir` is not a directory.
 */
export function apply(ctx: Context, config: Config): void {
  const executable = resolveCliExecutable(config.binDir)
  const guides = ctx.upstreamSkills.register({ name, entry: ENTRY, set: WECOM_SKILLS, skillsDir: config.skillsDir })
  const account = ctx.cliAccounts.register<WecomAccountState, WecomOperationKind, WecomPhase, WecomCommand, WecomTextKey>({
    name,
    packageName: WECOM_PACKAGE,
    cli: { product: 'WeCom', program: PROGRAM, executable, scripts: true },
    account: { state: 'unchecked', skills: guides.state },
    check: 'check',
    cancellable: ['authorizing'],
    authorizationHosts: ['work.weixin.qq.com'],
    perform: performWith(guides),
    dictionaries,
    operations,
    copy,
    present: presentAccount,
  })
  ctx.effect(() => guides.watch((skills) => { account.publish({ ...account.snapshot().account, skills }) }), 'wecom: guides')
}
/* jscpd:ignore-end */
