/** Check, connection, and sign-out of the CLI's default Feishu account, as the operations `ctx.cliAccounts` runs. */

import { brandString } from '@deepseek-ai/dsh-brand'
import z from 'zod'
import type { CliOperationControl } from '@deepseek-ai/dsh-cli-account/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { parseJson } from './cli.ts'
import type { FeishuAccountState, FeishuAppId, FeishuCommand, FeishuOperationKind, FeishuPhase } from './types.ts'

const NotConfigured = z.object({ ok: z.literal(false), error: z.object({ subtype: z.literal('not_configured') }) })
const User = z.object({
  status: z.string(),
  available: z.boolean(),
  verified: z.boolean().optional(),
  userName: z.string().optional(),
  openId: z.string().optional(),
})
const Status = z.object({ appId: z.string().min(1), identities: z.object({ user: User }) })
const LoginLink = z.object({ event: z.literal('device_authorization'), verification_uri_complete: z.string() })
const LoginComplete = z.object({ event: z.literal('authorization_complete'), user_open_id: z.string().min(1), missing: z.array(z.string()) })
const CONFIG_LINK = /^\s*(https:\/\/\S+)\s*$/u
const SIGNED_OUT = new Set(['missing', 'not_configured', 'needs_refresh'])

type Control = CliOperationControl<FeishuAccountState, FeishuPhase, FeishuCommand>

interface Check { account: FeishuAccountState; openId?: string | undefined }

/**
 * Carry out one account operation with lark-cli and publish the account each check observes.
 * @param kind - the requested operation.
 * @param control - phase changes, link offers, command runs, and account updates for this operation.
 * @param signal - aborts on cancellation and when the plugin unloads.
 * @returns after the operation finishes.
 * @throws when a command fails, its output is not the expected JSON, or the account it leaves is not the one the
 *   operation set out to reach.
 */
export async function perform(kind: FeishuOperationKind, control: Control, signal: AbortSignal): Promise<void> {
  switch (kind) {
    case 'check':
      await check(control, signal)
      return
    case 'link-app': return linkApp(control, signal)
    case 'sign-in': return signIn(control, signal)
    case 'sign-out': {
      control.stage('signing-out')
      const result = await control.run('auth-logout', ['auth', 'logout', '--json'], signal)
      if (result.exitCode !== 0) throw new Error('feishu: auth logout failed')
      await check(control, signal)
      return
    }
    /* v8 ignore next -- closed operation kind union */
    default: return assertNever(kind)
  }
}

/**
 * Link an app through the CLI's setup page; sign-in is a separate operation. An existing configuration,
 * including its sign-ins and any other app, is replaced by the app the user creates or chooses.
 */
async function linkApp(control: Control, signal: AbortSignal): Promise<void> {
  control.stage('configuring')
  let offered = false
  const setup = await control.run('config-init', ['config', 'init', '--new'], signal, {
    awaitsUser: true,
    onLine: (stream, line) => {
      const link = stream === 'stderr' && !offered ? CONFIG_LINK.exec(line) : null
      if (link !== null) offered = control.offer(link[1] as string)
    },
  })
  if (setup.exitCode !== 0) throw new Error('feishu: config init failed')
  control.stage('checking')
  if ((await check(control, signal)).account.state === 'unconfigured') throw new Error('feishu: config init left no app')
}

/** Sign the configured app's user in, then confirm the CLI's default account is that user. */
async function signIn(control: Control, signal: AbortSignal): Promise<void> {
  control.stage('authorizing')
  let complete: z.infer<typeof LoginComplete> | undefined
  const login = await control.run('auth-login', ['auth', 'login', '--json'], signal, {
    awaitsUser: true,
    onLine: (stream, line) => {
      if (stream !== 'stdout' || !line.startsWith('{')) return
      const event: unknown = JSON.parse(line)
      const link = LoginLink.safeParse(event)
      if (link.success) control.offer(link.data.verification_uri_complete)
      const done = LoginComplete.safeParse(event)
      if (done.success) complete = done.data
    },
  })
  // Exit code 3 reports a sign-in that completed without every requested permission.
  if (complete === undefined || (login.exitCode !== 0 && !(login.exitCode === 3 && complete.missing.length > 0))) {
    throw new Error('feishu: auth login did not complete')
  }
  control.stage('verifying')
  const found = await check(control, signal)
  if (found.account.state !== 'connected' || found.openId !== complete.user_open_id) throw new Error('feishu: sign-in did not verify')
}

/** Read the default account, publish what it shows, and return it with the signed-in user's id. */
async function check(control: Control, signal: AbortSignal): Promise<Check> {
  const args = ['auth', 'status', '--verify', '--json']
  const result = await control.run('auth-status', args, signal)
  if (result.exitCode !== 0) {
    if (!NotConfigured.safeParse(parseJson(args, result.stderr)).success) throw new Error('feishu: auth status failed')
    return record(control, { state: 'unconfigured' })
  }
  const status = Status.parse(parseJson(args, result.stdout))
  const appId = brandString<FeishuAppId>(status.appId)
  const user = status.identities.user
  const account: FeishuAccountState = user.available && user.verified === true
    ? { state: 'connected', appId, ...user.userName === undefined ? {} : { userName: user.userName } }
    : { state: SIGNED_OUT.has(user.status) ? 'signed-out' : 'unverified', appId }
  return record(control, account, user.openId)
}

function record(control: Control, account: FeishuAccountState, openId?: string): Check {
  control.publish(account)
  return { account, openId }
}
