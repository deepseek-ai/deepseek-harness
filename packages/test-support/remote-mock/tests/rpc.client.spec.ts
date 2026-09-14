/** The Connection carrier face: payload forms, streams, unmatched rejections, and abort. */
import { describe, expect, it } from 'vitest'
import { RemoteMock, ok, openStream } from '../src/index.ts'

const idle = (): AbortSignal => new AbortController().signal

describe('RemoteMock.rpc', () => {
  it('calls and opens by endpoint, taking the proxies\' positional args or the Gateway\'s single object', async () => {
    const mock = RemoteMock.create()
      .unary('session/list', ok({ items: [] }))
      .unary('$events/result', (...args) => ok(args))
      .stream('session/control', openStream([{ type: 'baseline' }]))
    await expect(mock.rpc.call('/api', 'session/list', { args: [{}] })).resolves.toEqual({ ok: true, value: { items: [] } })
    await expect(mock.rpc.call('/api', '$events/result', { args: { clientId: 'c' } }, idle())).resolves.toEqual({ ok: true, value: [{ clientId: 'c' }] })
    const stream = mock.rpc.open!('/api', 'session/control', { args: [{ since: 1 }] }, idle())[Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toEqual({ value: { type: 'baseline' }, done: false })
    expect(mock.log.calls().map(call => [call.endpoint, call.args])).toEqual([['session/list', [{}]], ['$events/result', [{ clientId: 'c' }]]])
    expect(mock.log.streams('session/control').map(open => open.args)).toEqual([[{ since: 1 }]])
  })

  it('rejects malformed payloads and unmatched endpoints, logging the miss', async () => {
    const mock = RemoteMock.create()
    await expect(mock.rpc.call('/api', 'a/b', 'bare')).rejects.toThrow('remote-mock: payload of a/b must be { args: unknown[] | object }')
    await expect(mock.rpc.call('/api', 'a/b', { args: 'x' })).rejects.toThrow('must be { args: unknown[] | object }')
    expect(() => mock.rpc.open!('/api', 'a/b', null, idle())).toThrow('payload of a/b must be { args: unknown[] | object }')
    await expect(mock.rpc.call('/api', 'a/b', { args: [] })).rejects.toThrow('remote-mock: no rule for a/b')
    expect(mock.log.unmatched()).toEqual([{ endpoint: 'a/b', mode: 'unary' }])
  })

  it('rejects an aborted call: immediately when already aborted, with the reason while the rule is pending', async () => {
    const mock = RemoteMock.create().unary('slow/call', () => new Promise(() => {}))
    const pending = new AbortController()
    const request = mock.rpc.call('/api', 'slow/call', { args: [] }, pending.signal)
    pending.abort(new Error('caller left'))
    await expect(request).rejects.toThrow('caller left')
    const already = new AbortController()
    already.abort('not an error')
    await expect(mock.rpc.call('/api', 'slow/call', { args: [] }, already.signal)).rejects.toThrow('remote-mock: call aborted')
    await expect(mock.rpc.call('/api', 'session/list', { args: [] }, idle())).rejects.toThrow('no rule for session/list')
    // The abort rejects the caller; the never-settling rules stay pending in the log, and the miss is not a call.
    expect(mock.log.calls().map(call => [call.endpoint, call.state])).toEqual([['slow/call', 'pending'], ['slow/call', 'pending']])
  })
})
