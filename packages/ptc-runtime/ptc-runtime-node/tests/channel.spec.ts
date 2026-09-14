import { Duplex, PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import { JsonChannel } from '../src/channel.ts'

function pair() {
  const left = new PassThrough()
  const right = new PassThrough()
  const a = Duplex.from({ readable: left, writable: right })
  const b = Duplex.from({ readable: right, writable: left })
  // Duplex.from forwards peer destruction as ABORT_ERR; channel owners observe their own failures.
  a.on('error', () => {})
  b.on('error', () => {})
  onTestFinished(() => { a.destroy(); b.destroy() })
  return { a, b }
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

describe('bounded process frames', () => {
  it('reassembles split binary headers and UTF-8 bodies', async () => {
    const { a, b } = pair()
    const received = Promise.withResolvers<unknown>()
    const channel = new JsonChannel(a, 1000, (value) => { received.resolve(value) }, (error) => { received.reject(error) })
    onTestFinished(() => { channel.close() })
    const bytes = frame({ text: '你好🙂' })
    for (const byte of bytes) b.write(Buffer.from([byte]))
    expect(await received.promise).toEqual({ text: '你好🙂' })
  })

  it('accepts consecutive frames and writes complete responses', async () => {
    const { a, b } = pair()
    const received: unknown[] = []
    const done = Promise.withResolvers<undefined>()
    const channel = new JsonChannel(a, 1000, (value) => {
      received.push(value)
      if (received.length === 2) done.resolve(undefined)
    }, (error) => { done.reject(error) })
    const peer = new JsonChannel(b, 1000, () => {}, (error) => { done.reject(error) })
    onTestFinished(() => { channel.close(); peer.close() })
    await Promise.all([peer.send({ n: 1 }), peer.send({ n: 2 })])
    await done.promise
    expect(received).toEqual([{ n: 1 }, { n: 2 }])
    await peer.drain()
  })

  it.each([0, 65])('rejects a declared %i-byte frame before accepting its body', async (length) => {
    const { a, b } = pair()
    const failure = Promise.withResolvers<Error>()
    const channel = new JsonChannel(a, 64, () => { throw new Error('must not dispatch') }, (error) => { failure.resolve(error) })
    onTestFinished(() => { channel.close() })
    const header = Buffer.alloc(4)
    header.writeUInt32BE(length)
    b.write(header)
    expect((await failure.promise).message).toContain('control frame')
  })

  it('contains malformed JSON, invalid UTF-8 and receiver failures', async () => {
    for (const payload of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('{}')]) {
      const { a, b } = pair()
      const failure = Promise.withResolvers<Error>()
      const channel = new JsonChannel(a, 64, () => { throw new Error('receiver failed') }, (error) => { failure.resolve(error) })
      const header = Buffer.alloc(4)
      header.writeUInt32BE(payload.length)
      b.write(Buffer.concat([header, payload]))
      expect(await failure.promise).toBeInstanceOf(Error)
      channel.close()
    }
  })

  it('rejects oversized writes and closed channels', async () => {
    const { a } = pair()
    const channel = new JsonChannel(a, 20, () => {}, () => {})
    await expect(channel.send({ text: 'x'.repeat(30) })).rejects.toThrow('queued bytes')
    channel.close()
    channel.close()
    await expect(channel.send({})).rejects.toThrow('closed')
  })

  it('reports peer EOF while a program is active', async () => {
    const { a, b } = pair()
    const failure = Promise.withResolvers<Error>()
    const channel = new JsonChannel(a, 64, () => {}, (error) => { failure.resolve(error) })
    onTestFinished(() => { channel.close() })
    b.end()
    expect((await failure.promise).message).toContain('ended')
  })
})

it('retains a partial header and partial payload across distinct stream deliveries', () => {
  const { a } = pair()
  const values: unknown[] = []
  const channel = new JsonChannel(a, 64, (value) => { values.push(value) }, (error) => { throw error })
  const bytes = frame({ value: 1 })
  a.emit('data', bytes.subarray(0, 2))
  a.emit('data', bytes.subarray(2, 6))
  a.emit('data', bytes.subarray(6))
  expect(values).toEqual([{ value: 1 }])
  channel.close()
})

it('contains a receiver throwing a non-Error value', () => {
  const { a } = pair()
  const failures: string[] = []
  const channel = new JsonChannel(a, 64, () => { throw 'receiver failure' }, (error) => { failures.push(error.message) })
  a.emit('data', frame({}))
  expect(failures).toEqual(['receiver failure'])
  channel.close()
})

it('ignores callbacks already captured by an emission when an earlier listener closes the channel', () => {
  for (const event of ['data', 'end']) {
    const { a } = pair()
    let failures = 0
    const channel = new JsonChannel(a, 64, () => { throw new Error('closed channel dispatched') }, () => { failures += 1 })
    a.prependOnceListener(event, () => { channel.close() })
    a.emit(event, frame({}))
    a.emit('error', new Error('late closed stream error'))
    expect(failures).toBe(0)
  }
})

it('rejects pending write receipts when the owner closes', async () => {
  const { a } = pair()
  const channel = new JsonChannel(a, 64, () => {}, () => {})
  const pending = channel.send({ n: 1 })
  channel.close()
  await expect(pending).rejects.toThrow('closed')
  await channel.drain()
})

it('bounds queued frames while a receiver is not reading', async () => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, _callback) {} })
  const channel = new JsonChannel(stream, 32, () => {}, () => {})
  const pending = channel.send({ value: '1234567890' })
  await expect(channel.send({ value: '1234567890' })).rejects.toThrow('queued bytes')
  const draining = channel.drain()
  channel.close()
  await expect(pending).rejects.toThrow('closed')
  await draining
})

it.each(['error', 'close'])('settles a blocked write when the stream emits %s', async (event) => {
  const entered = Promise.withResolvers<undefined>()
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, _callback) { entered.resolve(undefined) } })
  let failure: Error | undefined
  const channel = new JsonChannel(stream, 64, () => {}, (error) => { failure = error })
  const pending = channel.send({ value: 1 })
  await entered.promise
  stream.emit(event, new Error('transport failed'))
  await expect(pending).rejects.toThrow(event === 'error' ? 'transport failed' : 'closed')
  if (event === 'error') expect(failure?.message).toBe('transport failed')
  channel.close()
})


it.each([new Error('write failed'), 'write failed'])('rejects a synchronous transport write failure: %s', async (failure) => {
  const stream = new Duplex({ read() {}, write() { throw failure } })
  const channel = new JsonChannel(stream, 64, () => {}, () => {})
  onTestFinished(() => { channel.close() })
  await expect(channel.send({ value: 1 })).rejects.toThrow('write failed')
})
