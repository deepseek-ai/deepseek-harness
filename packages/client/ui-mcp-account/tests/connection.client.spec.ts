// @vitest-environment jsdom
/** The page follows every registered account through one Host stream and drives authorization through the manager's Remote. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-api-remotes/client'
import type { McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { McpAccountsConnection, presentConnection } from '../src/client/connection.ts'
import type { McpAccountEntry, McpAccountsView } from '../src/types.ts'

const ATTEMPT = 'attempt-1' as McpOAuthAttemptId
const DOCS = '@acme/docs'
const WIKI = '@acme/wiki'
const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })

function attempt(phase: McpOAuthAttemptView['phase'], authorizationUrl?: string, id = ATTEMPT): McpOAuthAttemptView {
  return { id, phase, ...authorizationUrl === undefined ? {} : { authorizationUrl } }
}

function server(status: McpManagedServerStatus, authorization?: McpOAuthAttemptView): McpManagedServerView {
  return { name: 'docs', configured: true, status, ...authorization === undefined ? {} : { authorization } }
}

const MISSING: McpManagedServerStatus = { state: 'waiting-authorization', reason: 'missing', lastError: 'no grant' }
const CONNECTED: McpManagedServerStatus = { state: 'connected', toolCount: 2, connectedAt: 1 }

it.each<[string, McpManagedServerView | undefined, ReturnType<typeof presentConnection>]>([
  ['no entry yet', undefined, { phase: 'checking' }],
  ['a missing grant', server(MISSING), { phase: 'disconnected', failed: false }],
  ['a failed attempt over a missing grant', server(MISSING, attempt('failed')), { phase: 'disconnected', failed: true }],
  ['an expired grant', server({ state: 'waiting-authorization', reason: 'expired', lastError: 'x' }), { phase: 'reconnect', reason: 'expired', failed: false }],
  ['missing permissions', server({ state: 'waiting-authorization', reason: 'scope', lastError: 'x' }), { phase: 'reconnect', reason: 'scope', failed: false }],
  ['a starting attempt', server(MISSING, attempt('starting')), { phase: 'authorizing', attempt: ATTEMPT }],
  ['an exchanging attempt', server(MISSING, attempt('exchanging')), { phase: 'authorizing', attempt: ATTEMPT }],
  ['a committing attempt', server(MISSING, attempt('committing')), { phase: 'authorizing', attempt: ATTEMPT }],
  ['a browser step', server(MISSING, attempt('waiting-browser', 'https://docs.test/auth')),
    { phase: 'waiting-browser', attempt: ATTEMPT, url: 'https://docs.test/auth' }],
  ['a connection', server(CONNECTED, attempt('authorized')), { phase: 'connected' }],
  ['a cancelled attempt', server(MISSING, attempt('cancelled')), { phase: 'disconnected', failed: false }],
  ['a first connection', server({ state: 'connecting', attempt: 0 }), { phase: 'connecting' }],
  ['a reconnect backoff', server({ state: 'reconnecting', attempt: 1, maxAttempts: 3, nextRetryAtMs: 2, lastError: 'x' }), { phase: 'connecting' }],
  ['a closed instance', server({ state: 'closed', result: { closeConfirmed: true } }), { phase: 'unavailable', failed: false, retryable: true }],
  ['missing static credentials', server({ state: 'waiting-credentials', lastError: 'x' }), { phase: 'unavailable', failed: false, retryable: false }],
  ['a disabled entry', server({ state: 'disabled' }), { phase: 'unavailable', failed: false, retryable: false }],
  ['a stopped supervisor', server({ state: 'failed', reason: 'gave-up' }), { phase: 'unavailable', failed: false, retryable: true }],
  ['a load failure', server({ state: 'failed', reason: 'load', lastError: 'x' }), { phase: 'unavailable', failed: false, retryable: true }],
  ['an unclosed generation', server({ state: 'failed', reason: 'unclosed-generation', lastError: 'x' }), { phase: 'unavailable', failed: false, retryable: false }],
  ['incomplete cleanup', server({ state: 'failed', reason: 'cleanup', result: { closeConfirmed: false } }), { phase: 'unavailable', failed: false, retryable: false }],
])('presents %s', (_name, entry, expected) => {
  expect(presentConnection(entry)).toEqual(expected)
})

function entry(view?: McpManagedServerView, packageName = DOCS): McpAccountEntry {
  const name = packageName === DOCS ? 'docs' : 'wiki'
  return {
    server: name, packageName, copy: {
      title: name, connect: `Connect ${name}`, activation: { title: name, body: name },
      detail: { disconnected: '-', waitingBrowser: '-', authorizing: '-', connecting: '-', connected: '-', rejected: '-', scope: '-' },
      signOut: { title: name, body: name }, notice: { connected: name, signedOut: name },
    },
    ...view === undefined ? {} : { view },
  }
}

function fixture() {
  const queue: McpAccountsView[] = []
  let wake: (() => void) | undefined, closed = false, failure: Error | undefined, accepted = 0
  let options!: RemoteStreamOptions<McpAccountsView>
  const stream = {
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
  }
  const registry = { watch: vi.fn() }
  const servers = {
    startAuthorization: vi.fn(async (_server: string) => ok(attempt('starting'))),
    cancelAuthorization: vi.fn(async (_server: string, _id: McpOAuthAttemptId): Promise<RemoteResult<void>> => ok(undefined)),
    signOut: vi.fn(async (_server: string): Promise<RemoteResult<void>> => ok(undefined)),
    restart: vi.fn(async (_server: string): Promise<RemoteResult<void>> => ok(undefined)),
  }
  const ctx = new Context()
  ctx.provide('remote', { $stream: (value: typeof options) => { options = value; return stream } })
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const connection = new McpAccountsConnection(ctx, registry, servers)
  onTestFinished(async () => { await connection.dispose(); open.mockRestore(); await ctx.fiber.dispose() })
  return {
    connection, registry, servers, open, stream, options: () => options,
    face: (packageName = DOCS) => connection.actions(packageName),
    snapshot: (packageName = DOCS) => connection.accounts.getSnapshot().get(packageName)?.getSnapshot(),
    deliver(...entries: McpAccountEntry[]) { queue.push({ accounts: entries }); wake?.() },
    async publish(...entries: McpAccountEntry[]) {
      const target = accepted + 1
      this.deliver(...entries)
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
    fail(error: Error) { failure = error; wake?.() },
    failOnClose(error: Error) { failure = error },
  }
}

const settle = async (b: ReturnType<typeof fixture>, packageName = DOCS) => {
  await vi.waitFor(() => { expect(b.snapshot(packageName)?.busy).toBe(false) })
}
// Every fixture step settles through microtasks, so one macrotask lets a pending action finish.
const drain = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

it('opens the registry stream and keeps one snapshot source per account the Host registers', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  b.options().open(signal)
  expect(b.registry.watch).toHaveBeenCalledWith(signal)
  expect(b.options().ended(true)).toBeInstanceOf(Error)
  await b.publish(entry(server(MISSING)))
  expect(b.snapshot()).toEqual({ entry: entry(server(MISSING)), linked: true, busy: false, notice: undefined })
  const shown = b.connection.accounts.getSnapshot()
  const store = shown.get(DOCS)

  await b.publish(entry(server(CONNECTED)))
  expect(b.connection.accounts.getSnapshot()).toBe(shown)
  expect(store?.getSnapshot().entry.view?.status).toEqual(CONNECTED)
  await b.publish(entry(server(CONNECTED)), entry(undefined, WIKI))
  expect([...b.connection.accounts.getSnapshot().keys()]).toEqual([DOCS, WIKI])
  expect(b.connection.accounts.getSnapshot().get(DOCS)).toBe(store)
  await b.publish(entry(undefined, WIKI))
  expect([...b.connection.accounts.getSnapshot().keys()]).toEqual([WIKI])
})

it('marks every account offline while the carrier is down', async () => {
  const b = fixture()
  await b.publish(entry(server(MISSING)), entry(undefined, WIKI))
  b.options().carrierFailed?.(new Error('lost'))
  expect([b.snapshot()?.linked, b.snapshot(WIKI)?.linked]).toEqual([false, false])
  await b.publish(entry(server(MISSING)), entry(undefined, WIKI))
  expect([b.snapshot()?.linked, b.snapshot(WIKI)?.linked]).toEqual([true, true])
})

it('opens the authorization page once for the attempt this browser started, then reports the connection', async () => {
  const b = fixture()
  await b.publish(entry(server(MISSING)), entry(undefined, WIKI))
  b.face().connect()
  await settle(b)
  expect(b.servers.startAuthorization).toHaveBeenCalledWith('docs')
  await b.publish(entry(server(MISSING, attempt('waiting-browser', 'https://docs.test/auth'))), entry(undefined, WIKI))
  await b.publish(entry(server(MISSING, attempt('waiting-browser', 'https://docs.test/auth'))), entry(undefined, WIKI))
  expect(b.open).toHaveBeenCalledOnce()
  expect(b.open).toHaveBeenCalledWith('https://docs.test/auth', '_blank', 'noopener,noreferrer')
  b.face().openAuthorization()
  expect(b.open).toHaveBeenCalledTimes(2)
  await b.publish(entry(server(CONNECTED, attempt('authorized'))), entry(undefined, WIKI))
  expect(b.snapshot()?.notice).toEqual({ seq: 1, kind: 'connected' })
  expect(b.snapshot(WIKI)?.notice).toBeUndefined()
  await b.publish(entry(server(CONNECTED, attempt('authorized'))), entry(undefined, WIKI))
  expect(b.snapshot()?.notice?.seq).toBe(1)
  b.face().dismissNotice()
  expect(b.snapshot()?.notice).toBeUndefined()
})

it('opens a page the stream reported before the start call answered, and never another browser\'s attempt', async () => {
  const b = fixture()
  const answer = Promise.withResolvers<RemoteResult<McpOAuthAttemptView>>()
  b.servers.startAuthorization.mockReturnValueOnce(answer.promise)
  await b.publish(entry(server(MISSING, attempt('waiting-browser', 'https://docs.test/other', 'other' as McpOAuthAttemptId))))
  expect(b.open).not.toHaveBeenCalled()
  b.face().connect()
  await b.publish(entry(server(MISSING, attempt('waiting-browser', 'http://127.0.0.1:3080/authorize'))))
  expect(b.open).not.toHaveBeenCalled()
  answer.resolve(ok(attempt('starting')))
  await vi.waitFor(() => { expect(b.open).toHaveBeenCalledWith('http://127.0.0.1:3080/authorize', '_blank', 'noopener,noreferrer') })
})

it.each(['http://docs.test/auth', 'javascript:alert(1)', 'not a url'])('refuses to open %s', async (url) => {
  const b = fixture()
  await b.publish(entry(server(MISSING)))
  b.face().connect()
  await settle(b)
  await b.publish(entry(server(MISSING, attempt('waiting-browser', url))))
  b.face().openAuthorization()
  expect(b.open).not.toHaveBeenCalled()
})

it('cancels only an active attempt and forgets an attempt that ended', async () => {
  const b = fixture()
  await b.publish(entry(server(MISSING)))
  b.face().cancel()
  b.face().openAuthorization()
  expect(b.servers.cancelAuthorization).not.toHaveBeenCalled()
  expect(b.open).not.toHaveBeenCalled()
  b.face().connect()
  await settle(b)
  await b.publish(entry(server(MISSING, attempt('starting'))))
  b.face().cancel()
  await vi.waitFor(() => { expect(b.servers.cancelAuthorization).toHaveBeenCalledWith('docs', ATTEMPT) })
  await b.publish(entry(server(MISSING, attempt('cancelled'))))
  await b.publish(entry(server(MISSING, attempt('waiting-browser', 'https://docs.test/late'))))
  expect(b.open).not.toHaveBeenCalled()
  expect(b.snapshot()?.notice).toBeUndefined()
})

it('signs out and retries through the manager, reporting a failed action once and ignoring overlapping clicks', async () => {
  const b = fixture()
  await b.publish(entry(server(CONNECTED)))
  b.face().signOut()
  b.face().retry()
  await vi.waitFor(() => { expect(b.snapshot()?.notice?.kind).toBe('signed-out') })
  expect(b.servers.signOut).toHaveBeenCalledWith('docs')
  expect(b.servers.restart).not.toHaveBeenCalled()
  b.servers.restart.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  b.face().retry()
  await vi.waitFor(() => { expect(b.snapshot()?.notice?.kind).toBe('action-failed') })
  expect(b.servers.restart).toHaveBeenCalledWith('docs')
  expect(b.snapshot()?.busy).toBe(false)
})

it('ignores actions for an account the Host has not registered, and follows no attempt of a withdrawn account', async () => {
  const b = fixture()
  for (const action of Object.values(b.face())) action()
  await b.publish(entry(server(MISSING)))
  const answer = Promise.withResolvers<RemoteResult<McpOAuthAttemptView>>()
  b.servers.startAuthorization.mockReturnValueOnce(answer.promise)
  b.face().connect()
  await b.publish()
  answer.resolve(ok(attempt('starting')))
  await drain()
  await b.publish(entry(server(MISSING, attempt('waiting-browser', 'https://docs.test/auth'))))
  expect(b.snapshot()?.busy).toBe(false)
  expect(b.open).not.toHaveBeenCalled()

  await b.publish(entry(server(MISSING)))
  b.face().connect()
  await settle(b)
  await b.publish(entry(undefined, WIKI))
  await b.publish(entry(server(MISSING, attempt('waiting-browser', 'https://docs.test/auth'))))
  expect(b.open).not.toHaveBeenCalled()
  expect(b.servers.startAuthorization).toHaveBeenCalledTimes(2)
  expect([b.servers.cancelAuthorization, b.servers.signOut, b.servers.restart].every(call => call.mock.calls.length === 0)).toBe(true)
})

it('stops observing on disposal without reporting the closed stream', async () => {
  const b = fixture()
  await b.publish(entry(server(MISSING)))
  b.failOnClose(new Error('closed'))
  await b.connection.dispose()
  expect(b.stream.dispose).toHaveBeenCalled()
  expect(b.snapshot()?.linked).toBe(true)
})

it('reports nothing and follows no attempt for an action that settles after disposal, and ignores a view yielded after it', async () => {
  const b = fixture()
  const waiting = entry(server(MISSING, attempt('waiting-browser', 'https://docs.test/auth')), WIKI)
  await b.publish(entry(server(CONNECTED)), waiting)
  const signedOut = Promise.withResolvers<RemoteResult<void>>()
  const started = Promise.withResolvers<RemoteResult<McpOAuthAttemptView>>()
  b.servers.signOut.mockReturnValueOnce(signedOut.promise)
  b.servers.startAuthorization.mockReturnValueOnce(started.promise)
  b.face().signOut()
  b.face(WIKI).connect()
  b.deliver(entry(server(MISSING)), waiting)
  await b.connection.dispose()
  signedOut.resolve(ok(undefined))
  started.resolve(ok(attempt('starting')))
  await settle(b)
  await settle(b, WIKI)
  expect(b.snapshot()).toMatchObject({ entry: entry(server(CONNECTED)), linked: true, notice: undefined })
  expect(b.open).not.toHaveBeenCalled()
})

it('marks the page offline when the stream fails', async () => {
  const b = fixture()
  await b.publish(entry(server(MISSING)))
  b.fail(new Error('invalid frame'))
  await vi.waitFor(() => { expect(b.snapshot()?.linked).toBe(false) })
})
