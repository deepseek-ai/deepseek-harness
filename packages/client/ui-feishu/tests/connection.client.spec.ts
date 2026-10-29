/** The page derives the Feishu connection from the Host's view. */
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { FeishuAppId, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'
import { expect, it } from 'vitest'
import { presentConnection, type ConnectionPresentation, type ConnectionStep } from '../src/client/connection.ts'

type Operation = NonNullable<FeishuState['operation']>

const OP = 'op-1' as CliOperationId
const APP = 'cli_a' as FeishuAppId
const SIGNED_OUT: FeishuState = { account: { state: 'signed-out', appId: APP } }
const FAILED_SIGN_IN: NonNullable<FeishuState['result']> = { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 1 } }

function operation(kind: Operation['kind'], phase: Operation['phase'], cancellable = false, authorizationUrl?: string, id = OP): Operation {
  return { id, kind, phase, cancellable, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

const connecting = (step: ConnectionStep, url: string | undefined, cancellable: boolean): ConnectionPresentation =>
  ({ phase: 'connecting', step, url, cancellable })

it.each<[string, FeishuState | undefined, ConnectionPresentation]>([
  ['a stopped stream', SIGNED_OUT, { phase: 'stopped' }],
  ['no view yet', undefined, { phase: 'checking' }],
  ['an unchecked account', { account: { state: 'unchecked' } }, { phase: 'checking' }],
  ['a check', { ...SIGNED_OUT, operation: operation('check', 'checking') }, { phase: 'checking' }],
  ['no app', { account: { state: 'unconfigured' } }, { phase: 'disconnected', next: 'link-app', failed: undefined }],
  ['a linked app', SIGNED_OUT, { phase: 'disconnected', next: 'sign-in', appId: APP, failed: undefined }],
  ['a failed sign-in', { ...SIGNED_OUT, result: FAILED_SIGN_IN }, { phase: 'disconnected', next: 'sign-in', appId: APP, failed: FAILED_SIGN_IN }],
  ['a cancelled sign-in', { ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } }, { phase: 'disconnected', next: 'sign-in', appId: APP, failed: undefined }],
  ['an unconfirmed sign-in', { account: { state: 'unverified', appId: APP } }, { phase: 'unavailable', appId: APP, failed: undefined }],
  ['a connection', { account: { state: 'connected', appId: APP, userName: '张三' } }, { phase: 'connected', appId: APP, userName: '张三', failed: undefined }],
  ['app setup', { ...SIGNED_OUT, operation: operation('link-app', 'configuring', true, 'https://open.feishu.cn/x') }, connecting('configuring', 'https://open.feishu.cn/x', true)],
  ['sign-in', { ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true) }, connecting('authorizing', undefined, true)],
  ['an app link check', { ...SIGNED_OUT, operation: operation('link-app', 'checking') }, connecting('connecting', undefined, false)],
  ['verification', { ...SIGNED_OUT, operation: operation('sign-in', 'verifying') }, connecting('connecting', undefined, false)],
  ['cancellation', { ...SIGNED_OUT, operation: operation('sign-in', 'cancelling') }, connecting('connecting', undefined, false)],
  ['sign-out', { ...SIGNED_OUT, operation: operation('sign-out', 'signing-out') }, connecting('signing-out', undefined, false)],
  ['a sign-out check', { ...SIGNED_OUT, operation: operation('sign-out', 'checking') }, connecting('signing-out', undefined, false)],
])('presents %s', (name, view, expected) => {
  expect(presentConnection({ view, stopped: name === 'a stopped stream' })).toEqual(expected)
})
