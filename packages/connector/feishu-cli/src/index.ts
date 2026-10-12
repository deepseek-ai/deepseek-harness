/**
 * Feishu plugin: puts the managed lark-cli on the private Shell PATH, registers
 * its embedded skills, and serves the Plugins page's account operations over
 * Remote. The CLI's default account is shared with the user's own terminal.
 * @module @deepseek-ai/dsh-feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { FeishuAccount } from './account.ts'
import { FeishuCli, resolveCliDirectory, type FeishuCliLimits } from './cli.ts'
import { FeishuSkillProvider } from './skills.ts'
import type { FeishuOperationId, FeishuState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Feishu account operations for the Plugins page. */
    feishu: Feishu
  }
}

/** CLI location and command limits. */
export interface Config extends FeishuCliLimits {
  /** Absolute directory containing `lark-cli`; defaults to the installed `@larksuite/cli` package. */
  binDir?: string
  /** Deadline for app setup or sign-in, which wait for the user in the browser. */
  authorizationTimeoutMs: number
}

/** Registers the CLI and skills, and owns the account operations the Plugins page drives. */
export default class Feishu extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'shellEnv']
  static Config: z<Config> = z.object({
    binDir: z.string().min(1),
    commandTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    authorizationTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
    maxOutputBytes: z.number().min(1).step(1).default(1_048_576),
  })

  private readonly account: FeishuAccount
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

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
    const directory = resolveCliDirectory(config.binDir)
    ctx.shellEnv.registerPath({ name: 'feishu', directories: [directory] })
    const cli = new FeishuCli(ctx.subprocess, ctx.shellEnv, config)
    this.account = new FeishuAccount(cli, config, () => { for (const notify of this.listeners) notify() })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      try {
        await this.account.dispose()
      } finally {
        await cli.dispose()
      }
    })
    ctx.skills.registerProvider(control => new FeishuSkillProvider(cli, control, ctx.logger))
  }

  /**
   * Check the account, set up an app if none is configured, then sign in.
   * @returns the operation identity.
   * @throws while another account operation runs.
   */
  @Remote
  connect(): FeishuOperationId {
    return this.account.start('connect')
  }

  /**
   * Sign the default account out, which also signs out the user's own terminal.
   * @returns the operation identity.
   * @throws while another account operation runs.
   */
  @Remote
  signOut(): FeishuOperationId {
    return this.account.start('sign-out')
  }

  /**
   * Cancel one operation and wait for its command to exit.
   * @param id - the operation to cancel; a finished one is ignored.
   * @returns after the operation settles.
   */
  @Remote
  cancel(id: FeishuOperationId): Promise<void> {
    return this.account.cancel(id)
  }

  /**
   * Follow the account and its operations independently of any page; each new subscriber starts a check when none runs.
   * @param signal - the Client's observation lifetime.
   * @returns the current view, then each changed view.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<FeishuState> {
    this.account.refresh()
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let wake = Promise.withResolvers<void>()
    let changed = true
    const notify = (): void => { changed = true; wake.resolve() }
    this.listeners.add(notify)
    combined.addEventListener('abort', notify, { once: true })
    try {
      for (;;) {
        if (!changed) await wake.promise
        if (combined.aborted) break
        wake = Promise.withResolvers<void>()
        changed = false
        yield this.account.snapshot()
      }
    } finally {
      this.listeners.delete(notify)
      combined.removeEventListener('abort', notify)
    }
  }
}
