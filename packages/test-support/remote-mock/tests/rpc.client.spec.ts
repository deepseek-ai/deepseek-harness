/** The Connection carrier face: payload forms, streams, unmatched rejections, and abort. */
import { describe, expect, it } from 'vitest'
import { RemoteMock, ok, openStream, type MockClientStream } from '../src/index.ts'

const idle = (): AbortSignal => new AbortController().signal
const drain = async (source: AsyncIterable<unknown>): Promise<unknown[]> => {
  const items: unknown[] = []
  for await (const item of source) items.push(item)
  return items
}

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

  it('hands the uplink to the script and keeps it out of the logged args', async () => {
    const mock = RemoteMock.create().stream('job/attach', async (args, stream) => {
      for await (const item of stream.uplink) stream.push(`${String(args[0])}:${String(item)}`)
      stream.end()
    })
    const uplink = (values: readonly string[]): AsyncIterable<string> => (async function *() { yield* values })()

    await expect(drain(mock.rpc.open!('/api', 'job/attach', { args: ['job-1'] }, idle(), uplink(['a', 'b']))))
      .resolves.toEqual(['job-1:a', 'job-1:b'])
    await expect(drain(mock.open('job/attach', ['job-2'], idle(), uplink(['c'])))).resolves.toEqual(['job-2:c'])
    // A direct open returns the handle a generated method would: its send/end feed the script's uplink.
    const direct = mock.open('job/attach', ['job-3'], idle()) as MockClientStream
    direct.send('d')
    direct.end()
    direct.end()
    await expect(drain(direct)).resolves.toEqual(['job-3:d'])
    expect(() => { direct.send('late') }).toThrow('remote-mock: uplink was ended')
    const disposed = mock.open('job/attach', ['job-4'], idle()) as MockClientStream
    disposed.dispose()
    await expect(drain(disposed)).resolves.toEqual([])
    expect(mock.log.streams('job/attach').map(open => [open.args, open.state]))
      .toEqual([[['job-1'], 'ended'], [['job-2'], 'ended'], [['job-3'], 'ended'], [['job-4'], 'cancelled']])
    const carried = mock.open('job/attach', ['job-5'], idle(), uplink([])) as MockClientStream
    expect(() => { carried.send('x') }).toThrow('remote-mock: job/attach uplink belongs to the carrier that opened the stream')
    await expect(drain(carried)).resolves.toEqual([])
  })

  it('queues items sent before the script reads and drops the rest once it stops reading', async () => {
    const mock = RemoteMock.create().stream('job/attach', async (args, stream) => {
      await Promise.resolve()
      for await (const item of stream.uplink) {
        stream.push(`${String(args[0])}:${String(item)}`)
        break
      }
      stream.end()
    })
    const direct = mock.open('job/attach', ['job-6'], idle()) as MockClientStream
    direct.send('first')
    direct.send('second')
    await expect(drain(direct)).resolves.toEqual(['job-6:first'])
    expect(() => { direct.send('late') }).toThrow('remote-mock: uplink was ended')
  })

  it('applies the real handle checks to send and closes the owned uplink with the stream', async () => {
    const mock = RemoteMock.create()
      .stream('job/attach', async (args, stream) => {
        for await (const item of stream.uplink) stream.push(`${String(args[0])}:${String(item)}`)
        stream.end()
      })
      .stream('job/quiet', (args, stream) => {
        stream.push(String(args[0]))
        stream.end()
      })
    const absent = mock.open('job/attach', ['job-7'], idle()) as MockClientStream
    absent.send(undefined)
    expect(() => { absent.send(1n) }).toThrow('remote-mock: job/attach uplink item is not a lossless JSON value')
    absent.end()
    await expect(drain(absent)).resolves.toEqual(['job-7:undefined'])
    // A script that ends the downlink without reading the uplink closes the owned uplink.
    const quiet = mock.open('job/quiet', ['job-8'], idle()) as MockClientStream
    await expect(drain(quiet)).resolves.toEqual(['job-8'])
    expect(() => { quiet.send('late') }).toThrow('remote-mock: uplink was ended')
    // A consumer that leaves early closes it too, and a script blocked on the uplink wakes.
    const unblocked = Promise.withResolvers<undefined>()
    const blocked = RemoteMock.create().stream('job/attach', async (args, stream) => {
      stream.push(`${String(args[0])}:first`)
      for await (const item of stream.uplink) stream.push(String(item))
      unblocked.resolve(undefined)
    })
    const left = blocked.open('job/attach', ['job-9'], idle()) as MockClientStream
    for await (const item of left) {
      expect(item).toBe('job-9:first')
      break
    }
    await unblocked.promise
    expect(() => { left.send('late') }).toThrow('remote-mock: uplink was ended')
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
