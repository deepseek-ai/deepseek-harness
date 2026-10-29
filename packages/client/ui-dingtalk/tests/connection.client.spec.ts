/** The page derives the DingTalk account from the Host's view. */
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { DingtalkState } from '@deepseek-ai/dsh-dingtalk-cli/types'
import { expect, it } from 'vitest'
import { presentConnection, type ConnectionPresentation } from '../src/client/connection.ts'

type Operation = NonNullable<DingtalkState['operation']>

const OP = 'op-1' as CliOperationId
const LINK = 'https://login.dingtalk.com/oauth2/auth?client_id=fixture&state=fixture'
const SIGNED_OUT: DingtalkState = { account: { state: 'signed-out' } }
const CONNECTED: DingtalkState = { account: { state: 'connected', userName: '测试用户', corpName: '测试组织' } }
const FAILED_SIGN_IN: NonNullable<DingtalkState['result']> = { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 2 } }
const FAILED_CHECK: NonNullable<DingtalkState['result']> = { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } }
const FAILED_DOWNLOAD: NonNullable<DingtalkState['result']> = { id: OP, kind: 'check', outcome: 'failed' }

function operation(kind: Operation['kind'], phase: Operation['phase'], cancellable = false, authorizationUrl?: string): Operation {
  return { id: OP, kind, phase, cancellable, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

it.each<[string, DingtalkState | undefined, ConnectionPresentation]>([
  ['a stopped stream', SIGNED_OUT, { phase: 'stopped', failed: undefined }],
  ['no view yet', undefined, { phase: 'checking', downloading: false }],
  ['an unchecked account', { account: { state: 'unchecked' } }, { phase: 'checking', downloading: false }],
  ['a check', { ...SIGNED_OUT, operation: operation('check', 'checking') }, { phase: 'checking', downloading: false }],
  ['a check installing dws', { account: { state: 'unchecked' }, operation: operation('check', 'downloading') }, { phase: 'checking', downloading: true }],
  ['a first check that failed', { account: { state: 'unchecked' }, result: FAILED_CHECK }, { phase: 'unavailable', missing: false, failed: FAILED_CHECK }],
  ['a dws download that did not finish', { account: { state: 'not-installed' }, result: FAILED_DOWNLOAD },
    { phase: 'unavailable', missing: true, failed: FAILED_DOWNLOAD }],
  ['no sign-in', SIGNED_OUT, { phase: 'disconnected', failed: undefined }],
  ['a failed sign-in', { ...SIGNED_OUT, result: FAILED_SIGN_IN }, { phase: 'disconnected', failed: FAILED_SIGN_IN }],
  ['a cancelled sign-in', { ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } }, { phase: 'disconnected', failed: undefined }],
  ['a sign-in dws cannot judge', { account: { state: 'unverified' } }, { phase: 'unavailable', missing: false, failed: undefined }],
  ['a signed-in user', CONNECTED, { phase: 'connected', userName: '测试用户', corpName: '测试组织', failed: undefined }],
  ['a signed-in user without names', { account: { state: 'connected' } }, { phase: 'connected', userName: undefined, corpName: undefined, failed: undefined }],
  ['an authorization', { ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true, LINK) },
    { phase: 'connecting', step: 'authorizing', url: LINK, cancellable: true }],
  ['a confirmation', { ...SIGNED_OUT, operation: operation('sign-in', 'checking') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['cancellation', { ...SIGNED_OUT, operation: operation('sign-in', 'cancelling') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['a sign-out', { ...CONNECTED, operation: operation('sign-out', 'signing-out') }, { phase: 'connecting', step: 'signing-out', url: undefined, cancellable: false }],
])('presents %s', (name, view, expected) => {
  expect(presentConnection({ view, stopped: name === 'a stopped stream' })).toEqual(expected)
})
