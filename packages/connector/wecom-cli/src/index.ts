import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { CliAccountConfig, CliCommandExecutor, exitFailure, type CliOperationId } from '@deepseek-ai/dsh-cli-account'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-subprocess'
import { WecomAccount } from './account.ts'
import { PROGRAM, resolveCliDirectory } from './directory.ts'
import type { WecomState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    wecom: Wecom
  }
}

export type Config = CliAccountConfig

export default class Wecom extends TypertRemoteService {
  static inject = ['skills', 'subprocess', 'shellEnv']
  static Config: z<Config> = CliAccountConfig

  private readonly account: WecomAccount

  constructor(ctx: Context, config: Config) {
    super(ctx, 'wecom')
    if (!ctx.subprocess.runsOnHost) {
      throw new Error('wecom: wecom-cli and its authorization are local to this Host; mount a Host subprocess runtime')
    }
    ctx.shellEnv.registerPath({ name: 'wecom', directories: [resolveCliDirectory(config.binDir)] })
    this.account = new WecomAccount({
      name: 'wecom',
      cli: new CliCommandExecutor(ctx.subprocess, ctx.shellEnv, { program: PROGRAM, commandTimeoutMs: config.commandTimeoutMs }),
      logger: ctx.logger,
      account: { state: 'unchecked' },
      check: 'check',
      cancellable: ['authorizing'],
      authorizationHosts: ['work.weixin.qq.com'],
      classify: exitFailure,
    })
    ctx.effect(() => () => this.account.dispose())
    ctx.plugin(SkillFilesystem, {
      providerName: 'wecom',
      includeDefaultRoots: false,
      watch: false,
      bundledSkillDir: fileURLToPath(new URL('../skills/', import.meta.url)),
    })
  }

  @Remote
  check(): CliOperationId {
    return this.account.start('check')
  }

  @Remote
  connect(): CliOperationId {
    return this.account.start('connect')
  }

  @Remote
  cancel(id: CliOperationId): Promise<void> {
    return this.account.cancel(id)
  }

  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<WecomState> {
    yield* this.account.follow(signal)
  }
}
