/**
 * DingTalk plugin: installs dws and its upstream skills from the pinned release into the DSH cache, tells the model
 * dws's absolute path once both are installed, registers the `dingtalk` skill once its root is published, and shows the
 * account on the Plugins page through the connector account registry. The CLI's sign-in is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-dingtalk-cli
 */

/* jscpd:ignore-start -- CLI app plugins compose the same kit, registry, and skill-loading imports. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, executableFileName, registerCliPathContext } from '@deepseek-ai/dsh-cli-account'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import type {} from '@deepseek-ai/dsh-client-ui-connector-account'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { DingtalkAccount } from './account.ts'
import { COPY, DINGTALK_PACKAGE, OPERATIONS, presentAccount } from './presentation.ts'
import { DwsRelease, PROGRAM } from './release.ts'
/* jscpd:ignore-end */

export type * from './types.ts'

/** Plugin name. */
export const name = 'dingtalk'

/** Services the CLI, its skill, and its runtime context need. */
export const inject = ['skills', 'subprocess', 'systemPrompt']

/** Where dws and its skills come from and how long a command that does not wait for the user may run. */
export interface Config extends CliAccountConfig {
  /** Directory holding the upstream skills laid out as `multi/` in the release's `dws-skills.zip`; when set, they are not downloaded. */
  skillsDir?: string
  /** Release download prefixes tried in order for what `binDir` and `skillsDir` do not provide; each serves `v<version>/<asset name>`. */
  releaseUrls: string[]
}

/** Validates {@link Config}. */
export const Config: z<Config> = z.intersect([
  CliAccountConfig,
  z.object({
    skillsDir: z.string().min(1),
    releaseUrls: z.array(z.string().pattern(/^https:\/\/[^\s?#@]+$/)).min(1).default([
      'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download',
      'https://gitee.com/dingtalk-real-ai/dingtalk-workspace-cli/releases/download',
    ]),
  }),
])

/**
 * Prepare dws and its skill, and show the account on the Plugins page while the connector account registry runs.
 * @param ctx - Context carrying the skill registry, subprocess runtime, and system prompt.
 * @param config - dws and skills locations, download prefixes, and command deadline.
 * @throws when `binDir` holds no executable `dws`, `skillsDir` is not a directory, the pinned release has no archive for
 *   this platform, or the skill root cannot be written.
 */
export function apply(ctx: Context, config: Config): void {
  const release = new DwsRelease(config, ctx.logger)
  const executable = join(release.directory, executableFileName(PROGRAM))
  registerCliPathContext(ctx, {
    name: 'dingtalk:cli', product: 'DingTalk', program: PROGRAM, executable, scripts: true, ready: () => release.installed(),
  })
  const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable, commandTimeoutMs: config.commandTimeoutMs })
  const account = new DingtalkAccount(cli, ctx.logger, release)
  ctx.effect(() => () => account.dispose(), 'dingtalk: account')
  // Watched: the first download publishes the root after the catalog may have been listed.
  ctx.plugin(SkillFilesystem, {
    providerName: 'dingtalk',
    includeDefaultRoots: false,
    watch: true,
    bundledSkillDir: release.skillRoot,
  })
  // Prepare dws and its skills without waiting for the Plugins page, so a session without a browser finds them.
  account.refresh()
  ctx.inject(['connectorAccounts'], (scope) => {
    scope.effect(() => scope.connectorAccounts.register({
      key: DINGTALK_PACKAGE, packageName: DINGTALK_PACKAGE, source: account, operations: OPERATIONS, copy: COPY, present: presentAccount,
    }), 'dingtalk: Plugins page account')
  })
}
