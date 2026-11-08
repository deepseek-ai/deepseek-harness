// @vitest-environment jsdom
/** The browser follows every registered account through one Host stream and keeps only what this browser started. */
import { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BrowserAccounts, openAuthorizationPage } from '../src/client/state.ts'
import type { ConnectorAccountEntry, ConnectorAccountsView, ConnectorOperationId } from '../src/types.ts'

const OP = 'op-1' as ConnectorOperationId
const NEXT = 'op-2' as ConnectorOperationId
const FIXTURE = '@acme/fixture'
const OTHER = 'mcp:other'
const COPY = { title: 'Fixture account', hint: 'Shared.', activation: { title: 'Connect', body: 'On.', connect: 'Connect' } }

function entry(key: string, extra: Partial<ConnectorAccountEntry> = {}): ConnectorAccountEntry {
  return { key, copy: COPY, display: { phase: 'disconnected', status: 'Not connected', buttons: [], notes: [] }, ...extra }
}

const waiting = (url?: string, id = OP): Partial<ConnectorAccountEntry> =>
  ({ operation: { id, ...url === undefined ? {} : { authorizationUrl: url } } })

function fixture() {
  const queue: ConnectorAccountsView[] = []
  let wake: (() => void) | undefined, closed = false, failure: Error | undefined, accepted = 0
  let options!: RemoteStreamOptions<ConnectorAccountsView>
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
  const remote = { watch: vi.fn() }
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
  const browser = new BrowserAccounts(ctx, remote)
  onTestFinished(async () => { await browser.dispose(); windowOpen.mockRestore(); await ctx.fiber.dispose() })
  return {
    ctx, browser, remote, open: windowOpen, streams, options: () => options,
    state: () => browser.state.getSnapshot(),
    deliver(view: ConnectorAccountsView) { queue.push(view); wake?.() },
    async publish(...entries: ConnectorAccountEntry[]) {
      const target = accepted + 1
      this.deliver({ accounts: entries })
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
    fail(error: Error) { failure = error; wake?.() },
  }
}

it('mirrors the Host accounts by key and reports carrier loss until the next item', async () => {
  const b = fixture()
  expect(b.state()).toEqual({ accounts: new Map(), linked: true, notice: undefined })
  const open = b.options().open(new AbortController().signal)
  expect(b.remote.watch).toHaveBeenCalledOnce()
  expect(open).toBe(b.remote.watch.mock.results[0]?.value)
  await b.publish(entry(FIXTURE), entry(OTHER))
  expect([...b.state().accounts.keys()]).toEqual([FIXTURE, OTHER])
  b.options().carrierFailed?.(new RemoteStreamCarrierError('offline'))
  expect(b.state().linked).toBe(false)
  await b.publish(entry(FIXTURE))
  expect(b.state().linked).toBe(true)
  expect([...b.state().accounts.keys()]).toEqual([FIXTURE])
  expect(b.options().ended(true).message).toBe('Connector accounts stream ended')
})

it('opens each new authorization page of an operation this browser started once, and no other account\'s', async () => {
  const b = fixture()
  b.browser.follow(FIXTURE, OP)
  await b.publish(entry(FIXTURE, waiting('https://example.com/a')), entry(OTHER, waiting('https://example.com/other')))
  expect(b.open.mock.calls).toEqual([['https://example.com/a', '_blank', 'noopener,noreferrer']])
  await b.publish(entry(FIXTURE, waiting('https://example.com/a')))
  await b.publish(entry(FIXTURE, waiting('http://127.0.0.1:8123/authorize')))
  // Another browser's operation on the same account opens nothing here.
  await b.publish(entry(FIXTURE, waiting('https://example.com/b', NEXT)))
  expect(b.open.mock.calls.map(([url]) => url)).toEqual(['https://example.com/a', 'http://127.0.0.1:8123/authorize'])
})

it('opens the page at once when the stream delivered the operation before the start call answered', async () => {
  const b = fixture()
  await b.publish(entry(FIXTURE, waiting('https://example.com/a')))
  expect(b.open).not.toHaveBeenCalled()
  b.browser.follow(FIXTURE, OP)
  expect(b.open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
})

it('reports the success of an operation this browser started once, and stops following it', async () => {
  const b = fixture()
  b.browser.follow(FIXTURE, OP)
  await b.publish(entry(FIXTURE, { result: { id: NEXT, notice: 'Other browser connected' } }))
  expect(b.state().notice).toBeUndefined()
  await b.publish(entry(FIXTURE, { result: { id: OP, notice: 'Fixture connected' } }))
  expect(b.state().notice).toEqual({ seq: 1, kind: 'succeeded', text: 'Fixture connected' })
  b.browser.dismissNotice()
  await b.publish(entry(FIXTURE, { result: { id: OP, notice: 'Fixture connected' } }))
  expect(b.state().notice).toBeUndefined()

  // A result without the registrant's text, or a cancelled or failed one, reports nothing.
  b.browser.follow(FIXTURE, NEXT)
  await b.publish(entry(FIXTURE, { result: { id: NEXT } }))
  expect(b.state().notice).toBeUndefined()
})

it('forgets the operation of an account the Host withdrew', async () => {
  const b = fixture()
  b.browser.follow(FIXTURE, OP)
  await b.publish(entry(OTHER))
  await b.publish(entry(FIXTURE, waiting('https://example.com/a')))
  expect(b.open).not.toHaveBeenCalled()
})

it('reports a call that did not finish with a fresh notice each time', () => {
  const b = fixture()
  b.browser.failed()
  b.browser.failed()
  expect(b.state().notice).toEqual({ seq: 2, kind: 'action-failed' })
})

it('keeps the buttons disabled and logs a terminal stream failure, opening no second stream', async () => {
  const b = fixture()
  const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => {})
  await b.publish(entry(FIXTURE))
  b.fail(new Error('Host without the registry'))
  await vi.waitFor(() => { expect(b.state().linked).toBe(false) })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('connector accounts stream failed'), expect.any(Error))
  expect(b.streams).toHaveLength(1)
  expect([...b.state().accounts.keys()]).toEqual([FIXTURE])
})

it('opens nothing and reports nothing after disposal', async () => {
  const b = fixture()
  await b.browser.dispose()
  b.browser.follow(FIXTURE, OP)
  b.browser.failed()
  expect(b.state().notice).toBeUndefined()
})

it('shows nothing for a stream that fails while the page disposes it', async () => {
  const b = fixture()
  const disposing = b.browser.dispose()
  b.fail(new Error('carrier lost'))
  await disposing
  expect(b.state().linked).toBe(true)
})

it('ignores an item the stream yielded just before disposal', async () => {
  const b = fixture()
  const disposing = b.browser.dispose()
  b.deliver({ accounts: [entry(FIXTURE)] })
  await disposing
  expect(b.state().accounts.size).toBe(0)
})

it('opens only HTTPS pages and HTTP pages on loopback addresses', () => {
  const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
  onTestFinished(() => { windowOpen.mockRestore() })
  for (const url of [undefined, 'not a url', 'http://example.com/a', 'javascript:alert(1)']) openAuthorizationPage(url)
  expect(windowOpen).not.toHaveBeenCalled()
  for (const url of ['https://example.com/a', 'http://localhost:1/a', 'http://[::1]:1/a', 'http://127.0.0.1:1/a']) openAuthorizationPage(url)
  expect(windowOpen.mock.calls.map(([url]) => url)).toEqual([
    'https://example.com/a', 'http://localhost:1/a', 'http://[::1]:1/a', 'http://127.0.0.1:1/a',
  ])
})
