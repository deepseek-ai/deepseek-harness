// @vitest-environment jsdom
/** The page derives the Feishu connection from the Host's view and drives account operations through its Remote. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { FeishuAppId, FeishuOperationId, FeishuOperationState, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FeishuConnection, presentConnection, type ConnectionPresentation, type ConnectionStep } from '../src/client/connection.ts'

const OP = 'op-1' as FeishuOperationId
const APP = 'cli_a' as FeishuAppId
const SIGNED_OUT: FeishuState = { account: { state: 'signed-out', appId: APP } }

function operation(kind: FeishuOperationState['kind'], phase: FeishuOperationState['phase'], authorizationUrl?: string, id = OP): FeishuOperationState {
  return { id, kind, phase, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

const connecting = (step: ConnectionStep, url: string | undefined, cancellable: boolean): ConnectionPresentation =>
  ({ phase: 'connecting', step, operation: OP, url, cancellable })

it.each<[string, FeishuState | undefined, ReturnType<typeof presentConnection>]>([
  ['a stopped stream', SIGNED_OUT, { phase: 'stopped' }],
  ['no view yet', undefined, { phase: 'checking' }],
  ['an unchecked account', { account: { state: 'unchecked' } }, { phase: 'checking' }],
  ['a check', { ...SIGNED_OUT, operation: operation('check', 'checking') }, { phase: 'checking' }],
  ['no app', { account: { state: 'unconfigured' } }, { phase: 'disconnected', next: 'link-app', failed: false }],
  ['a linked app', SIGNED_OUT, { phase: 'disconnected', next: 'sign-in', appId: APP, failed: false }],
  ['a failed sign-in', { ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed' } }, { phase: 'disconnected', next: 'sign-in', appId: APP, failed: true }],
  ['an unconfirmed sign-in', { account: { state: 'unverified', appId: APP } }, { phase: 'unavailable', appId: APP, failed: false }],
  ['a connection', { account: { state: 'connected', appId: APP, userName: '张三' } }, { phase: 'connected', appId: APP, userName: '张三', failed: false }],
  ['app setup', { ...SIGNED_OUT, operation: operation('link-app', 'configuring', 'https://open.feishu.cn/x') }, connecting('configuring', 'https://open.feishu.cn/x', true)],
  ['sign-in', { ...SIGNED_OUT, operation: operation('sign-in', 'authorizing') }, connecting('authorizing', undefined, true)],
  ['an app link check', { ...SIGNED_OUT, operation: operation('link-app', 'checking') }, connecting('connecting', undefined, true)],
  ['verification', { ...SIGNED_OUT, operation: operation('sign-in', 'verifying') }, connecting('connecting', undefined, true)],
  ['cancellation', { ...SIGNED_OUT, operation: operation('sign-in', 'cancelling') }, connecting('connecting', undefined, false)],
  ['sign-out', { ...SIGNED_OUT, operation: operation('sign-out', 'signing-out') }, connecting('signing-out', undefined, false)],
  ['a sign-out check', { ...SIGNED_OUT, operation: operation('sign-out', 'checking') }, connecting('signing-out', undefined, false)],
])('presents %s', (name, state, expected) => {
  expect(presentConnection({ feishu: state, stopped: name === 'a stopped stream' })).toEqual(expected)
})

function fixture() {
  const queue: FeishuState[] = []
  let wake: (() => void) | undefined, closed = false, failure: Error | undefined, accepted = 0
  let options!: RemoteStreamOptions<FeishuState>
  const open = () => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (failure !== undefined) throw failure
        if (closed) return
        const next = queue.shift()
        if (next === undefined) { await new Promise<void>((resolve) => { wake = resolve }); continue }
        yield { value: next, accept: () => { accepted++ } }
      }
    },
    dispose: vi.fn(async () => { closed = true; wake?.() }),
  })
  const streams: Array<ReturnType<typeof open>> = []
  const ok = <T>(value: T) => ({ ok: true as const, value })
  const remote = {
    follow: vi.fn(),
    check: vi.fn(async () => ok(OP)),
    linkApp: vi.fn(async () => ok(OP)),
    signIn: vi.fn(async () => ok(OP)),
    signOut: vi.fn(async () => ok(OP)),
    cancel: vi.fn(async () => ok(undefined)),
  }
  const ctx = new Context()
  ctx.provide('remote', {
    feishu: remote,
    $stream: (value: typeof options) => {
      options = value
      closed = false
      failure = undefined
      streams.push(open())
      return streams.at(-1)
    },
  })
  const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
  const connection = new FeishuConnection(ctx)
  onTestFinished(async () => { await connection.dispose(); windowOpen.mockRestore(); await ctx.fiber.dispose() })
  const snapshot = () => connection.state.getSnapshot()
  return {
    connection, face: connection.face(), remote, open: windowOpen, streams, snapshot, options: () => options,
    get stream() { return streams.at(-1)! },
    async publish(state: FeishuState) {
      const target = accepted + 1
      queue.push(state)
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
    failOnClose(error: Error) { failure = error },
    fail(error: Error) { failure = error; wake?.() },
  }
}

const settle = async (b: ReturnType<typeof fixture>) => { await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) }) }

it('mirrors the Host view and opens the Host stream', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  b.options().open(signal)
  expect(b.remote.follow).toHaveBeenCalledWith(signal)
  expect(b.options().ended(true)).toBeInstanceOf(Error)
  await b.publish(SIGNED_OUT)
  expect(b.snapshot()).toMatchObject({ feishu: SIGNED_OUT, linked: true, busy: false })
  b.options().carrierFailed?.(new Error('lost'))
  expect(b.snapshot().linked).toBe(false)
})

it('opens each new link of an operation this browser started once, then reports each finished step', async () => {
  const b = fixture()
  const NO_APP: FeishuState = { account: { state: 'unconfigured' } }
  await b.publish(NO_APP)
  b.face.linkApp()
  await settle(b)
  expect(b.remote.linkApp).toHaveBeenCalledOnce()
  await b.publish({ ...NO_APP, operation: operation('link-app', 'configuring', 'https://open.feishu.cn/app') })
  await b.publish({ ...NO_APP, operation: operation('link-app', 'configuring', 'https://open.feishu.cn/app') })
  expect(b.open.mock.calls.map(call => call[0])).toEqual(['https://open.feishu.cn/app'])
  await b.publish({ ...SIGNED_OUT, result: { id: OP, kind: 'link-app', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'app-linked' })

  const SIGN_IN = 'op-2' as FeishuOperationId
  b.remote.signIn.mockResolvedValueOnce({ ok: true, value: SIGN_IN })
  b.face.signIn()
  await settle(b)
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', 'https://accounts.feishu.cn/device', SIGN_IN) })
  expect(b.open.mock.calls.map(call => call[0])).toEqual(['https://open.feishu.cn/app', 'https://accounts.feishu.cn/device'])
  b.face.openAuthorization()
  expect(b.open).toHaveBeenCalledTimes(3)
  await b.publish({ account: { state: 'connected', appId: APP }, result: { id: SIGN_IN, kind: 'sign-in', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 2, kind: 'connected' })
  await b.publish({ account: { state: 'connected', appId: APP }, result: { id: SIGN_IN, kind: 'sign-in', outcome: 'succeeded' } })
  expect(b.snapshot().notice?.seq).toBe(2)
  b.face.dismissNotice()
  expect(b.snapshot().notice).toBeUndefined()
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

it('opens a link the stream reported before the start answered, never a foreign operation, and only over HTTPS', async () => {
  const b = fixture()
  const answer = Promise.withResolvers<{ ok: true; value: FeishuOperationId }>()
  b.remote.signIn.mockReturnValueOnce(answer.promise)
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', 'https://accounts.feishu.cn/other', 'other' as FeishuOperationId) })
  b.face.signIn()
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', 'https://accounts.feishu.cn/device') })
  expect(b.open).not.toHaveBeenCalled()
  answer.resolve({ ok: true, value: OP })
  await vi.waitFor(() => { expect(b.open).toHaveBeenCalledWith('https://accounts.feishu.cn/device', '_blank', 'noopener,noreferrer') })
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing', 'http://accounts.feishu.cn/device') })
  b.face.openAuthorization()
  expect(b.open).toHaveBeenCalledOnce()
})

it('starts before the first view and reports no notice for a failed sign-in', async () => {
  const b = fixture()
  b.face.signIn()
  await settle(b)
  await b.publish({ ...SIGNED_OUT, result: { id: OP, kind: 'sign-in', outcome: 'failed' } })
  expect(b.snapshot().notice).toBeUndefined()
})

it('retains the Host app-link failure details without reporting success', async () => {
  const b = fixture()
  b.face.linkApp()
  await settle(b)
  const failed: FeishuState = {
    account: { state: 'unconfigured' },
    result: {
      id: OP, kind: 'link-app', outcome: 'failed',
      failure: { command: 'config-init', exitCode: 1, type: 'internal', subtype: 'sdk_error' },
    },
  }
  await b.publish(failed)
  expect(b.snapshot().feishu).toEqual(failed)
  expect(b.snapshot().notice).toBeUndefined()
  expect(presentConnection(b.snapshot())).toEqual({ phase: 'disconnected', next: 'link-app', failed: true })
})

it('cancels only a cancellable operation and reports a finished sign-out', async () => {
  const b = fixture()
  await b.publish({ account: { state: 'connected', appId: APP } })
  b.face.cancel()
  b.face.openAuthorization()
  b.face.signOut()
  await settle(b)
  await b.publish({ account: { state: 'connected', appId: APP }, operation: operation('sign-out', 'signing-out') })
  b.face.cancel()
  expect(b.remote.cancel).not.toHaveBeenCalled()
  await b.publish({ account: { state: 'signed-out', appId: APP }, result: { id: OP, kind: 'sign-out', outcome: 'succeeded' } })
  expect(b.snapshot().notice?.kind).toBe('signed-out')
  await b.publish({ ...SIGNED_OUT, operation: operation('sign-in', 'authorizing') })
  b.face.cancel()
  await settle(b)
  expect(b.remote.cancel).toHaveBeenCalledWith(OP)
})

it('reports a failed action once and ignores overlapping clicks', async () => {
  const b = fixture()
  await b.publish(SIGNED_OUT)
  b.remote.signIn.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) } as never)
  b.face.signIn()
  b.face.signOut()
  await vi.waitFor(() => { expect(b.snapshot().notice?.kind).toBe('action-failed') })
  expect(b.remote.signOut).not.toHaveBeenCalled()
})

it('reports nothing after disposal and marks the page offline when the stream fails', async () => {
  const b = fixture()
  await b.publish(SIGNED_OUT)
  const answer = Promise.withResolvers<{ ok: true; value: FeishuOperationId }>()
  b.remote.signOut.mockReturnValueOnce(answer.promise)
  b.face.signOut()
  b.failOnClose(new Error('closed'))
  await b.connection.dispose()
  answer.resolve({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) } as never)
  await settle(b)
  expect(b.stream.dispose).toHaveBeenCalled()
  expect(b.snapshot()).toMatchObject({ linked: true, notice: undefined })

  const c = fixture()
  await c.publish(SIGNED_OUT)
  c.fail(new Error('invalid frame'))
  await vi.waitFor(() => { expect(c.snapshot()).toMatchObject({ linked: false, stopped: true }) })
})

it('reopens a stopped Host stream on retry and ignores retry while the stream runs', async () => {
  const b = fixture()
  b.face.retry()
  await b.publish(SIGNED_OUT)
  expect(b.streams).toHaveLength(1)
  b.fail(new Error('gateway/invocation-unavailable'))
  await vi.waitFor(() => { expect(b.snapshot().stopped).toBe(true) })
  expect(presentConnection(b.snapshot())).toEqual({ phase: 'stopped' })
  b.face.retry()
  await vi.waitFor(() => { expect(b.streams).toHaveLength(2) })
  expect(b.streams[0]?.dispose).toHaveBeenCalled()
  expect(b.snapshot()).toMatchObject({ feishu: undefined, stopped: false })
  await b.publish({ account: { state: 'connected', appId: APP } })
  expect(b.snapshot()).toMatchObject({ linked: true, stopped: false, feishu: { account: { state: 'connected', appId: APP } } })
})
