/** Remote proxies: namespace discovery from roster injects and mock rules, and per-call routing over the Connection to the mock. */
import { RemoteMock, frames, ok, openStream } from '@deepseek-ai/dsh-remote-mock'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ClientPluginModule } from '../src/assembly/index.ts'
import { TestClient, remoteDefaultResponses, webApp } from '../src/assembly/index.ts'
import { remoteNamespacesOf } from '../src/assembly/remote-proxies.ts'

/** The api-remotes row and its cone (Gateway client, Typert registry, Connection); TestClient drops the api-remotes row itself. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-remotes'])

type RemoteFace = Record<string, Record<string, (...args: unknown[]) => unknown>>

async function drain(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of source) items.push(item)
  return items
}

describe('remoteNamespacesOf', () => {
  it('collects remote.<ns> injects in both inject forms plus the namespaces of registered endpoints, skipping Gateway-internal ones', () => {
    const modules: ClientPluginModule[] = [
      { apply() {}, inject: ['slots', 'remote.settings', 'remote'] },
      { apply() {}, inject: { 'remote.session': { required: true }, connection: { required: false } } },
      { apply() {} },
    ]
    const mock = RemoteMock.create().unary('goals/create', ok({ id: 'g' })).stream('workspace/follow', openStream())
    expect(remoteNamespacesOf(modules, mock)).toEqual(['goals', 'session', 'settings', 'workspace'])
  })
})

describe('remote proxies over a booted client', () => {
  async function booted(configure: (mock: RemoteMock) => void = () => {}) {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    configure(mock)
    const client = await TestClient.start({ roster: API_ROSTER }, mock)
    onTestFinished(() => client.dispose())
    return { client, mock, remote: (client.ctx as unknown as { remote: RemoteFace }).remote }
  }

  it('drops the api-remotes row and answers ctx.remote.<ns>.<method> with the mock value, logging positional args', async () => {
    const { client, mock, remote } = await booted((m) => {
      m.unary('session/rename', ok({ title: 'renamed', seq: 3 }))
      m.unary('session/cancel', { ok: false, error: { code: 'session/not-found', message: 'gone', details: {} } })
    })
    expect([...client.ctx.loader.entries()].map(entry => entry.options.name)).not.toContain('@deepseek-ai/dsh-api-remotes')
    await expect(remote.session!.rename!({ sessionId: 's1', title: 'renamed' })).resolves.toEqual({ ok: true, value: { title: 'renamed', seq: 3 } })
    await expect(remote.session!.cancel!({ sessionId: 's1' }, new AbortController().signal))
      .resolves.toEqual({ ok: false, error: { code: 'session/not-found', message: 'gone', details: {} } })
    expect(mock.log.calls('session/rename').map(call => call.args)).toEqual([[{ sessionId: 's1', title: 'renamed' }]])
    expect(mock.log.calls('session/cancel').map(call => call.args)).toEqual([[{ sessionId: 's1' }]])
    expect((remote.session as unknown as { then?: unknown }).then).toBeUndefined()
    expect((remote.session as unknown as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined()
  }, 60_000)

  it('folds a call without a rule into gateway/internal and leaves the miss in the log for dispose() to report', async () => {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: API_ROSTER }, mock)
    const remote = (client.ctx as unknown as { remote: RemoteFace }).remote
    await expect(remote.session!.search!({ query: 'x' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/internal', message: expect.stringMatching(/^client api: session\/search failed: remote-mock: no rule for session\/search; registered: \$events, /) as string },
    })
    expect(mock.log.unmatched()).toEqual([{ endpoint: 'session/search', mode: 'unary' }])
    await expect(client.dispose()).rejects.toThrow('session/search (unary)')
  })

  it('folds a rule rejection like the generated client: gateway/internal, or gateway/cancelled once the signal aborted', async () => {
    const { mock, remote } = await booted((m) => {
      m.unary('session/rename', () => Promise.reject(new Error('wire down')))
      m.unary('session/cancel', () => new Promise(() => {}))
    })
    await expect(remote.session!.rename!({ sessionId: 's1', title: 't' })).resolves.toMatchObject({
      ok: false, error: { code: 'gateway/internal', message: 'client api: session/rename failed: wire down' },
    })
    const controller = new AbortController()
    const cancelling = remote.session!.cancel!({ sessionId: 's1' }, controller.signal) as Promise<unknown>
    controller.abort()
    await expect(cancelling).resolves.toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    expect(mock.log.calls('session/rename').map(call => call.state)).toEqual(['failed'])
    expect(mock.log.calls('session/cancel').map(call => call.state)).toEqual(['pending'])
  })

  it('opens registered streams and hands their items and failures through unchanged', async () => {
    const { remote } = await booted((m) => {
      m.stream('session/follow', frames([{ type: 'a' }, { type: 'b' }]))
      m.stream('session/control', ((_args, stream) => { stream.fail(new Error('flap')) }))
    })
    const signal = new AbortController().signal
    await expect(drain(remote.session!.follow!({ address: { kind: 'session', sessionId: 's1' } }, signal) as AsyncIterable<unknown>))
      .resolves.toEqual([{ type: 'a' }, { type: 'b' }])
    await expect(drain(remote.session!.control!({}) as AsyncIterable<unknown>)).rejects.toThrow('flap')
  })
})
