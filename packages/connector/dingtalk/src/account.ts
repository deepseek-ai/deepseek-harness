/** Host-owned check, sign-in, and sign-out of the dws account that the user's terminal shares. */

import type { Context } from '@deepseek-ai/cordis'
import z from 'zod'
import { CliAccountRuntime, exitFailure, type CliCommandExecutor, type CliOperationControl } from '@deepseek-ai/dsh-cli-account'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { DwsRelease } from './release.ts'
import type { DingtalkAccountState, DingtalkOperationFailure, DingtalkOperationKind, DingtalkPhase } from './types.ts'

/** `auth login --no-browser` prints the authorization link alone on an indented stderr line. */
const AUTHORIZATION_LINK = /^\s*(https:\/\/\S+)\s*$/u
/** `auth status` reasons that dws reports as inconclusive rather than signed out. */
const INCONCLUSIVE = new Set(['local_state_requires_repair', 'local_state_unreadable', 'ciphertext_key_mismatch', 'dek_missing', 'keychain_unavailable'])
const Status = z.object({
  authenticated: z.boolean(),
  reason: z.string().optional(),
  user_name: z.string().optional(),
  corp_name: z.string().optional(),
  corp_id: z.string().optional(),
  user_id: z.string().optional(),
})

type Control = CliOperationControl<DingtalkPhase, DingtalkOperationFailure['command']>
type Status = z.infer<typeof Status>

function parseStatus(stdout: string): Status | undefined {
  let value: unknown
  try { value = JSON.parse(stdout) } catch (_notJson) { return undefined }
  return Status.safeParse(value).data
}

function readAccount(status: Status): DingtalkAccountState {
  if (!status.authenticated) return { state: status.reason !== undefined && INCONCLUSIVE.has(status.reason) ? 'unverified' : 'signed-out' }
  return {
    state: 'connected',
    ...status.user_name === undefined ? {} : { userName: status.user_name },
    ...status.corp_name === undefined ? {} : { corpName: status.corp_name },
  }
}

/** The `--profile` selector of the signed-in account; both ids are required so sign-out never selects a whole organization. */
function readProfile(status: Status): string | undefined {
  if (!status.authenticated || status.corp_id === undefined || status.user_id === undefined) return undefined
  return `${status.corp_id}:${status.user_id}`
}

/** Runs at most one account operation at a time; subscribers observe it without owning it. */
export class DingtalkAccount extends CliAccountRuntime<
  DingtalkAccountState, DingtalkOperationKind, DingtalkPhase, DingtalkOperationFailure
> {
  /** The account the latest check found signed in, kept on the Host because the view carries no account ids. */
  private profile: string | undefined

  /**
   * @param cli - the dws executor the account runs commands with and disposes.
   * @param logger - receives classified operation failures.
   * @param release - the dws and skill installation each check prepares before its first command.
   */
  constructor(cli: CliCommandExecutor, logger: Context['logger'], private readonly release: Pick<DwsRelease, 'installed' | 'install'>) {
    super({
      name: 'dingtalk',
      cli,
      logger,
      account: { state: 'unchecked' },
      check: 'check',
      cancellable: ['authorizing'],
      authorizationHosts: ['login.dingtalk.com'],
      classify: exitFailure,
    })
  }

  /* jscpd:ignore-start -- CLI app plugins dispatch the same operation kinds, each to its own commands. */
  protected async perform(kind: DingtalkOperationKind, control: Control, signal: AbortSignal): Promise<void> {
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
  /* jscpd:ignore-end */

  /** Sign in through the browser authorization page, then confirm that dws reports the account signed in. */
  private async signIn(control: Control, signal: AbortSignal): Promise<void> {
    control.stage('authorizing')
    const login = await control.run('auth-login', ['auth', 'login', '--no-browser', '--format', 'json'], signal, {
      awaitsUser: true,
      onLine: (stream, line) => {
        const link = stream === 'stderr' ? AUTHORIZATION_LINK.exec(line) : null
        if (link !== null) control.offer(link[1] as string)
      },
    })
    if (login.exitCode !== 0) throw new Error(`dingtalk: auth login exited with ${String(login.exitCode)}`)
    control.stage('checking')
    if ((await this.check(control, signal)).state !== 'connected') throw new Error('dingtalk: auth login left no signed-in account')
  }

  /** Sign the current account out, which also signs it out of the user's own terminal, then check again. */
  private async signOut(control: Control, signal: AbortSignal): Promise<void> {
    const profile = this.profile
    if (profile === undefined) throw new Error('dingtalk: no signed-in account to sign out')
    control.stage('signing-out')
    const logout = await control.run('auth-logout', ['auth', 'logout', '--profile', profile], signal)
    if (logout.exitCode !== 0) throw new Error(`dingtalk: auth logout exited with ${String(logout.exitCode)}`)
    await this.check(control, signal)
  }

  /** Install dws and its skills while either is missing, then read the current account, publish it, and return it. */
  private async check(control: Control, signal: AbortSignal): Promise<DingtalkAccountState> {
    if (!this.release.installed()) {
      control.stage('downloading')
      try {
        await this.release.install(signal)
      } catch (error) {
        this.publish({ state: 'not-installed' })
        throw error
      }
      control.stage('checking')
    }
    const result = await control.run('auth-status', ['auth', 'status', '--format', 'json'], signal)
    const status = result.exitCode === 0 ? parseStatus(result.stdout) : undefined
    if (status === undefined) throw new Error(`dingtalk: auth status exited with ${String(result.exitCode)} or printed an unknown status`)
    const account = readAccount(status)
    this.profile = readProfile(status)
    this.publish(account)
    return account
  }
}
