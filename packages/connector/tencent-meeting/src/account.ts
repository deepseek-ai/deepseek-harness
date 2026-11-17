/**
 * Check, sign-in, and sign-out of the default tmeet account that the user's terminal shares, as the operations
 * `ctx.cliAccounts` runs.
 */

import type { CliOperationControl } from '@deepseek-ai/dsh-cli-account/types'
import type { UpstreamSkillsHandle } from '@deepseek-ai/dsh-upstream-skills/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  TencentMeetingAccountState, TencentMeetingCommand, TencentMeetingOperationKind, TencentMeetingPhase, TencentMeetingSignIn,
} from './types.ts'

const LOGIN_LINK = /^authorize url: (https:\/\/\S+)[ \t]*$/u

type Control = CliOperationControl<TencentMeetingAccountState, TencentMeetingPhase, TencentMeetingCommand>

/** The upstream guide whose state the account carries and whose failed download each check restarts. */
type Guides = Pick<UpstreamSkillsHandle, 'state' | 'retry'>

/**
 * Read the text `auth status` prints; tmeet 1.0.18 has no machine-readable status and exits 0 whether or not a user is
 * signed in. `Logged in` alone does not show that the server accepts the sign-in: the CLI prints the user name only
 * after its user-info request succeeds, refreshing the token first when needed.
 * @returns the account, or undefined for output this version does not print.
 */
function readStatus(stdout: string): TencentMeetingSignIn | undefined {
  if (/^[ \t]*(?:Not logged in|Session has expired)\./mu.test(stdout)) return { state: 'signed-out' }
  if (!/^Logged in$/mu.test(stdout)) return undefined
  if (/^[ \t]*RefreshToken:[ \t]+expired\b/mu.test(stdout)) return { state: 'signed-out' }
  const userName = /^[ \t]*UserName:[ \t]+(\S.*?)[ \t]*$/mu.exec(stdout)?.[1]
  return userName === undefined ? { state: 'unverified' } : { state: 'connected', userName }
}

/* jscpd:ignore-start -- CLI app plugins with downloaded guides bind their operations to the guides alike. */
/**
 * Bind the Tencent Meeting account operations to the upstream guide.
 * @param guides - the registered upstream guide.
 * @returns the function that carries out one operation with tmeet and publishes the account each check observes; it
 *   throws when a command fails, prints an unknown status, or leaves no verified sign-in after a sign-in.
 */
export function performWith(guides: Guides): (kind: TencentMeetingOperationKind, control: Control, signal: AbortSignal) => Promise<void> {
  return async (kind, control, signal) => {
    switch (kind) {
      case 'check':
        await check(guides, control, signal)
        return
      case 'sign-in': return signIn(guides, control, signal)
      case 'sign-out': return signOut(guides, control, signal)
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(kind)
    }
  }
}
/* jscpd:ignore-end */

/** Sign in through the CLI's authorization page, then confirm that the server accepts the new sign-in. */
async function signIn(guides: Guides, control: Control, signal: AbortSignal): Promise<void> {
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
  if ((await check(guides, control, signal)).state !== 'connected') throw new Error('tencent-meeting: auth login left no verified sign-in')
}

/** Clear the default sign-in, which also signs out the user's own terminal, then check again. */
async function signOut(guides: Guides, control: Control, signal: AbortSignal): Promise<void> {
  control.stage('signing-out')
  const logout = await control.run('auth-logout', ['auth', 'logout'], signal)
  if (logout.exitCode !== 0) throw new Error(`tencent-meeting: auth logout exited with ${String(logout.exitCode)}`)
  await check(guides, control, signal)
}

/** Restart a failed download of the guide without waiting for it, then read the default account, publish it, and return it. */
async function check(guides: Guides, control: Control, signal: AbortSignal): Promise<TencentMeetingAccountState> {
  guides.retry()
  const result = await control.run('auth-status', ['auth', 'status'], signal)
  const signIn = result.exitCode === 0 ? readStatus(result.stdout) : undefined
  if (signIn === undefined) throw new Error(`tencent-meeting: auth status exited with ${String(result.exitCode)} or printed an unknown status`)
  const account: TencentMeetingAccountState = { ...signIn, skills: guides.state }
  control.publish(account)
  return account
}
