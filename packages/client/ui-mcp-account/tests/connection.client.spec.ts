// @vitest-environment jsdom
/** The page derives one server's connection from the manager's entry and drives authorization through its Remote. */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-api-remotes/client'
import type { McpOAuthAttemptId, McpOAuthAttemptView } from '@deepseek-ai/dsh-mcp-client/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { McpAccountConnection, presentConnection } from '../src/client/connection.ts'

const ATTEMPT = 'attempt-1' as McpOAuthAttemptId

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

function fixture() {
  const queue: McpManagedServerView[][] = []
  let wake: (() => void) | undefined, closed = false, failure: Error | undefined, accepted = 0
  let options!: RemoteStreamOptions<McpManagedServerView[]>
  const stream = {
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
  }
  const ok = <T>(value: T) => ({ ok: true as const, value })
  const remote = {
    watch: vi.fn(),
    startAuthorization: vi.fn(async () => ok(attempt('starting'))),
    cancelAuthorization: vi.fn(async () => ok(undefined)),
    signOut: vi.fn(async () => ok(undefined)),
    restart: vi.fn(async () => ok(undefined)),
  }
  const ctx = new Context()
  ctx.provide('remote', { mcpServers: remote, $stream: (value: typeof options) => { options = value; return stream } })
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const connection = new McpAccountConnection(ctx, 'docs')
  onTestFinished(async () => { await connection.dispose(); open.mockRestore(); await ctx.fiber.dispose() })
  const face = connection.face()
  const snapshot = () => connection.state.getSnapshot()
  return {
    connection, face, remote, open, stream, snapshot, options: () => options,
    async publish(...servers: McpManagedServerView[]) {
      const target = accepted + 1
      queue.push([{ name: 'other', configured: true, status: CONNECTED }, ...servers])
      wake?.()
      await vi.waitFor(() => { expect(accepted).toBe(target) })
    },
    fail(error: Error) { failure = error; wake?.() },
    failOnClose(error: Error) { failure = error },
  }
}

it('mirrors only its server entry and opens the manager stream', async () => {
  const b = fixture()
  const signal = new AbortController().signal
  b.options().open(signal)
  expect(b.remote.watch).toHaveBeenCalledWith(signal)
  expect(b.options().ended(true)).toBeInstanceOf(Error)
  await b.publish()
  expect(b.snapshot()).toMatchObject({ server: undefined, linked: true, busy: false })
  b.options().carrierFailed?.(new Error('lost'))
  expect(b.snapshot().linked).toBe(false)
  await b.publish(server(MISSING))
  expect(b.snapshot().linked).toBe(true)
})

it('opens the authorization page once for the attempt this browser started, then reports the connection', async () => {
  const b = fixture()
  await b.publish(server(MISSING))
  b.face.connect()
  await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) })
  expect(b.remote.startAuthorization).toHaveBeenCalledWith('docs')
  const waiting = server(MISSING, attempt('waiting-browser', 'https://docs.test/auth'))
  await b.publish(waiting)
  await b.publish(server(MISSING, attempt('waiting-browser', 'https://docs.test/auth')))
  expect(b.open).toHaveBeenCalledOnce()
  expect(b.open).toHaveBeenCalledWith('https://docs.test/auth', '_blank', 'noopener,noreferrer')
  b.face.openAuthorization()
  expect(b.open).toHaveBeenCalledTimes(2)
  await b.publish(server(CONNECTED, attempt('authorized')))
  expect(b.snapshot().notice).toEqual({ seq: 1, kind: 'connected' })
  await b.publish(server(CONNECTED, attempt('authorized')))
  expect(b.snapshot().notice?.seq).toBe(1)
  b.face.dismissNotice()
  expect(b.snapshot().notice).toBeUndefined()
})

it('opens a page the stream reported before the start call answered, and never another browser\'s attempt', async () => {
  const b = fixture()
  const answer = Promise.withResolvers<{ ok: true; value: McpOAuthAttemptView }>()
  b.remote.startAuthorization.mockReturnValueOnce(answer.promise)
  await b.publish(server(MISSING, attempt('waiting-browser', 'https://docs.test/other', 'other' as McpOAuthAttemptId)))
  expect(b.open).not.toHaveBeenCalled()
  b.face.connect()
  await b.publish(server(MISSING, attempt('waiting-browser', 'http://127.0.0.1:3080/authorize')))
  expect(b.open).not.toHaveBeenCalled()
  answer.resolve({ ok: true, value: attempt('starting') })
  await vi.waitFor(() => { expect(b.open).toHaveBeenCalledWith('http://127.0.0.1:3080/authorize', '_blank', 'noopener,noreferrer') })
})

it.each(['http://docs.test/auth', 'javascript:alert(1)', 'not a url'])('refuses to open %s', async (url) => {
  const b = fixture()
  b.face.connect()
  await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) })
  await b.publish(server(MISSING, attempt('waiting-browser', url)))
  b.face.openAuthorization()
  expect(b.open).not.toHaveBeenCalled()
})

it('cancels only an active attempt and forgets an attempt that ended', async () => {
  const b = fixture()
  await b.publish(server(MISSING))
  b.face.cancel()
  b.face.openAuthorization()
  expect(b.remote.cancelAuthorization).not.toHaveBeenCalled()
  expect(b.open).not.toHaveBeenCalled()
  b.face.connect()
  await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) })
  await b.publish(server(MISSING, attempt('starting')))
  b.face.cancel()
  await vi.waitFor(() => { expect(b.remote.cancelAuthorization).toHaveBeenCalledWith('docs', ATTEMPT) })
  await b.publish(server(MISSING, attempt('cancelled')))
  await b.publish(server(MISSING, attempt('waiting-browser', 'https://docs.test/late')))
  expect(b.open).not.toHaveBeenCalled()
  expect(b.snapshot().notice).toBeUndefined()
})

it('signs out and retries through the manager, reporting a failed action once and ignoring overlapping clicks', async () => {
  const b = fixture()
  await b.publish(server(CONNECTED))
  b.face.signOut()
  b.face.retry()
  await vi.waitFor(() => { expect(b.snapshot().notice?.kind).toBe('signed-out') })
  expect(b.remote.signOut).toHaveBeenCalledWith('docs')
  expect(b.remote.restart).not.toHaveBeenCalled()
  b.remote.restart.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) } as never)
  b.face.retry()
  await vi.waitFor(() => { expect(b.snapshot().notice?.kind).toBe('action-failed') })
  expect(b.remote.restart).toHaveBeenCalledWith('docs')
  expect(b.snapshot().busy).toBe(false)
})

it('stops observing on disposal without reporting the closed stream', async () => {
  const b = fixture()
  await b.publish(server(MISSING))
  await b.connection.dispose()
  expect(b.stream.dispose).toHaveBeenCalled()
  expect(b.snapshot().linked).toBe(true)
})

it('reports nothing for a stream failure or an action that settles after disposal', async () => {
  const b = fixture()
  await b.publish(server(CONNECTED))
  const answer = Promise.withResolvers<{ ok: true; value: undefined }>()
  b.remote.signOut.mockReturnValueOnce(answer.promise)
  b.face.signOut()
  b.failOnClose(new Error('closed'))
  await b.connection.dispose()
  answer.resolve({ ok: true, value: undefined })
  await vi.waitFor(() => { expect(b.snapshot().busy).toBe(false) })
  expect(b.snapshot()).toMatchObject({ linked: true, notice: undefined })
})

it('marks the page offline when the stream fails', async () => {
  const b = fixture()
  await b.publish(server(MISSING))
  b.fail(new Error('invalid frame'))
  await vi.waitFor(() => { expect(b.snapshot().linked).toBe(false) })
})
