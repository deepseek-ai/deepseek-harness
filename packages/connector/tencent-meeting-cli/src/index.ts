/**
 * Tencent Meeting plugin: tells the model the managed tmeet's absolute path, registers its skill, and serves the
 * Plugins page's account operations over Remote. The CLI's default sign-in is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-tencent-meeting-cli
 */

/* jscpd:ignore-start -- CLI app plugins compose the same kit, Remote, and skill-loading imports. */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, registerCliPathContext, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { TencentMeetingAccount } from './account.ts'
import { PROGRAM, resolveCliExecutable } from './directory.ts'
import type { TencentMeetingState } from './types.ts'
/* jscpd:ignore-end */

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Tencent Meeting account operations for the Plugins page. */
    tencentMeeting: TencentMeeting
  }
}

/** Where tmeet is and how long a command that does not wait for the user may run. */
export type Config = CliAccountConfig

/** Registers the CLI and its skill, and owns the account operations the Plugins page drives. */
export default class TencentMeeting extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'systemPrompt']
  static Config: z<Config> = CliAccountConfig

  private readonly account: TencentMeetingAccount

  /**
   * @param ctx - Context carrying the skill registry, subprocess runtime, and system prompt.
   * @param config - CLI location and command deadline.
   * @throws when this platform has no packaged `tmeet` or `tmeet` is not executable.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'tencentMeeting')
    const executable = resolveCliExecutable(config.binDir)
    registerCliPathContext(ctx, { name: 'tencent-meeting:cli', product: 'Tencent Meeting', program: PROGRAM, executable })
    const cli = new CliCommandExecutor(ctx.subprocess, { program: PROGRAM, executable, commandTimeoutMs: config.commandTimeoutMs })
    this.account = new TencentMeetingAccount(cli, ctx.logger)
    ctx.effect(() => () => this.account.dispose())
    ctx.plugin(SkillFilesystem, {
      providerName: 'tencent-meeting',
      includeDefaultRoots: false,
      watch: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
    })
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
