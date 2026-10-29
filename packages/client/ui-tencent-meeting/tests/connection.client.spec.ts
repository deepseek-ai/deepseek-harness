/** The page derives the Tencent Meeting account from the Host's view. */
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { TencentMeetingState } from '@deepseek-ai/dsh-tencent-meeting-cli/types'
import { expect, it } from 'vitest'
import { presentConnection, type ConnectionPresentation } from '../src/client/connection.ts'

type Operation = NonNullable<TencentMeetingState['operation']>

const OP = 'op-1' as CliOperationId
const LINK = 'https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture'
const SIGNED_OUT: TencentMeetingState = { account: { state: 'signed-out', skills: 'installed' } }
const CONNECTED: TencentMeetingState = { account: { state: 'connected', userName: '测试用户', skills: 'installed' } }
const FAILED_SIGN_IN: NonNullable<TencentMeetingState['result']> = { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 1 } }
const FAILED_CHECK: NonNullable<TencentMeetingState['result']> = { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } }

function operation(kind: Operation['kind'], phase: Operation['phase'], cancellable = false, authorizationUrl?: string): Operation {
  return { id: OP, kind, phase, cancellable, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

it.each<[string, TencentMeetingState | undefined, ConnectionPresentation]>([
  ['a stopped stream', SIGNED_OUT, { phase: 'stopped', failed: undefined }],
  ['no view yet', undefined, { phase: 'checking', failed: undefined }],
  ['an unchecked account', { account: { state: 'unchecked', skills: 'installed' } }, { phase: 'checking', failed: undefined }],
  ['a check', { ...SIGNED_OUT, operation: operation('check', 'checking') }, { phase: 'checking', failed: undefined }],
  ['a first check that failed', { account: { state: 'unchecked', skills: 'installed' }, result: FAILED_CHECK }, { phase: 'unavailable', failed: FAILED_CHECK }],
  ['no sign-in', SIGNED_OUT, { phase: 'disconnected', failed: undefined }],
  ['a failed sign-in', { ...SIGNED_OUT, result: FAILED_SIGN_IN }, { phase: 'disconnected', failed: FAILED_SIGN_IN }],
  ['a cancelled sign-in', { ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } }, { phase: 'disconnected', failed: undefined }],
  ['an unconfirmed sign-in', { account: { state: 'unverified', skills: 'installed' } }, { phase: 'unavailable', failed: undefined }],
  ['a signed-in user', CONNECTED, { phase: 'connected', userName: '测试用户', failed: undefined }],
  ['an authorization', { ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true, LINK) },
    { phase: 'connecting', step: 'authorizing', url: LINK, cancellable: true }],
  ['a confirmation', { ...SIGNED_OUT, operation: operation('sign-in', 'checking') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['cancellation', { ...SIGNED_OUT, operation: operation('sign-in', 'cancelling') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['a sign-out', { ...CONNECTED, operation: operation('sign-out', 'signing-out') }, { phase: 'connecting', step: 'signing-out', url: undefined, cancellable: false }],
])('presents %s', (name, view, expected) => {
  expect(presentConnection({ view, stopped: name === 'a stopped stream' })).toEqual(expected)
})
