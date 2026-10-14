// @vitest-environment jsdom
/** The page derives the WeCom authorization from the Host's view and drives operations through its Remote. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createConnection, presentConnection, type ConnectionPresentation } from '../src/client/connection.ts'

type Operation = NonNullable<WecomState['operation']>

const OP = 'op-1' as CliOperationId
const UNAUTHORIZED: WecomState = { account: { state: 'unauthorized' } }
const FAILED_CONNECT: NonNullable<WecomState['result']> = { id: OP, kind: 'connect', outcome: 'failed', failure: { command: 'auth-init', exitCode: 2 } }
const FAILED_CHECK: NonNullable<WecomState['result']> = { id: OP, kind: 'check', outcome: 'failed', failure: { command: 'auth-status', exitCode: 1 } }

function operation(kind: Operation['kind'], phase: Operation['phase'], cancellable = false, authorizationUrl?: string): Operation {
  return { id: OP, kind, phase, cancellable, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

it.each<[string, WecomState | undefined, ConnectionPresentation]>([
  ['a stopped stream', UNAUTHORIZED, { phase: 'stopped', failed: undefined }],
  ['no view yet', undefined, { phase: 'checking', failed: undefined }],
  ['an unchecked authorization', { account: { state: 'unchecked' } }, { phase: 'checking', failed: undefined }],
  ['a check', { ...UNAUTHORIZED, operation: operation('check', 'checking') }, { phase: 'checking', failed: undefined }],
  ['a first check that failed', { account: { state: 'unchecked' }, result: FAILED_CHECK }, { phase: 'unavailable', failed: FAILED_CHECK }],
  ['no authorization', UNAUTHORIZED, { phase: 'disconnected', failed: undefined }],
  ['a failed connection', { ...UNAUTHORIZED, result: FAILED_CONNECT }, { phase: 'disconnected', failed: FAILED_CONNECT }],
  ['a cancelled connection', { ...UNAUTHORIZED, result: { id: OP, kind: 'connect', outcome: 'cancelled' } }, { phase: 'disconnected', failed: undefined }],
  ['an authorized bot', { account: { state: 'authorized' } }, { phase: 'connected', failed: undefined }],
  ['a QR-code scan', { ...UNAUTHORIZED, operation: operation('connect', 'authorizing', true, 'https://work.weixin.qq.com/qr') },
    { phase: 'connecting', step: 'authorizing', url: 'https://work.weixin.qq.com/qr', cancellable: true }],
  ['a confirmation', { ...UNAUTHORIZED, operation: operation('connect', 'checking') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
  ['cancellation', { ...UNAUTHORIZED, operation: operation('connect', 'cancelling') }, { phase: 'connecting', step: 'connecting', url: undefined, cancellable: false }],
])('presents %s', (name, view, expected) => {
  expect(presentConnection({ view, stopped: name === 'a stopped stream' })).toEqual(expected)
})

function fixture() {
  const queue: WecomState[] = []
  let wake: (() => void) | undefined, closed = false, accepted = 0
  let options!: RemoteStreamOptions<WecomState>
  const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
  const remote = {
    follow: vi.fn(),
    check: vi.fn(async () => ok(OP)),
    connect: vi.fn(async () => ok(OP)),
    cancel: vi.fn(async (_id: CliOperationId) => ok(undefined)),
  }
  const ctx = new Context()
  ctx.provide('remote', {
    wecom: remote,
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
    async publish(view: WecomState) {
      const target = accepted + 1
      queue.push(view)
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
  }
}

const settle = async (b: ReturnType<typeof fixture>) => { await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) }) }

it('follows the wecom Remote and exposes the mirror to the page', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  b.options().open(signal)
  expect(b.remote.follow).toHaveBeenCalledWith(signal)
  await b.publish(UNAUTHORIZED)
  expect(b.face.hooks.wecomConnection.getSnapshot()).toMatchObject({ view: UNAUTHORIZED, linked: true, busy: false })
})

it('connects through the Remote, opens the QR-code page once, and reports the authorization', async () => {
  const b = fixture()
  await b.publish(UNAUTHORIZED)
  b.face.connect()
  await settle(b)
  expect(b.remote.connect).toHaveBeenCalledOnce()
  await b.publish({ ...UNAUTHORIZED, operation: operation('connect', 'authorizing', true, 'https://work.weixin.qq.com/qr') })
  await b.publish({ ...UNAUTHORIZED, operation: operation('connect', 'authorizing', true, 'https://work.weixin.qq.com/qr') })
  expect(b.open.mock.calls.map(call => call[0])).toEqual(['https://work.weixin.qq.com/qr'])
  b.face.cancel()
  await settle(b)
  expect(b.remote.cancel).toHaveBeenCalledWith(OP)
  await b.publish({ account: { state: 'authorized' }, result: { id: OP, kind: 'connect', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'connected' })
})

it('checks again without a notice', async () => {
  const b = fixture()
  await b.publish({ account: { state: 'unchecked' }, result: FAILED_CHECK })
  b.face.check()
  await settle(b)
  expect(b.remote.check).toHaveBeenCalledOnce()
  await b.publish({ ...UNAUTHORIZED, result: { id: OP, kind: 'check', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toBeUndefined()
})
