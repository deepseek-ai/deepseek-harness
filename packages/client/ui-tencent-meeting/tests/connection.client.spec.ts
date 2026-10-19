// @vitest-environment jsdom
/** The page derives the Tencent Meeting account from the Host's view and drives operations through its Remote. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { TencentMeetingState } from '@deepseek-ai/dsh-tencent-meeting-cli/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createConnection, presentConnection, type ConnectionPresentation } from '../src/client/connection.ts'

type Operation = NonNullable<TencentMeetingState['operation']>

const OP = 'op-1' as CliOperationId
const LINK = 'https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture'
const SIGNED_OUT: TencentMeetingState = { account: { state: 'signed-out' } }
const CONNECTED: TencentMeetingState = { account: { state: 'connected', userName: '测试用户' } }
const FAILED_SIGN_IN: NonNullable<TencentMeetingState['result']> = { id: OP, kind: 'sign-in', outcome: 'failed', failure: { command: 'auth-login', exitCode: 1 } }
const FAILED_CHECK: NonNullable<TencentMeetingState['result']> = { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } }

function operation(kind: Operation['kind'], phase: Operation['phase'], cancellable = false, authorizationUrl?: string): Operation {
  return { id: OP, kind, phase, cancellable, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

it.each<[string, TencentMeetingState | undefined, ConnectionPresentation]>([
  ['a stopped stream', SIGNED_OUT, { phase: 'stopped', failed: undefined }],
  ['no view yet', undefined, { phase: 'checking', failed: undefined }],
  ['an unchecked account', { account: { state: 'unchecked' } }, { phase: 'checking', failed: undefined }],
  ['a check', { ...SIGNED_OUT, operation: operation('check', 'checking') }, { phase: 'checking', failed: undefined }],
  ['a first check that failed', { account: { state: 'unchecked' }, result: FAILED_CHECK }, { phase: 'unavailable', failed: FAILED_CHECK }],
  ['no sign-in', SIGNED_OUT, { phase: 'disconnected', failed: undefined }],
  ['a failed sign-in', { ...SIGNED_OUT, result: FAILED_SIGN_IN }, { phase: 'disconnected', failed: FAILED_SIGN_IN }],
  ['a cancelled sign-in', { ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'cancelled' } }, { phase: 'disconnected', failed: undefined }],
  ['an unconfirmed sign-in', { account: { state: 'unverified' } }, { phase: 'unavailable', failed: undefined }],
  ['a signed-in user', CONNECTED, { phase: 'connected', userName: '测试用户', failed: undefined }],
  ['an authorization', { ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true, LINK) },
    { phase: 'connecting', step: 'authorizing', url: LINK, cancellable: true }],
  ['a confirmation', { ...SIGNED_OUT, operation: operation('sign-in', 'checking') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['cancellation', { ...SIGNED_OUT, operation: operation('sign-in', 'cancelling') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['a sign-out', { ...CONNECTED, operation: operation('sign-out', 'signing-out') }, { phase: 'connecting', step: 'signing-out', url: undefined, cancellable: false }],
])('presents %s', (name, view, expected) => {
  expect(presentConnection({ view, stopped: name === 'a stopped stream' })).toEqual(expected)
})

function fixture() {
  const queue: TencentMeetingState[] = []
  let wake: (() => void) | undefined, closed = false, accepted = 0
  let options!: RemoteStreamOptions<TencentMeetingState>
  const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
  const remote = {
    follow: vi.fn(),
    check: vi.fn(async () => ok(OP)),
    signIn: vi.fn(async () => ok(OP)),
    signOut: vi.fn(async () => ok(OP)),
    cancel: vi.fn(async (_id: CliOperationId) => ok(undefined)),
  }
  const ctx = new Context()
  ctx.provide('remote', {
    tencentMeeting: remote,
    $stream: (value: typeof options) => {
      options = value
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (closed) return
            const next = queue.shift()
            if (next === undefined) { await new Promise<void>((resolve) => { wake = resolve }); continue }
            yield { value: next, accept: () => { accepted++ } }
          }
        },
        dispose: async () => { closed = true; wake?.() },
      }
    },
  })
  const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
  const { connection, face } = createConnection(ctx)
  onTestFinished(async () => { await connection.dispose(); windowOpen.mockRestore(); await ctx.fiber.dispose() })
  return {
    face, remote, open: windowOpen, options: () => options,
    snapshot: () => connection.state.getSnapshot(),
    async publish(view: TencentMeetingState) {
      const target = accepted + 1
      queue.push(view)
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
  }
}

const settle = async (b: ReturnType<typeof fixture>) => { await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) }) }

it('follows the tencentMeeting Remote and exposes the mirror to the page', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  b.options().open(signal)
  expect(b.remote.follow).toHaveBeenCalledWith(signal)
  await b.publish(SIGNED_OUT)
  expect(b.face.hooks.tencentMeetingConnection.getSnapshot()).toMatchObject({ view: SIGNED_OUT, linked: true, busy: false })
})

it('signs in through the Remote, opens the authorization page once, and reports the connection', async () => {
  const b = fixture()
  await b.publish(SIGNED_OUT)
  b.face.signIn()
  await settle(b)
  expect(b.remote.signIn).toHaveBeenCalledOnce()
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true, LINK) })
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true, LINK) })
  expect(b.open.mock.calls.map(call => call[0])).toEqual([LINK])
  b.face.cancel()
  await settle(b)
  expect(b.remote.cancel).toHaveBeenCalledWith(OP)
  await b.publish({ ...CONNECTED, result: { id: OP, kind: 'sign-in', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'connected' })
})

it('signs out through the Remote and reports it', async () => {
  const b = fixture()
  await b.publish(CONNECTED)
  b.face.signOut()
  await settle(b)
  expect(b.remote.signOut).toHaveBeenCalledOnce()
  await b.publish({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-out', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'signed-out' })
})

it('checks again without a notice', async () => {
  const b = fixture()
  await b.publish({ account: { state: 'unverified' } })
  b.face.check()
  await settle(b)
  expect(b.remote.check).toHaveBeenCalledOnce()
  await b.publish({ ...CONNECTED, result: { id: OP, kind: 'check', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toBeUndefined()
})
