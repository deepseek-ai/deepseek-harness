/** Host-owned check, sign-in, and sign-out of the default tmeet account that the user's terminal shares. */

import type { Context } from '@deepseek-ai/cordis'
import { CliAccountRuntime, exitFailure, type CliCommandExecutor, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TencentMeetingAccountState, TencentMeetingOperationFailure, TencentMeetingOperationKind, TencentMeetingPhase } from './types.ts'

const LOGIN_LINK = /^authorize url: (https:\/\/\S+)[ \t]*$/u

type Control = CliOperationControl<TencentMeetingPhase, TencentMeetingOperationFailure['command']>

/**
 * Read the text `auth status` prints; tmeet 1.0.18 has no machine-readable status and exits 0 whether or not a user is
 * signed in. `Logged in` alone does not show that the server accepts the sign-in: the CLI prints the user name only
 * after its user-info request succeeds, refreshing the token first when needed.
 * @returns the account, or undefined for output this version does not print.
 */
function readStatus(stdout: string): TencentMeetingAccountState | undefined {
  if (/^[ \t]*(?:Not logged in|Session has expired)\./mu.test(stdout)) return { state: 'signed-out' }
  if (!/^Logged in$/mu.test(stdout)) return undefined
  if (/^[ \t]*RefreshToken:[ \t]+expired\b/mu.test(stdout)) return { state: 'signed-out' }
  const userName = /^[ \t]*UserName:[ \t]+(\S.*?)[ \t]*$/mu.exec(stdout)?.[1]
  return userName === undefined ? { state: 'unverified' } : { state: 'connected', userName }
}

/** Runs at most one account operation at a time; subscribers observe it without owning it. */
export class TencentMeetingAccount extends CliAccountRuntime<
  TencentMeetingAccountState, TencentMeetingOperationKind, TencentMeetingPhase, TencentMeetingOperationFailure
> {
  /**
   * @param cli - the tmeet executor the account runs commands with and disposes.
   * @param logger - receives classified operation failures.
   */
  constructor(cli: CliCommandExecutor, logger: Context['logger']) {
    super({
      name: 'tencent-meeting',
      cli,
      logger,
      account: { state: 'unchecked' },
      check: 'check',
      cancellable: ['authorizing'],
      authorizationHosts: ['meeting.tencent.com'],
      classify: exitFailure,
    })
  }

  protected async perform(kind: TencentMeetingOperationKind, control: Control, signal: AbortSignal): Promise<void> {
    switch (kind) {
      case 'check':
        await this.check(control, signal)
        return
      case 'sign-in': return this.signIn(control, signal)
      case 'sign-out': return this.signOut(control, signal)
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(kind)
    }
  }

  /** Sign in through the CLI's authorization page, then confirm that the server accepts the new sign-in. */
  private async signIn(control: Control, signal: AbortSignal): Promise<void> {
    control.stage('authorizing')
    const login = await control.run('auth-login', ['auth', 'login', '--no-browser'], signal, {
      awaitsUser: true,
      onLine: (stream, line) => {
        const link = stream === 'stdout' ? LOGIN_LINK.exec(line) : null
        if (link !== null) control.offer(link[1] as string)
      },
    })
    if (login.exitCode !== 0) throw new Error(`tencent-meeting: auth login exited with ${String(login.exitCode)}`)
    control.stage('checking')
    if ((await this.check(control, signal)).state !== 'connected') throw new Error('tencent-meeting: auth login left no verified sign-in')
  }

  /** Clear the default sign-in, which also signs out the user's own terminal, then check again. */
  private async signOut(control: Control, signal: AbortSignal): Promise<void> {
    control.stage('signing-out')
    const logout = await control.run('auth-logout', ['auth', 'logout'], signal)
    if (logout.exitCode !== 0) throw new Error(`tencent-meeting: auth logout exited with ${String(logout.exitCode)}`)
    await this.check(control, signal)
  }

  /** Read the default account, publish it, and return it. */
  private async check(control: Control, signal: AbortSignal): Promise<TencentMeetingAccountState> {
    const result = await control.run('auth-status', ['auth', 'status'], signal)
    const account = result.exitCode === 0 ? readStatus(result.stdout) : undefined
    if (account === undefined) throw new Error(`tencent-meeting: auth status exited with ${String(result.exitCode)} or printed an unknown status`)
    this.publish(account)
    return account
  }
}
