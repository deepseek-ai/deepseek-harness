/**
 * WeCom plugin: puts the managed wecom-cli on the private Shell PATH, registers
 * its bundled skills, and serves the Plugins page's authorization over Remote.
 * The CLI's authorization is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-wecom-cli
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { WecomAccount } from './account.ts'
import { PROGRAM, resolveCliDirectory } from './directory.ts'
import type { WecomState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** WeCom authorization for the Plugins page. */
    wecom: Wecom
  }
}

/** Where wecom-cli is and how long a command that does not wait for the user may run. */
export type Config = CliAccountConfig

/** Registers the CLI and skills, and owns the authorization operations the Plugins page drives. */
export default class Wecom extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'shellEnv']
  static Config: z<Config> = CliAccountConfig

  private readonly account: WecomAccount

  /**
   * @param ctx - Context carrying the skill registry, subprocess runtime, and Shell environment.
   * @param config - CLI location and command deadline.
   * @throws when the subprocess runtime does not run on this Host or `wecom-cli` is not executable.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'wecom')
    if (!ctx.subprocess.runsOnHost) {
      throw new Error('wecom: wecom-cli and its authorization are local to this Host; mount a Host subprocess runtime')
    }
    ctx.shellEnv.registerPath({ name: 'wecom', directories: [resolveCliDirectory(config.binDir)], programs: [PROGRAM] })
    const cli = new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: config.commandTimeoutMs })
    this.account = new WecomAccount(cli, ctx.logger)
    ctx.effect(() => () => this.account.dispose())
    ctx.plugin(SkillFilesystem, {
      providerName: 'wecom',
      includeDefaultRoots: false,
      watch: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
    })
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
