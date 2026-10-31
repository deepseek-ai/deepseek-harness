// @vitest-environment jsdom
/** The connection follows every registered account through one Host stream and keeps each account's browser state apart. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { CliAccountEntry, CliAccountsView, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { CliAccountsConnection } from '../src/client/connection.ts'

const OP = 'op-1' as CliOperationId
const FIXTURE = '@acme/fixture'
const OTHER = '@acme/other'
const COPY = { title: 'Fixture account', hint: 'Shared.', activation: { title: 'Connect', body: 'On.', connect: 'Connect' } }
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const failed = (): RemoteResult<never> => ({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }) as never

function entry(packageName: string, extra: Partial<CliAccountEntry> = {}): CliAccountEntry {
  return { packageName, copy: COPY, display: { phase: 'disconnected', status: 'Not connected', buttons: [], notes: [] }, ...extra }
}

const waiting = (url?: string, id = OP): Partial<CliAccountEntry> =>
  ({ operation: { id, ...url === undefined ? {} : { authorizationUrl: url } } })

function fixture() {
  const queue: CliAccountsView[] = []
  let wake: (() => void) | undefined, closed = false, failure: Error | undefined, accepted = 0
  let options!: RemoteStreamOptions<CliAccountsView>
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
  const remote = {
    watch: vi.fn(),
    start: vi.fn(async (_packageName: string, _operation: string) => ok(OP)),
    cancel: vi.fn(async (_packageName: string, _id: CliOperationId): Promise<RemoteResult<void>> => ok(undefined)),
  }
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
  const connection = new CliAccountsConnection(ctx, remote)
  onTestFinished(async () => { await connection.dispose(); windowOpen.mockRestore(); await ctx.fiber.dispose() })
  return {
    connection, remote, open: windowOpen, streams, options: () => options,
    get stream() { return streams.at(-1)! },
    snapshot: (packageName = FIXTURE) => connection.accounts.getSnapshot().get(packageName)?.getSnapshot(),
    act: (packageName = FIXTURE) => connection.actions(packageName),
    deliver(view: CliAccountsView) { queue.push(view); wake?.() },
    async publish(...entries: CliAccountEntry[]) {
      const target = accepted + 1
      this.deliver({ accounts: entries })
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
    failOnClose(error: Error) { failure = error },
    fail(error: Error) { failure = error; wake?.() },
  }
}

const settle = async (b: ReturnType<typeof fixture>, packageName = FIXTURE) => {
  await vi.waitFor(() => { expect(b.snapshot(packageName)?.busy).toBe(false) })
}
// Every fixture step settles through microtasks, so one macrotask lets a pending reopen or start finish.
const drain = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

it('mirrors the registered accounts through the watch stream', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  void b.options().open(signal)
  expect(b.remote.watch).toHaveBeenCalledWith(signal)
  expect(b.options().ended(true).message).toBe('CLI accounts stream ended')
  await b.publish(entry(FIXTURE), entry(OTHER))
  const published = b.connection.accounts.getSnapshot()
  expect([...published.keys()]).toEqual([FIXTURE, OTHER])
  expect(b.snapshot()).toMatchObject({ entry: entry(FIXTURE), linked: true, stopped: false, busy: false, notice: undefined })
  b.options().carrierFailed?.(new Error('lost'))
  expect(b.snapshot()?.linked).toBe(false)
  expect(b.snapshot(OTHER)?.linked).toBe(false)

  await b.publish(entry(OTHER), entry(FIXTURE))
  expect(b.connection.accounts.getSnapshot()).toBe(published)
  await b.publish(entry(OTHER))
  expect([...b.connection.accounts.getSnapshot().keys()]).toEqual([OTHER])
  expect(b.snapshot()).toBeUndefined()
  b.act().run({ kind: 'open' })
  b.act().dismissNotice()
  expect(b.remote.start).not.toHaveBeenCalled()
})

it('opens each new link of an operation this browser started once and reports the Host notice of its success', async () => {
  const b = fixture()
  await b.publish(entry(FIXTURE), entry(OTHER))
  b.act().run({ kind: 'start', operation: 'connect' })
  await settle(b)
  expect(b.remote.start).toHaveBeenCalledWith(FIXTURE, 'connect')
  await b.publish(entry(FIXTURE, waiting('https://example.com/a')), entry(OTHER, waiting('https://example.com/other')))
  await b.publish(entry(FIXTURE, waiting('https://example.com/a')), entry(OTHER))
  expect(b.open.mock.calls).toEqual([['https://example.com/a', '_blank', 'noopener,noreferrer']])
  b.act().run({ kind: 'open' })
  expect(b.open).toHaveBeenCalledTimes(2)
  await b.publish(entry(FIXTURE, { result: { id: OP, notice: 'Connected' } }), entry(OTHER))
  expect(b.snapshot()?.notice).toEqual({ seq: 1, kind: 'succeeded', text: 'Connected' })
  expect(b.snapshot(OTHER)?.notice).toBeUndefined()
  await b.publish(entry(FIXTURE, { result: { id: OP, notice: 'Connected' } }), entry(OTHER))
  expect(b.snapshot()?.notice?.seq).toBe(1)
  b.act().dismissNotice()
  expect(b.snapshot()?.notice).toBeUndefined()
})

it('reports nothing for a result without a notice or for another operation', async () => {
  const b = fixture()
  await b.publish(entry(FIXTURE))
  b.act().run({ kind: 'start', operation: 'check' })
  await settle(b)
  await b.publish(entry(FIXTURE, { result: { id: 'other' as CliOperationId, notice: 'Other' } }))
  await b.publish(entry(FIXTURE, { result: { id: OP } }))
  await b.publish(entry(FIXTURE, { result: { id: OP, notice: 'Late' } }))
  expect(b.snapshot()?.notice).toBeUndefined()
})

it('opens a link reported before the start answered, never a foreign operation, and only over HTTPS', async () => {
  const b = fixture()
  const answer = Promise.withResolvers<RemoteResult<CliOperationId>>()
  await b.publish(entry(FIXTURE, waiting('https://example.com/other', 'other' as CliOperationId)))
  b.remote.start.mockReturnValueOnce(answer.promise)
  b.act().run({ kind: 'start', operation: 'connect' })
  await b.publish(entry(FIXTURE, waiting('https://example.com/device')))
  expect(b.open).not.toHaveBeenCalled()
  answer.resolve(ok(OP))
  await vi.waitFor(() => { expect(b.open).toHaveBeenCalledWith('https://example.com/device', '_blank', 'noopener,noreferrer') })
  await b.publish(entry(FIXTURE, waiting('http://example.com/device')))
  b.act().run({ kind: 'open' })
  await b.publish(entry(FIXTURE, waiting('not a url')))
  b.act().run({ kind: 'open' })
  expect(b.open).toHaveBeenCalledOnce()
})

it('follows no operation after a rejected start and reports the failed action once', async () => {
  const b = fixture()
  await b.publish(entry(FIXTURE))
  b.act().run({ kind: 'start', operation: 'connect' })
  await settle(b)
  b.remote.start.mockResolvedValueOnce(failed())
  b.act().run({ kind: 'start', operation: 'connect' })
  await settle(b)
  expect(b.snapshot()?.notice).toEqual({ seq: 1, kind: 'action-failed' })
  await b.publish(entry(FIXTURE, waiting('https://example.com/b')))
  await b.publish(entry(FIXTURE, { result: { id: OP, notice: 'Connected' } }))
  expect(b.open).not.toHaveBeenCalled()
  expect(b.snapshot()?.notice).toEqual({ seq: 1, kind: 'action-failed' })
})

it('asks the Host to cancel the operation in progress, and ignores clicks while one action is pending', async () => {
  const b = fixture()
  await b.publish(entry(FIXTURE))
  b.act().run({ kind: 'cancel' })
  expect(b.remote.cancel).not.toHaveBeenCalled()
  await b.publish(entry(FIXTURE, waiting()))
  const answer = Promise.withResolvers<RemoteResult<void>>()
  b.remote.cancel.mockReturnValueOnce(answer.promise)
  b.act().run({ kind: 'cancel' })
  b.act().run({ kind: 'start', operation: 'connect' })
  expect(b.snapshot()?.busy).toBe(true)
  answer.resolve(ok(undefined))
  await settle(b)
  expect(b.remote.cancel).toHaveBeenCalledExactlyOnceWith(FIXTURE, OP)
  expect(b.remote.start).not.toHaveBeenCalled()
})

it('reports nothing after disposal and marks every account stopped when the stream fails', async () => {
  const b = fixture()
  await b.publish(entry(FIXTURE))
  const answer = Promise.withResolvers<RemoteResult<CliOperationId>>()
  b.remote.start.mockReturnValueOnce(answer.promise)
  b.act().run({ kind: 'start', operation: 'connect' })
  b.failOnClose(new Error('closed'))
  await b.connection.dispose()
  answer.resolve(failed())
  await settle(b)
  expect(b.stream.dispose).toHaveBeenCalled()
  expect(b.snapshot()).toMatchObject({ linked: true, stopped: false, notice: undefined })

  const c = fixture()
  await c.publish(entry(FIXTURE), entry(OTHER))
  c.fail(new Error('invalid frame'))
  await vi.waitFor(() => { expect(c.snapshot()).toMatchObject({ linked: false, stopped: true }) })
  expect(c.snapshot(OTHER)).toMatchObject({ linked: false, stopped: true })
})

it('opens no link for a start that answers after disposal, and ignores a view yielded after disposal', async () => {
  const b = fixture()
  await b.publish(entry(FIXTURE))
  const answer = Promise.withResolvers<RemoteResult<CliOperationId>>()
  b.remote.start.mockReturnValueOnce(answer.promise)
  b.act().run({ kind: 'start', operation: 'connect' })
  await b.publish(entry(FIXTURE, waiting('https://example.com/device')))
  b.deliver({ accounts: [entry(FIXTURE, waiting('https://example.com/late'))] })
  await b.connection.dispose()
  answer.resolve(ok(OP))
  await drain()
  expect(b.open).not.toHaveBeenCalled()
  expect(b.snapshot()?.entry).toEqual(entry(FIXTURE, waiting('https://example.com/device')))
})

it('reopens a stopped stream once for repeated retries, ignores retry while it runs, and opens none after disposal', async () => {
  const b = fixture()
  b.act().retry()
  await b.publish(entry(FIXTURE))
  expect(b.streams).toHaveLength(1)
  b.fail(new Error('gone'))
  await vi.waitFor(() => { expect(b.snapshot()?.stopped).toBe(true) })
  b.act().retry()
  b.act().retry()
  await vi.waitFor(() => { expect(b.streams).toHaveLength(2) })
  expect(b.snapshot()?.stopped).toBe(false)
  await b.publish(entry(FIXTURE))
  expect(b.snapshot()).toMatchObject({ linked: true, stopped: false })

  b.fail(new Error('gone again'))
  await vi.waitFor(() => { expect(b.snapshot()?.stopped).toBe(true) })
  b.act().retry()
  await b.connection.dispose()
  await drain()
  expect(b.streams).toHaveLength(2)
  b.act().retry()
  expect(b.streams).toHaveLength(2)
})
