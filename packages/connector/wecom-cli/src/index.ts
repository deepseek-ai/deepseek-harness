/**
 * WeCom plugin: tells the model the managed wecom-cli's absolute path, registers
 * the `wecom` skill over the upstream guides it downloads, and serves the Plugins
 * page's authorization over Remote. The CLI's authorization is shared with the
 * user's own terminal.
 * @module @deepseek-ai/dsh-wecom-cli
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, registerCliPathContext, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import { registerUpstreamSkills, UpstreamSkillsConfig } from '@deepseek-ai/dsh-upstream-skills'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { WecomAccount } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './directory.ts'
import { ENTRY, WECOM_SKILLS } from './skills.ts'
import type { WecomState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** WeCom authorization for the Plugins page. */
    wecom: Wecom
  }
}

/** Where wecom-cli and the upstream guides come from, a command's deadline, and a download's time limit. */
export type Config = CliAccountConfig & UpstreamSkillsConfig

/** Registers the CLI and skills, and owns the authorization operations the Plugins page drives. */
export default class Wecom extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'systemPrompt']
  static Config: z<Config> = z.intersect([CliAccountConfig, UpstreamSkillsConfig])

  private readonly account: WecomAccount

  /**
   * @param ctx - Context carrying the skill registry, subprocess runtime, and system prompt.
   * @param config - CLI location, command deadline, and where the upstream guides come from.
   * @throws when `wecom-cli` is not executable or `skillsDir` is not a directory.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'wecom')
    const executable = resolveCliExecutable(config.binDir)
    registerCliPathContext(ctx, { name: 'wecom:cli', product: 'WeCom', program: PROGRAM, executable, scripts: true })
    const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable, commandTimeoutMs: config.commandTimeoutMs })
    const skills = registerUpstreamSkills(ctx, { name: 'wecom', entry: ENTRY, set: WECOM_SKILLS, config })
    this.account = new WecomAccount(cli, ctx.logger, skills)
    ctx.effect(() => () => this.account.dispose())
    ctx.effect(() => skills.watch((state) => { this.account.showSkills(state) }))
  }

  /**
   * Check the authorization again without changing it.
   * @returns the operation identity.
   * @throws while another operation runs.
   */
  @Remote
  check(): CliOperationId {
    return this.account.start('check')
  }

  /**
   * Bind a bot through the CLI's QR-code page.
   * @returns the operation identity.
   * @throws while another operation runs.
   */
  @Remote
  connect(): CliOperationId {
    return this.account.start('connect')
  }

  /**
   * Cancel one operation while it waits for the QR-code scan, and wait for its command to exit.
   * @param id - the operation to cancel; a finished one or another step is ignored.
   * @returns after the operation settles, or at once when nothing is cancelled.
   */
  @Remote
  cancel(id: CliOperationId): Promise<void> {
    return this.account.cancel(id)
  }

  /**
   * Follow the authorization and its operations independently of any page; each new subscriber starts a check when none runs.
   * @param signal - the Client's observation lifetime.
   * @returns the current view, then each changed view.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<WecomState> {
    yield* this.account.follow(signal)
  }
}
