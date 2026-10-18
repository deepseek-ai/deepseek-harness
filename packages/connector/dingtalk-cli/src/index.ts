/**
 * DingTalk plugin: installs dws and its upstream skills from the pinned release into the DSH cache, puts dws on the
 * private Shell PATH, registers the `dingtalk` skill once its root is published, and serves the Plugins page's account
 * operations over Remote. The CLI's sign-in is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-dingtalk-cli
 */

/* jscpd:ignore-start -- CLI app plugins compose the same kit, Remote, and skill-loading imports. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { DingtalkAccount } from './account.ts'
import { DwsRelease, PROGRAM } from './release.ts'
import type { DingtalkState } from './types.ts'
/* jscpd:ignore-end */

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DingTalk account operations for the Plugins page. */
    dingtalk: Dingtalk
  }
}

/** Where dws and its skills come from and how long a command that does not wait for the user may run. */
export interface Config extends CliAccountConfig {
  /** Directory holding the upstream skills laid out as `multi/` in the release's `dws-skills.zip`; when set, they are not downloaded. */
  skillsDir?: string
  /** Release download prefixes tried in order for what `binDir` and `skillsDir` do not provide; each serves `v<version>/<asset name>`. */
  releaseUrls: string[]
}

/** Registers the CLI and its skill, and owns the account operations the Plugins page drives. */
export default class Dingtalk extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'shellEnv']
  static Config: z<Config> = z.intersect([
    CliAccountConfig,
    z.object({
      skillsDir: z.string().min(1),
      releaseUrls: z.array(z.string().pattern(/^https:\/\/[^\s?#@]+$/)).min(1).default([
        'https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download',
        'https://gitee.com/dingtalk-real-ai/dingtalk-workspace-cli/releases/download',
      ]),
    }),
  ])

  private readonly account: DingtalkAccount

  /**
   * @param ctx - Context carrying the skill registry, subprocess runtime, and Shell environment.
   * @param config - dws and skills locations, download prefixes, and command deadline.
   * @throws when the subprocess runtime does not run on this Host, `binDir` holds no executable `dws`, `skillsDir` is not
   *   a directory, the pinned release has no archive for this platform, or the skill root cannot be written.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'dingtalk')
    if (!ctx.subprocess.runsOnHost) {
      throw new Error('dingtalk: dws and its sign-in are local to this Host; mount a Host subprocess runtime')
    }
    const release = new DwsRelease(config, ctx.logger)
    ctx.shellEnv.registerPath({ name: 'dingtalk', directories: [release.directory], programs: [PROGRAM] })
    const cli = new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: config.commandTimeoutMs })
    this.account = new DingtalkAccount(cli, ctx.logger, release)
    ctx.effect(() => () => this.account.dispose())
    // Watched: the first download publishes the root after the catalog may have been listed.
    ctx.plugin(SkillFilesystem, {
      providerName: 'dingtalk',
      includeDefaultRoots: false,
      watch: true,
      bundledSkillDir: release.skillRoot,
    })
    // Prepare dws and its skills without waiting for the Plugins page, so a session without a browser finds them.
    this.account.refresh()
  }

  /* jscpd:ignore-start -- CLI app plugins declare the same Remote methods, each delegating to its own account runtime. */
  /**
   * Check the account again without changing it; installs dws and its skills first while either is missing.
   * @returns the operation identity.
   * @throws while another operation runs.
   */
  @Remote
  check(): CliOperationId {
    return this.account.start('check')
  }

  /**
   * Sign in through the browser authorization page that dws serves to this computer.
   * @returns the operation identity.
   * @throws while another operation runs.
   */
  @Remote
  signIn(): CliOperationId {
    return this.account.start('sign-in')
  }

  /**
   * Sign the current account out, which also signs it out of the user's own terminal.
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
  async *follow(signal: AbortSignal): AsyncIterable<DingtalkState> {
    yield* this.account.follow(signal)
  }
  /* jscpd:ignore-end */
}
