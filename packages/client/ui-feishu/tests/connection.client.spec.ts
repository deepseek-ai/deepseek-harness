// @vitest-environment jsdom
/** The page derives the Feishu connection from the Host's view and drives account operations through its Remote. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { FeishuAppId, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createConnection, presentConnection, type ConnectionPresentation, type ConnectionStep } from '../src/client/connection.ts'

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

function fixture() {
  const queue: FeishuState[] = []
  let wake: (() => void) | undefined, closed = false, accepted = 0
  let options!: RemoteStreamOptions<FeishuState>
  const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
  const remote = {
    follow: vi.fn(),
    check: vi.fn(async () => ok(OP)),
    linkApp: vi.fn(async () => ok(OP)),
    signIn: vi.fn(async () => ok(OP)),
    signOut: vi.fn(async () => ok(OP)),
    cancel: vi.fn(async (_id: CliOperationId) => ok(undefined)),
  }
  const ctx = new Context()
  ctx.provide('remote', {
    feishu: remote,
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
    async publish(view: FeishuState) {
      const target = accepted + 1
      queue.push(view)
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
  }
}

const settle = async (b: ReturnType<typeof fixture>) => { await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) }) }

it('follows the feishu Remote and exposes the mirror to the page', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  b.options().open(signal)
  expect(b.remote.follow).toHaveBeenCalledWith(signal)
  await b.publish(SIGNED_OUT)
  expect(b.face.hooks.feishuConnection.getSnapshot()).toMatchObject({ view: SIGNED_OUT, linked: true, busy: false })
})

it('links an app and signs in through the Remote, opening each link and reporting each finished step', async () => {
  const b = fixture()
  const NO_APP: FeishuState = { account: { state: 'unconfigured' } }
  await b.publish(NO_APP)
  b.face.linkApp()
  await settle(b)
  expect(b.remote.linkApp).toHaveBeenCalledOnce()
  await b.publish({ ...NO_APP, operation: operation('link-app', 'configuring', true, 'https://open.feishu.cn/app') })
  expect(b.open.mock.calls.map(call => call[0])).toEqual(['https://open.feishu.cn/app'])
  await b.publish({ ...SIGNED_OUT, result: { id: OP, kind: 'link-app', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'app-linked' })

  const SIGN_IN = 'op-2' as CliOperationId
  b.remote.signIn.mockResolvedValueOnce({ ok: true, value: SIGN_IN })
  b.face.signIn()
  await settle(b)
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true, 'https://accounts.feishu.cn/device', SIGN_IN) })
  expect(b.open.mock.calls.map(call => call[0])).toEqual(['https://open.feishu.cn/app', 'https://accounts.feishu.cn/device'])
  await b.publish({ account: { state: 'connected', appId: APP }, result: { id: SIGN_IN, kind: 'sign-in', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 2, kind: 'connected' })
})

it('checks again without a notice', async () => {
  const b = fixture()
  await b.publish({ account: { state: 'unverified', appId: APP } })
  b.face.check()
  await settle(b)
  expect(b.remote.check).toHaveBeenCalledOnce()
  await b.publish({ ...SIGNED_OUT, result: { id: OP, kind: 'check', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toBeUndefined()
})

it('signs out with a notice and cancels a cancellable sign-in through the Remote', async () => {
  const b = fixture()
  await b.publish({ account: { state: 'connected', appId: APP } })
  b.face.signOut()
  await settle(b)
  expect(b.remote.signOut).toHaveBeenCalledOnce()
  await b.publish({ account: { state: 'signed-out', appId: APP }, result: { id: OP, kind: 'sign-out', outcome: 'succeeded' } })
  expect(b.snapshot().notice?.kind).toBe('signed-out')
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', true) })
  b.face.cancel()
  await settle(b)
  expect(b.remote.cancel).toHaveBeenCalledWith(OP)
})
