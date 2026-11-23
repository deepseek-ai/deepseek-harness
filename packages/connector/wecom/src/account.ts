/**
 * Check and QR-code binding of the wecom-cli bot that the user's terminal shares, as the operations `ctx.cliAccounts`
 * runs; binding again replaces it.
 */

import type { CliOperationControl } from '@deepseek-ai/dsh-cli-account/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WecomAccountState, WecomCommand, WecomOperationKind, WecomPhase } from './types.ts'

const AUTHORIZATION_LINK = /^\s*(https:\/\/\S+)\s*$/u
/** `auth show` prints `Status: authorized` or `Status: unauthorized`, then `Bot ID: <id>` when a bound bot gives the authorization. */
const STATUS_LINE = /^Status:[ \t]*(authorized|unauthorized)[ \t]*$/mu
const BOT_LINE = /^Bot ID:[ \t]*(\S+)[ \t]*$/mu

type Control = CliOperationControl<WecomAccountState, WecomPhase, WecomCommand>

/**
 * Carry out one account operation with wecom-cli and publish the authorization each check observes.
 * @param kind - the requested operation.
 * @param control - phase changes, link offers, command runs, and account updates for this operation.
 * @param signal - aborts on cancellation and when the plugin unloads.
 * @returns after the operation finishes.
 * @throws when a command fails, prints an unknown status, or leaves no authorization after a binding.
 */
export async function perform(kind: WecomOperationKind, control: Control, signal: AbortSignal): Promise<void> {
  switch (kind) {
    case 'check':
      await check(control, signal)
      return
    case 'connect': return connect(control, signal)
    /* v8 ignore next -- closed operation kind union */
    default: return assertNever(kind)
  }
}

/** Bind a bot through the CLI's QR-code page, then confirm the CLI reports it authorized. */
async function connect(control: Control, signal: AbortSignal): Promise<void> {
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
  if ((await check(control, signal)).state !== 'authorized') throw new Error('wecom: auth init left no authorization')
}

/** Read the authorization state, publish it, and return it. */
async function check(control: Control, signal: AbortSignal): Promise<WecomAccountState> {
  const result = await control.run('auth-status', ['auth', 'show'], signal)
  const state = STATUS_LINE.exec(result.stdout)?.[1]
  if (result.exitCode !== 0 || (state !== 'authorized' && state !== 'unauthorized')) {
    throw new Error(`wecom: auth show exited with ${String(result.exitCode)} or printed an unknown status`)
  }
  const botId = state === 'authorized' ? BOT_LINE.exec(result.stdout)?.[1] : undefined
  const account: WecomAccountState = { state, ...botId === undefined ? {} : { botId } }
  control.publish(account)
  return account
}
