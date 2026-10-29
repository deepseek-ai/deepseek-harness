/** The page derives the WeCom authorization from the Host's view. */
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { expect, it } from 'vitest'
import { presentConnection, type ConnectionPresentation } from '../src/client/connection.ts'

type Operation = NonNullable<WecomState['operation']>

const OP = 'op-1' as CliOperationId
const UNAUTHORIZED: WecomState = { account: { state: 'unauthorized', skills: 'installed' } }
const FAILED_CONNECT: NonNullable<WecomState['result']> = { id: OP, kind: 'connect', outcome: 'failed', failure: { command: 'auth-init', exitCode: 2 } }
const FAILED_CHECK: NonNullable<WecomState['result']> = { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } }

function operation(kind: Operation['kind'], phase: Operation['phase'], cancellable = false, authorizationUrl?: string): Operation {
  return { id: OP, kind, phase, cancellable, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

it.each<[string, WecomState | undefined, ConnectionPresentation]>([
  ['a stopped stream', UNAUTHORIZED, { phase: 'stopped', failed: undefined }],
  ['no view yet', undefined, { phase: 'checking', failed: undefined }],
  ['an unchecked authorization', { account: { state: 'unchecked', skills: 'installed' } }, { phase: 'checking', failed: undefined }],
  ['a check', { ...UNAUTHORIZED, operation: operation('check', 'checking') }, { phase: 'checking', failed: undefined }],
  ['a first check that failed', { account: { state: 'unchecked', skills: 'installed' }, result: FAILED_CHECK }, { phase: 'unavailable', failed: FAILED_CHECK }],
  ['no authorization', UNAUTHORIZED, { phase: 'disconnected', failed: undefined }],
  ['a failed connection', { ...UNAUTHORIZED, result: FAILED_CONNECT }, { phase: 'disconnected', failed: FAILED_CONNECT }],
  ['a cancelled connection', { ...UNAUTHORIZED, result: { id: OP, kind: 'connect', outcome: 'cancelled' } }, { phase: 'disconnected', failed: undefined }],
  ['an authorized bot', { account: { state: 'authorized', skills: 'installed' } }, { phase: 'connected', failed: undefined }],
  ['a QR-code scan', { ...UNAUTHORIZED, operation: operation('connect', 'authorizing', true, 'https://work.weixin.qq.com/qr') },
    { phase: 'connecting', step: 'authorizing', url: 'https://work.weixin.qq.com/qr', cancellable: true }],
  ['a confirmation', { ...UNAUTHORIZED, operation: operation('connect', 'checking') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['cancellation', { ...UNAUTHORIZED, operation: operation('connect', 'cancelling') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
])('presents %s', (name, view, expected) => {
  expect(presentConnection({ view, stopped: name === 'a stopped stream' })).toEqual(expected)
})
