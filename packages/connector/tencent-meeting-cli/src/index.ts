/**
 * Tencent Meeting plugin: tells the model the managed tmeet's absolute path, registers its skill over the upstream guide
 * it downloads, and serves the Plugins page's account operations over Remote. The CLI's default sign-in is shared with
 * the user's own terminal.
 * @module @deepseek-ai/dsh-tencent-meeting-cli
 */

/* jscpd:ignore-start -- CLI app plugins compose the same kit, Remote, and skill-loading imports. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, registerCliPathContext, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import { registerUpstreamSkills, UpstreamSkillsConfig } from '@deepseek-ai/dsh-upstream-skills'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { TencentMeetingAccount } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './directory.ts'
import { ENTRY, TMEET_SKILLS } from './skills.ts'
import type { TencentMeetingState } from './types.ts'
/* jscpd:ignore-end */

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Tencent Meeting account operations for the Plugins page. */
    tencentMeeting: TencentMeeting
  }
}

/** Where tmeet and the upstream guide come from, a command's deadline, and a download's time limit. */
export type Config = CliAccountConfig & UpstreamSkillsConfig

/** Registers the CLI and its skill, and owns the account operations the Plugins page drives. */
export default class TencentMeeting extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'systemPrompt']
  static Config: z<Config> = z.intersect([CliAccountConfig, UpstreamSkillsConfig])

  private readonly account: TencentMeetingAccount

  /**
   * @param ctx - Context carrying the skill registry, subprocess runtime, and system prompt.
   * @param config - CLI location, command deadline, and where the upstream guide comes from.
   * @throws when this platform has no packaged `tmeet`, `tmeet` is not executable, or `skillsDir` is not a directory.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tencentMeeting')
    const executable = resolveCliExecutable(config.binDir)
    registerCliPathContext(ctx, { name: 'tencent-meeting:cli', product: 'Tencent Meeting', program: PROGRAM, executable })
    const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable, commandTimeoutMs: config.commandTimeoutMs })
    const skills = registerUpstreamSkills(ctx, { name: 'tencent-meeting', entry: ENTRY, set: TMEET_SKILLS, config })
    this.account = new TencentMeetingAccount(cli, ctx.logger, skills)
    ctx.effect(() => () => this.account.dispose())
    ctx.effect(() => skills.watch((state) => { this.account.showSkills(state) }))
  }

  /* jscpd:ignore-start -- CLI app plugins declare the same Remote methods, each delegating to its own account runtime. */
  /**
   * Check the account again without changing it.
   * @returns the operation identity.
   * @throws while another operation runs.
   */
  @Remote
  check(): CliOperationId {
    return this.account.start('check')
  }

  /**
   * Sign in through the CLI's authorization page.
   * @returns the operation identity.
   * @throws while another operation runs.
   */
  @Remote
  signIn(): CliOperationId {
    return this.account.start('sign-in')
  }

  /**
   * Sign the default account out, which also signs out the user's own terminal.
   * @returns the operation identity.
   * @throws while another operation runs.
   */
  @Remote
  signOut(): CliOperationId {
    return this.account.start('sign-out')
  }

  /**
   * Cancel a sign-in while it waits for the user's authorization, and wait for its command to exit.
   * @param id - the operation to cancel; a finished one or another step is ignored.
   * @returns after the operation settles, or at once when nothing is cancelled.
   */
  @Remote
  cancel(id: CliOperationId): Promise<void> {
    return this.account.cancel(id)
  }

  /**
   * Follow the account and its operations independently of any page; each new subscriber starts a check when none runs.
   * @param signal - the Client's observation lifetime.
   * @returns the current view, then each changed view.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<TencentMeetingState> {
    yield* this.account.follow(signal)
  }
  /* jscpd:ignore-end */
}
