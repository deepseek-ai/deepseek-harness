// @vitest-environment jsdom
/** The connection mirror follows a plugin's Host view and drives its account operations through the plugin's Remote. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { CliAccountView, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CliAccountConnection } from '../src/index.ts'

type View = CliAccountView<{ readonly state: 'out' | 'in' }, 'check' | 'connect' | 'leave', 'authorizing' | 'leaving'>
type Notice = 'connected' | 'left'

const OP = 'op-1' as CliOperationId
const OUT: View = { account: { state: 'out' } }

type Operation = NonNullable<View['operation']>

function operation(
  kind: Operation['kind'], phase: Operation['phase'], options: { url?: string; cancellable?: boolean; id?: CliOperationId } = {},
): Operation {
  const link = options.url === undefined ? {} : { authorizationUrl: options.url }
  return { id: options.id ?? OP, kind, phase, cancellable: options.cancellable ?? false, ...link }
}

function fixture() {
  const queue: View[] = []
  let wake: (() => void) | undefined, closed = false, failure: Error | undefined, accepted = 0
  let options!: RemoteStreamOptions<View>
  const open = () => ({
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (failure !== undefined) throw failure
        // A queued item still arrives after close, as an item the stream yielded just before disposal does.
        const next = queue.shift()
        if (next !== undefined) { yield { value: next, accept: () => { accepted++ } }; continue }
        if (closed) return
        await new Promise<void>((resolve) => { wake = resolve })
      }
    },
    dispose: vi.fn(async () => { closed = true; wake?.() }),
  })
  const streams: Array<ReturnType<typeof open>> = []
  const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
  const follow = vi.fn()
  const cancel = vi.fn(async (_id: CliOperationId) => ok(undefined))
  const start = vi.fn(async () => ok(OP))
  const ctx = new Context()
  ctx.provide('remote', {
    $stream: (value: typeof options) => {
      options = value
      closed = false
      failure = undefined
      streams.push(open())
      return streams.at(-1)
    },
  })
  const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
  const connection = new CliAccountConnection<View, Notice>(ctx, {
    name: 'Fixture connection', follow, cancel, notices: { connect: 'connected', leave: 'left' },
  })
  onTestFinished(async () => { await connection.dispose(); windowOpen.mockRestore(); await ctx.fiber.dispose() })
  return {
    connection, follow, cancel, start, open: windowOpen, streams, options: () => options,
    snapshot: () => connection.state.getSnapshot(),
    get stream() { return streams.at(-1)! },
    deliver(view: View) {
      queue.push(view)
      wake?.()
    },
    async publish(view: View) {
      const target = accepted + 1
      this.deliver(view)
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
    failOnClose(error: Error) { failure = error },
    fail(error: Error) { failure = error; wake?.() },
  }
}

const settle = async (b: ReturnType<typeof fixture>) => { await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) }) }
// Every fixture step settles through microtasks, so one macrotask lets a pending reopen or start finish.
const drain = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })
const SECOND = 'op-2' as CliOperationId

it('mirrors the Host view through the plugin stream', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  void b.options().open(signal)
  expect(b.follow).toHaveBeenCalledWith(signal)
  expect(b.options().name).toBe('Fixture connection')
  expect(b.options().ended(true).message).toBe('Fixture connection stream ended')
  await b.publish(OUT)
  expect(b.snapshot()).toMatchObject({ view: OUT, linked: true, stopped: false, busy: false })
  b.options().carrierFailed?.(new Error('lost'))
  expect(b.snapshot().linked).toBe(false)
})

it('opens each new link of an operation this browser started once and reports mapped successes', async () => {
  const b = fixture()
  await b.publish(OUT)
  b.connection.start(b.start)
  await settle(b)
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/a', cancellable: true }) })
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/a', cancellable: true }) })
  expect(b.open.mock.calls).toEqual([['https://example.com/a', '_blank', 'noopener,noreferrer']])
  b.connection.actions.openAuthorization()
  expect(b.open).toHaveBeenCalledTimes(2)
  await b.publish({ account: { state: 'in' }, result: { id: OP, kind: 'connect', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'connected' })
  await b.publish({ account: { state: 'in' }, result: { id: OP, kind: 'connect', outcome: 'succeeded' } })
  expect(b.snapshot().notice?.seq).toBe(1)
  b.connection.actions.dismissNotice()
  expect(b.snapshot().notice).toBeUndefined()
})

it('reports no notice for an unmapped kind or an unsuccessful outcome', async () => {
  const b = fixture()
  b.connection.start(b.start)
  await settle(b)
  await b.publish({ ...OUT, result: { id: OP, kind: 'check', outcome: 'succeeded' } })
  b.connection.start(async () => ({ ok: true, value: SECOND }))
  await settle(b)
  await b.publish({ ...OUT, result: { id: SECOND, kind: 'connect', outcome: 'failed', failure: { command: 'login', exitCode: 1 } } })
  expect(b.snapshot().notice).toBeUndefined()
})

it('opens a link reported before the start answered, never a foreign operation, and only over HTTPS', async () => {
  const b = fixture()
  const answer = Promise.withResolvers<RemoteResult<CliOperationId>>()
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/other', id: 'other' as CliOperationId }) })
  b.connection.start(() => answer.promise)
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/device' }) })
  expect(b.open).not.toHaveBeenCalled()
  answer.resolve({ ok: true, value: OP })
  await vi.waitFor(() => { expect(b.open).toHaveBeenCalledWith('https://example.com/device', '_blank', 'noopener,noreferrer') })
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'http://example.com/device' }) })
  b.connection.actions.openAuthorization()
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'not a url' }) })
  b.connection.actions.openAuthorization()
  expect(b.open).toHaveBeenCalledOnce()
})

it('opens a link again when a later operation this browser started offers the same link', async () => {
  const b = fixture()
  const device = 'https://example.com/device'
  b.connection.start(b.start)
  await settle(b)
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: device, cancellable: true }) })
  await b.publish({ ...OUT, result: { id: OP, kind: 'connect', outcome: 'cancelled' } })
  b.connection.start(async () => ({ ok: true, value: SECOND }))
  await settle(b)
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: device, id: SECOND }) })
  expect(b.open.mock.calls).toEqual([[device, '_blank', 'noopener,noreferrer'], [device, '_blank', 'noopener,noreferrer']])
})

it('keeps following its operation when another operation\'s result arrives after the start', async () => {
  const b = fixture()
  b.connection.start(b.start)
  await settle(b)
  await b.publish({ ...OUT, result: { id: 'other' as CliOperationId, kind: 'connect', outcome: 'succeeded' } })
  expect(b.snapshot().notice).toBeUndefined()
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/device' }) })
  await b.publish({ account: { state: 'in' }, result: { id: OP, kind: 'connect', outcome: 'succeeded' } })
  expect(b.open).toHaveBeenCalledOnce()
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'connected' })
})

it('follows no operation after a rejected start', async () => {
  const b = fixture()
  b.connection.start(b.start)
  await settle(b)
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/a' }) })
  b.connection.start(async () => ({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }) as never)
  await settle(b)
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'action-failed' })
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/b' }) })
  await b.publish({ account: { state: 'in' }, result: { id: OP, kind: 'connect', outcome: 'succeeded' } })
  expect(b.open.mock.calls).toEqual([['https://example.com/a', '_blank', 'noopener,noreferrer']])
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'action-failed' })
})

it('cancels only an operation the Host marks cancellable', async () => {
  const b = fixture()
  b.connection.actions.cancel()
  await b.publish({ ...OUT, operation: operation('leave', 'leaving') })
  b.connection.actions.cancel()
  b.connection.actions.openAuthorization()
  expect(b.cancel).not.toHaveBeenCalled()
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { cancellable: true }) })
  b.connection.actions.cancel()
  await settle(b)
  expect(b.cancel).toHaveBeenCalledWith(OP)
  expect(b.open).not.toHaveBeenCalled()
})

it('reports a failed action once and ignores overlapping clicks', async () => {
  const b = fixture()
  await b.publish(OUT)
  const second = vi.fn(async () => ({ ok: true as const, value: OP }))
  b.connection.start(async () => ({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }) as never)
  b.connection.start(second)
  await vi.waitFor(() => { expect(b.snapshot().notice?.kind).toBe('action-failed') })
  expect(second).not.toHaveBeenCalled()
})

it('reports nothing after disposal and marks the page stopped when the stream fails', async () => {
  const b = fixture()
  await b.publish(OUT)
  const answer = Promise.withResolvers<RemoteResult<CliOperationId>>()
  b.connection.start(() => answer.promise)
  b.failOnClose(new Error('closed'))
  await b.connection.dispose()
  answer.resolve({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) } as never)
  await settle(b)
  expect(b.stream.dispose).toHaveBeenCalled()
  expect(b.snapshot()).toMatchObject({ linked: true, notice: undefined })

  const c = fixture()
  await c.publish(OUT)
  c.fail(new Error('invalid frame'))
  await vi.waitFor(() => { expect(c.snapshot()).toMatchObject({ linked: false, stopped: true }) })
})

it('opens no link for a start that answers after disposal', async () => {
  const b = fixture()
  const answer = Promise.withResolvers<RemoteResult<CliOperationId>>()
  b.connection.start(() => answer.promise)
  await b.publish({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/device' }) })
  await b.connection.dispose()
  answer.resolve({ ok: true, value: OP })
  await settle(b)
  expect(b.open).not.toHaveBeenCalled()
})

it('ignores a Host view the stream yields after disposal', async () => {
  const b = fixture()
  await b.publish(OUT)
  b.connection.start(b.start)
  await settle(b)
  b.deliver({ ...OUT, operation: operation('connect', 'authorizing', { url: 'https://example.com/late' }) })
  await b.connection.dispose()
  expect(b.open).not.toHaveBeenCalled()
  expect(b.snapshot().view).toEqual(OUT)
})

it('reopens a stopped Host stream on retry and ignores retry while the stream runs', async () => {
  const b = fixture()
  b.connection.actions.retry()
  await b.publish(OUT)
  expect(b.streams).toHaveLength(1)
  b.fail(new Error('gone'))
  await vi.waitFor(() => { expect(b.snapshot().stopped).toBe(true) })
  b.connection.actions.retry()
  await vi.waitFor(() => { expect(b.streams).toHaveLength(2) })
  expect(b.snapshot()).toMatchObject({ view: undefined, stopped: false })
  await b.publish(OUT)
  expect(b.snapshot()).toMatchObject({ view: OUT, linked: true })

  await b.connection.dispose()
  b.connection.actions.retry()
  expect(b.streams).toHaveLength(2)
})

it('opens no stream for a retry that disposal overtakes', async () => {
  const b = fixture()
  await b.publish(OUT)
  b.fail(new Error('gone'))
  await vi.waitFor(() => { expect(b.snapshot().stopped).toBe(true) })
  b.connection.actions.retry()
  await b.connection.dispose()
  await drain()
  expect(b.streams).toHaveLength(1)
})

it('reopens one stream for repeated retries and closes that stream on disposal', async () => {
  const b = fixture()
  await b.publish(OUT)
  b.fail(new Error('gone'))
  await vi.waitFor(() => { expect(b.snapshot().stopped).toBe(true) })
  b.connection.actions.retry()
  b.connection.actions.retry()
  await drain()
  expect(b.streams).toHaveLength(2)
  await b.connection.dispose()
  expect(b.stream.dispose).toHaveBeenCalled()
})
