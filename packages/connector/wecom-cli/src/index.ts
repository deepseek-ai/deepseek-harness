import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { WecomAccount } from './account.ts'
import { WecomCli, resolveCliDirectory, type WecomCliLimits } from './cli.ts'
import type { WecomOperationId, WecomState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    wecom: Wecom
  }
}

export interface Config extends WecomCliLimits {
  binDir?: string
  authorizationTimeoutMs: number
}

export default class Wecom extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'shellEnv']
  static Config: z<Config> = z.object({
    binDir: z.string().min(1),
    commandTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    authorizationTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
    maxOutputBytes: z.number().min(1).step(1).default(1_048_576),
  })

  private readonly account: WecomAccount
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'wecom')
    if (!ctx.subprocess.runsOnHost) {
      throw new Error('wecom: wecom-cli and its authorization are local to this Host; mount a Host subprocess runtime')
    }
    const directory = resolveCliDirectory(config.binDir)
    ctx.shellEnv.registerPath({ name: 'wecom', directories: [directory] })
    const cli = new WecomCli(ctx.subprocess, ctx.shellEnv, config)
    this.account = new WecomAccount(cli, config, () => { for (const notify of this.listeners) notify() })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      try {
        await this.account.dispose()
      } finally {
        await cli.dispose()
      }
    })
    ctx.plugin(SkillFilesystem, {
      providerName: 'wecom',
      includeDefaultRoots: false,
      watch: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
    })
  }

  @Remote
  check(): WecomOperationId {
    return this.account.start('check')
  }

  @Remote
  connect(): WecomOperationId {
    return this.account.start('connect')
  }

  @Remote
  cancel(id: WecomOperationId): Promise<void> {
    return this.account.cancel(id)
  }

  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<WecomState> {
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
