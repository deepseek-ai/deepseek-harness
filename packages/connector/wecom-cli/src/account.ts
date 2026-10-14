/** Host-owned check and QR-code authorization of the wecom-cli bot that the user's terminal shares. */

import type { Context } from '@deepseek-ai/cordis'
import { CliAccountRuntime, exitFailure, type CliCommandExecutor, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WecomAccountState, WecomOperationFailure, WecomOperationKind, WecomPhase } from './types.ts'

const AUTHORIZATION_LINK = /^\s*(https:\/\/\S+)\s*$/u

type Control = CliOperationControl<WecomPhase, WecomOperationFailure['command']>

/** Runs at most one authorization operation at a time; subscribers observe it without owning it. */
export class WecomAccount extends CliAccountRuntime<WecomAccountState, WecomOperationKind, WecomPhase, WecomOperationFailure> {
  /**
   * @param cli - the wecom-cli executor the account runs commands with and disposes.
   * @param logger - receives classified operation failures.
   */
  constructor(cli: CliCommandExecutor, logger: Context['logger']) {
    super({
      name: 'wecom',
      cli,
      logger,
      account: { state: 'unchecked' },
      check: 'check',
      cancellable: ['authorizing'],
      authorizationHosts: ['work.weixin.qq.com'],
      classify: exitFailure,
    })
  }

  protected async perform(kind: WecomOperationKind, control: Control, signal: AbortSignal): Promise<void> {
    switch (kind) {
      case 'check':
        await this.check(control, signal)
        return
      case 'connect': return this.connect(control, signal)
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(kind)
    }
  }

  /** Bind a bot through the CLI's QR-code page, then confirm the CLI reports it authorized. */
  private async connect(control: Control, signal: AbortSignal): Promise<void> {
    control.stage('authorizing')
    const init = await control.run('auth-init', ['auth', 'init', '--noninteractive', '--no-browser'], signal, {
      awaitsUser: true,
      onLine: (stream, line) => {
        const link = stream === 'stdout' ? AUTHORIZATION_LINK.exec(line) : null
        if (link !== null) control.offer(link[1] as string)
      },
    })
    if (init.exitCode !== 0) throw new Error(`wecom: auth init exited with ${String(init.exitCode)}`)
    control.stage('checking')
    if ((await this.check(control, signal)).state !== 'authorized') throw new Error('wecom: auth init left no authorization')
  }

  /** Read the authorization state, publish it, and return it. */
  private async check(control: Control, signal: AbortSignal): Promise<WecomAccountState> {
    const result = await control.run('auth-status', ['auth', 'show', '--status'], signal)
    const state = result.stdout.trim()
    if (result.exitCode !== 0 || (state !== 'authorized' && state !== 'unauthorized')) {
      throw new Error(`wecom: auth show --status exited with ${String(result.exitCode)}`)
    }
    const account: WecomAccountState = { state }
    this.publish(account)
    return account
  }
}
