/** Check, sign-in, and sign-out of the dws account that the user's terminal shares, as the operations `ctx.cliAccounts` runs. */

import z from 'zod'
import type { CliOperationControl } from '@deepseek-ai/dsh-cli-account/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { DingtalkAccountState, DingtalkCommand, DingtalkOperationKind, DingtalkPhase } from './types.ts'

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

type Control = CliOperationControl<DingtalkAccountState, DingtalkPhase, DingtalkCommand>
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

/**
 * Create the DingTalk account operations of one plugin instance, which share the signed-in account a check found.
 * @returns the function that carries out one operation with dws and publishes the account each check observes; it
 *   throws when a command fails, `auth status` prints an unknown status, a sign-in leaves no signed-in account, or a
 *   sign-out finds none to sign out.
 */
export function createPerform(): (kind: DingtalkOperationKind, control: Control, signal: AbortSignal) => Promise<void> {
  /** The account the latest check found signed in, kept on the Host because the view carries no account ids. */
  let profile: string | undefined

  /** Sign in through the browser authorization page, then confirm that dws reports the account signed in. */
  async function signIn(control: Control, signal: AbortSignal): Promise<void> {
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
    if ((await check(control, signal)).state !== 'connected') throw new Error('dingtalk: auth login left no signed-in account')
  }

  /** Sign the current account out, which also signs it out of the user's own terminal, then check again. */
  async function signOut(control: Control, signal: AbortSignal): Promise<void> {
    if (profile === undefined) throw new Error('dingtalk: no signed-in account to sign out')
    control.stage('signing-out')
    const logout = await control.run('auth-logout', ['auth', 'logout', '--profile', profile], signal)
    if (logout.exitCode !== 0) throw new Error(`dingtalk: auth logout exited with ${String(logout.exitCode)}`)
    await check(control, signal)
  }

  /** Read the current account, publish it, and return it. */
  async function check(control: Control, signal: AbortSignal): Promise<DingtalkAccountState> {
    const result = await control.run('auth-status', ['auth', 'status', '--format', 'json'], signal)
    const status = result.exitCode === 0 ? parseStatus(result.stdout) : undefined
    if (status === undefined) throw new Error(`dingtalk: auth status exited with ${String(result.exitCode)} or printed an unknown status`)
    const account = readAccount(status)
    profile = readProfile(status)
    control.publish(account)
    return account
  }

  /* jscpd:ignore-start -- CLI app plugins dispatch the same operation kinds, each to its own commands. */
  return async (kind, control, signal) => {
    switch (kind) {
      case 'check':
        await check(control, signal)
        return
      case 'sign-in': return signIn(control, signal)
      case 'sign-out': return signOut(control, signal)
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(kind)
    }
  }
  /* jscpd:ignore-end */
}
