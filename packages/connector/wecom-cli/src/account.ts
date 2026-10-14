import { CliAccountRuntime, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WecomAccountState, WecomOperationKind, WecomPhase } from './types.ts'

const AUTHORIZATION_LINK = /^\s*(https:\/\/\S+)\s*$/u

export class WecomAccount extends CliAccountRuntime<WecomAccountState, WecomOperationKind, WecomPhase> {
  protected async perform(kind: WecomOperationKind, control: CliOperationControl<WecomPhase>, signal: AbortSignal): Promise<void> {
    switch (kind) {
      case 'check':
        await this.check(signal)
        return
      case 'connect': return this.connect(control, signal)
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(kind)
    }
  }

  private async connect(control: CliOperationControl<WecomPhase>, signal: AbortSignal): Promise<void> {
    control.stage('authorizing')
    const init = await this.cli.run(['auth', 'init', '--noninteractive', '--no-browser'], signal, {
      awaitsUser: true,
      onLine: (stream, line) => {
        const link = stream === 'stdout' ? AUTHORIZATION_LINK.exec(line) : null
        if (link !== null) control.offer(link[1] as string)
      },
    })
    if (init.exitCode !== 0) throw new Error(`wecom: auth init exited with ${String(init.exitCode)}`)
    control.stage('checking')
    if ((await this.check(signal)).state !== 'authorized') throw new Error('wecom: auth init left no authorization')
  }

  private async check(signal: AbortSignal): Promise<WecomAccountState> {
    const result = await this.cli.run(['auth', 'show', '--status'], signal)
    const state = result.stdout.trim()
    if (result.exitCode !== 0 || (state !== 'authorized' && state !== 'unauthorized')) {
      throw new Error(`wecom: auth show --status exited with ${String(result.exitCode)}`)
    }
    const account: WecomAccountState = { state }
    this.publish(account)
    return account
  }
}
