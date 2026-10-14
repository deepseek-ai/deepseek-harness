/**
 * Feishu plugin: puts the managed lark-cli on the private Shell PATH, registers
 * its embedded skills, and serves the Plugins page's account operations over
 * Remote. The CLI's default account is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { FeishuAccount } from './account.ts'
import { PROGRAM, resolveCliDirectory } from './cli.ts'
import { commandFailure } from './diagnostic.ts'
import { FeishuSkillProvider } from './skills.ts'
import type { FeishuState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Feishu account operations for the Plugins page. */
    feishu: Feishu
  }
}

export type Config = CliAccountConfig

/** Registers the CLI and skills, and owns the account operations the Plugins page drives. */
export default class Feishu extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'shellEnv']
  static Config: z<Config> = CliAccountConfig

  private readonly account: FeishuAccount

  /**
   * @param ctx - Context carrying the skill registry, subprocess runtime, and Shell environment.
   * @param config - CLI location and command limits.
   * @throws when the subprocess runtime does not run on this Host or `lark-cli` is not executable.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'feishu')
    if (!ctx.subprocess.runsOnHost) {
      throw new Error('feishu: lark-cli and its default account are local to this Host; mount a Host subprocess runtime')
    }
    ctx.shellEnv.registerPath({ name: 'feishu', directories: [resolveCliDirectory(config.binDir)] })
    const cli = new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: config.commandTimeoutMs })
    this.account = new FeishuAccount({
      name: 'feishu',
      cli,
      logger: ctx.logger,
      account: { state: 'unchecked' },
      check: 'check',
      cancellable: ['configuring', 'authorizing'],
      authorizationHosts: ['feishu.cn', 'larksuite.com'],
      classify: commandFailure,
    })
    ctx.effect(() => () => this.account.dispose())
    ctx.skills.registerProvider(control => new FeishuSkillProvider(cli, control, ctx.logger))
  }

  /**
   * Check the account again without changing it.
   * @returns the operation identity.
   * @throws while another account operation runs.
   */
  @Remote
  check(): CliOperationId {
    return this.account.start('check')
  }

  /**
   * Link an app through the CLI's setup page, replacing a configured app and its sign-ins.
   * @returns the operation identity.
   * @throws while another account operation runs.
   */
  @Remote
  linkApp(): CliOperationId {
    return this.account.start('link-app')
  }

  /**
   * Sign the linked app's user in through the CLI's authorization page.
   * @returns the operation identity.
   * @throws while another account operation runs.
   */
  @Remote
  signIn(): CliOperationId {
    return this.account.start('sign-in')
  }

  /**
   * Sign the default account out, which also signs out the user's own terminal.
   * @returns the operation identity.
   * @throws while another account operation runs.
   */
  @Remote
  signOut(): CliOperationId {
    return this.account.start('sign-out')
  }

  /**
   * Cancel one operation and wait for its command to exit.
   * @param id - the operation to cancel; a finished one is ignored.
   * @returns after the operation settles.
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
  async *follow(signal: AbortSignal): AsyncIterable<FeishuState> {
    yield* this.account.follow(signal)
  }
}
