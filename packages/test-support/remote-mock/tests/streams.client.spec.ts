/** Stream scripts, live stream control, cancellation, and the built-in `$events` opening. */
import { describe, expect, it } from 'vitest'
import { RemoteMock, frames, openStream } from '../src/index.ts'

const idle = (): AbortSignal => new AbortController().signal

async function drain(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of source) items.push(item)
  return items
}

async function take(source: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const item of source) {
    items.push(item)
    if (items.length === count) break
  }
  return items
}

describe('RemoteMock streams', () => {
  it('yields frames() then ends, logging the open, and throws on an unmatched endpoint', async () => {
    const mock = RemoteMock.create().stream('s/f', frames([{ n: 1 }, { n: 2 }]))
    await expect(drain(mock.open('s/f', [{ id: 'a' }], idle()))).resolves.toEqual([{ n: 1 }, { n: 2 }])
    expect(mock.log.streams('s/f')).toEqual([{ endpoint: 's/f', args: [{ id: 'a' }], state: 'ended', pushed: 2, seq: 1 }])
    expect(mock.log.streams('other')).toEqual([])
    expect(() => mock.open('s/g', [], idle())).toThrow('remote-mock: no rule for s/g; registered: $events, s/f')
    expect(mock.log.unmatched()).toEqual([{ endpoint: 's/g', mode: 'stream' }])
  })

  it('keeps openStream() open for pushes, filters by open args, and reports delivery counts', async () => {
    const mock = RemoteMock.create().stream('s/f', openStream(['hello']))
    const sessionOf = ([request]: readonly unknown[]): string => (request as { sessionId: string }).sessionId
    const a = mock.open('s/f', [{ sessionId: 'a' }], idle())
    const b = mock.open('s/f', [{ sessionId: 'b' }], idle())
    expect(mock.streams.push('s/f', 'only-b', open => sessionOf(open) === 'b')).toBe(1)
    expect(mock.streams.push('s/f', 'both')).toBe(2)
    expect(mock.streams.fail('s/f', new Error('gone'), open => sessionOf(open) === 'a')).toBe(1)
    expect(mock.streams.end('s/f')).toBe(1)
    await expect(drain(b)).resolves.toEqual(['hello', 'only-b', 'both'])
    await expect(drain(a)).rejects.toThrow('gone')
    expect(mock.log.streams().map(entry => [entry.state, entry.pushed])).toEqual([['failed', 2], ['ended', 3]])
    expect(mock.streams.push('s/f', 'late')).toBe(0)
  })

  it('resolves a pending read on push, end, or fail; a second concurrent read is a bug; settling twice is a no-op', async () => {
    const mock = RemoteMock.create().stream('s/f', openStream())
    const first = mock.open('s/f', [], idle())[Symbol.asyncIterator]()
    const pending = first.next()
    await expect(first.next()).rejects.toThrow('remote-mock: s/f stream has one consumer')
    mock.streams.push('s/f', 'x')
    await expect(pending).resolves.toEqual({ value: 'x', done: false })
    const ending = first.next()
    mock.streams.end('s/f')
    await expect(ending).resolves.toEqual({ value: undefined, done: true })
    const second = mock.open('s/f', [], idle())[Symbol.asyncIterator]()
    const failing = second.next()
    mock.streams.fail('s/f', new Error('boom'))
    await expect(failing).rejects.toThrow('boom')
    await expect(second.next()).rejects.toThrow('boom')
    expect(mock.streams.end('s/f')).toBe(0)
    const settled = new AbortController()
    const ended = mock.open('s/f', [], settled.signal)
    mock.streams.end('s/f')
    settled.abort()
    await expect(drain(ended)).resolves.toEqual([])
    expect(mock.log.streams().map(entry => entry.state)).toEqual(['ended', 'failed', 'ended'])
  })

  it('lets a consumer that returns after the producer ended drop the rest, so drained() settles', async () => {
    const mock = RemoteMock.create().stream('s/f', frames(['a', 'b']))
    const reader = mock.open('s/f', [], idle())[Symbol.asyncIterator]()
    await expect(reader.next()).resolves.toEqual({ value: 'a', done: false })
    const pending = mock.streams.drained('s/f')
    await expect(reader.return!()).resolves.toEqual({ value: undefined, done: true })
    await expect(pending).resolves.toBeUndefined()
    expect(mock.log.streams('s/f')).toEqual([{ endpoint: 's/f', args: [], state: 'ended', pushed: 2, seq: 1 }])
    expect(mock.streams.push('s/f', 'late')).toBe(0)
  })

  it('treats consumer abort or return() as cancellation and drops later pushes', async () => {
    const mock = RemoteMock.create().stream('s/f', openStream(['queued']))
    const controller = new AbortController()
    const cancelled = mock.open('s/f', [], controller.signal)[Symbol.asyncIterator]()
    await expect(cancelled.next()).resolves.toEqual({ value: 'queued', done: false })
    const waiting = cancelled.next()
    controller.abort()
    await expect(waiting).resolves.toEqual({ value: undefined, done: true })
    expect(mock.streams.push('s/f', 'after')).toBe(0)
    const aborted = new AbortController()
    aborted.abort()
    await expect(drain(mock.open('s/f', [], aborted.signal))).resolves.toEqual([])
    await expect(take(mock.open('s/f', [], idle()), 1)).resolves.toEqual(['queued'])
    expect(mock.log.streams().map(entry => entry.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
  })

  it('aborts the stream handle signal when the consumer returns', async () => {
    let signal: AbortSignal | undefined
    const mock = RemoteMock.create().stream('s/f', (_args, stream) => {
      signal = stream.signal
      stream.push('first')
    })
    const reader = mock.open('s/f', [], idle())[Symbol.asyncIterator]()
    await expect(reader.next()).resolves.toEqual({ value: 'first', done: false })
    await expect(reader.return!()).resolves.toEqual({ value: undefined, done: true })
    expect({
      state: mock.log.streams('s/f')[0]?.state,
      signalAborted: signal?.aborted,
    }).toEqual({ state: 'cancelled', signalAborted: true })
  })

  it('runs script functions with the open args and fails the stream when they throw or reject', async () => {
    const mock = RemoteMock.create()
      .stream('s/echo', (args, stream) => {
        stream.push(args)
        stream.end()
        stream.end()
        stream.fail(new Error('too late'))
      })
      .stream('s/async', async (_args, stream) => {
        await Promise.resolve()
        stream.push('later')
        stream.end()
      })
      .stream('s/throws', () => { throw new Error('sync boom') })
      .stream('s/rejects', () => Promise.reject(new Error('async boom')))
      .stream('s/odd', () => { throw 'string reason' })
    await expect(drain(mock.open('s/echo', [{ a: 1 }], idle()))).resolves.toEqual([[{ a: 1 }]])
    await expect(drain(mock.open('s/async', [], idle()))).resolves.toEqual(['later'])
    await expect(drain(mock.open('s/throws', [], idle()))).rejects.toThrow('sync boom')
    await expect(drain(mock.open('s/rejects', [], idle()))).rejects.toThrow('async boom')
    await expect(drain(mock.open('s/odd', [], idle()))).rejects.toThrow('string reason')
  })

  it('drained() settles once the consumer has pulled every push and waits again, or the stream closed', async () => {
    const mock = RemoteMock.create().stream('s/f', openStream(['first']))
    await expect(mock.streams.drained('s/f')).resolves.toBeUndefined() // nothing open: nothing to drain
    const reader = mock.open('s/f', [], idle())[Symbol.asyncIterator]()
    const unread = mock.streams.drained('s/f')
    let settled = false
    void unread.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false) // 'first' is queued and nobody has pulled it
    await expect(reader.next()).resolves.toEqual({ value: 'first', done: false })
    await Promise.resolve()
    expect(settled).toBe(false) // pulled, but the consumer is not waiting for more yet
    const waiting = reader.next()
    await expect(unread).resolves.toBeUndefined()
    mock.streams.push('s/f', 'second')
    await expect(waiting).resolves.toEqual({ value: 'second', done: false })
    mock.streams.push('s/f', 'third')
    mock.streams.end('s/f')
    const ended = mock.streams.drained('s/f')
    let endedSettled = false
    void ended.then(() => { endedSettled = true })
    await Promise.resolve()
    expect(endedSettled).toBe(false) // ended, but 'third' is still queued
    await expect(reader.next()).resolves.toEqual({ value: 'third', done: false })
    await expect(ended).resolves.toBeUndefined() // queue empty: a settled stream counts as drained
    await expect(reader.next()).resolves.toEqual({ value: undefined, done: true })
    await expect(reader.return!()).resolves.toEqual({ value: undefined, done: true }) // returning a settled stream changes nothing
    const second = mock.open('s/f', [], idle())[Symbol.asyncIterator]()
    await expect(second.next()).resolves.toEqual({ value: 'first', done: false })
    const parked = second.next()
    await expect(mock.streams.drained('s/f')).resolves.toBeUndefined() // its consumer is waiting
    const controller = new AbortController()
    const third = mock.open('s/f', [], controller.signal)
    const cancelling = mock.streams.drained('s/f', () => true) // third holds 'first' that nobody has read
    controller.abort()
    await expect(cancelling).resolves.toBeUndefined() // cancellation discards the queue: closed counts as drained
    await expect(drain(third)).resolves.toEqual([])
    mock.streams.end('s/f')
    await expect(parked).resolves.toEqual({ value: undefined, done: true })
  })

  it('declares a stream without a script: modeOf answers stream and an open is a stream miss', () => {
    const mock = RemoteMock.create().load({ streams: ['s/declared'] })
    expect(mock.modeOf('s/declared')).toBe('stream')
    expect(mock.endpoints()).toEqual(['$events', 's/declared'])
    expect(() => mock.open('s/declared', [], idle())).toThrow('remote-mock: no rule for s/declared; registered: $events, s/declared')
    expect(mock.log.unmatched()).toEqual([{ endpoint: 's/declared', mode: 'stream' }])
    mock.stream('s/declared', frames(['now']))
    expect(mock.modeOf('s/declared')).toBe('stream')
  })

  it('waits for opens with opened(), and answers $events with one ready frame per generation', async () => {
    const mock = RemoteMock.create({ host: { home: '/home/me' } })
    const second = mock.streams.opened('$events', 2)
    const first = mock.open('$events', [{}], idle())
    await expect(take(first, 1)).resolves.toEqual([{ type: 'ready', clientId: 'mock-client-1', host: { home: '/home/me' } }])
    const again = mock.open('$events', [{}], idle())
    await expect(second).resolves.toBeUndefined()
    await expect(mock.streams.opened('$events', 1)).resolves.toBeUndefined()
    await expect(take(again, 1)).resolves.toEqual([{ type: 'ready', clientId: 'mock-client-2', host: { home: '/home/me' } }])
    expect(RemoteMock.create().modeOf('$events')).toBe('stream')
  })
})
