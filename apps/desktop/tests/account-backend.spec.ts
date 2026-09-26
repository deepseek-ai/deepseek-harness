import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { expect, it, onTestFinished, vi } from 'vitest'
import { accountView, desktopAccountBackend } from '../src/account-backend.ts'

it('projects only safe account fields and refuses non-browser authorization schemes', () => {
  const state = { links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', token: 'not-for-the-renderer',
    attempt: { id: 'test', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize', codeVerifier: 'private' } }
  expect(accountView(state)).toEqual({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: {
    id: 'test', phase: 'waiting-browser', authorizeUrl: 'https://platform.deepseek.com/dsh/authorize',
  } })
  for (const authorizeUrl of ['file:///tmp/example', 'javascript:alert(1)', 'http://example.com/login']) {
    expect(() => accountView({ ...state, attempt: { ...state.attempt, authorizeUrl } })).toThrow()
  }
  expect(() => accountView({ ...state, links: { usageUrl: 'file:///tmp/example', topUpUrl: 'https://example.com/top_up' } })).toThrow()
  expect(() => accountView({ ...state, attempt: { ...state.attempt, expiresAt: 'tomorrow' } })).toThrow()
  expect(() => accountView({ ...state, attempt: { ...state.attempt, errorCode: 'raw-server-message' } })).toThrow()
})

it('uses account Remote commands without returning additional wire fields', async () => {
  const requests: unknown[] = []
  const backend = desktopAccountBackend('http://127.0.0.1:1234', (request) => {
    requests.push(request)
    return Promise.resolve({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null, token: 'private' })
  }, () => Promise.resolve(''))
  const client = { version: '1.2.3', locale: 'en', timezoneOffsetSeconds: 28_800 }
  expect(await backend.start(client)).toEqual({ links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' }, status: 'signed-out', attempt: null })
  expect(await backend.signOut(client)).toMatchObject({ status: 'signed-out' })
  expect(requests).toEqual([
    { namespace: 'account', method: 'startSignIn', args: { client, callbackOrigin: 'http://127.0.0.1:1234', loginSource: 'desktop' } },
    { namespace: 'account', method: 'signOut', args: { client } },
  ])
})

it('does not replay an expiry reason from an account snapshot', () => {
  const state = { status: 'signed-out', attempt: null,
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }
  expect(accountView({ ...state, signOutReason: 'expired' })).toEqual(state)
})

it('receives live expiry separately from account snapshots', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  onTestFinished(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('missing server address')
  const connected = once(server, 'connection')
  const expired = vi.fn()
  const snapshot = { status: 'signed-out', attempt: null,
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' } }
  const received = Promise.withResolvers<undefined>()
  const backend = desktopAccountBackend(`http://127.0.0.1:${address.port}`, () => Promise.resolve(snapshot), () => Promise.resolve(''))
  const stop = backend.watch((value) => { expect(value).toEqual(snapshot); received.resolve(undefined) }, vi.fn(), expired)
  onTestFinished(stop)
  await connected
  // Both logical streams share the socket; observe their opening frames before sending data.
  const streams = new Map<string, string>()
  const opened = Promise.withResolvers<undefined>()
  const socket = [...server.clients][0]!
  socket.on('message', (data) => {
    if (!Buffer.isBuffer(data)) throw new Error('expected a Buffer WebSocket frame')
    const frame = JSON.parse(data.toString('utf8')) as { endpoint: string; streamId: string }
    streams.set(frame.endpoint, frame.streamId)
    if (streams.size === 2) opened.resolve(undefined)
  })
  await opened.promise
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('account/watch'), value: snapshot }))
  await received.promise
  expect(expired).not.toHaveBeenCalled()
  socket.send(JSON.stringify({ type: 'item', streamId: streams.get('account/watchExpiry'), value: 'session-expired' }))
  await vi.waitFor(() => { expect(expired).toHaveBeenCalledOnce() })
  stop()
})
