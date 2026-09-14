import { once } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer } from '../src/protocol.ts'

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

function peer(options: { limit?: number; pending?: number; handler?: ConstructorParameters<typeof SshRpcPeer>[4] } = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.resume()
  const connection = new SshRpcPeer(input, output, options.limit ?? 4096, options.pending ?? 8, options.handler)
  onTestFinished(() => { connection.close() })
  return { input, output, connection }
}

function pair(handler: NonNullable<ConstructorParameters<typeof SshRpcPeer>[4]>) {
  const outbound = new PassThrough()
  const inbound = new PassThrough()
  const server = new SshRpcPeer(outbound, inbound, 4096, 8, handler)
  const client = new SshRpcPeer(inbound, outbound, 4096, 8)
  onTestFinished(() => { client.close(); server.close() })
  return { client, server }
}

describe('SSH protocol wire and allocation bounds', () => {
  it('rejects an already-aborted call before transmitting any request', async () => {
    const { connection, output } = peer()
    const controller = new AbortController()
    controller.abort('caller cancelled before allocation')
    const chunks: Buffer[] = []
    output.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    await expect(connection.request('read', {}, z.null(), controller.signal)).rejects.toBe('caller cancelled before allocation')
    expect(chunks).toEqual([])
  })

  it('bounds pending calls without evicting an admitted request', async () => {
    const { connection, input, output } = peer({ pending: 1 })
    const sent = once(output, 'data')
    const first = connection.request('read', {}, z.string())
    const [chunk] = await sent as [Buffer]
    const request = JSON.parse(Buffer.from(chunk).subarray(4).toString()) as { id: string }
    await expect(connection.request('read', {}, z.string())).rejects.toThrow('pending request limit')
    input.write(frame({ type: 'result', id: request.id, value: 'first response' }))
    expect(await first).toBe('first response')
  })

  it('refuses an oversized outbound frame before writing to the transport', async () => {
    const { connection, output } = peer({ limit: 128 })
    let writes = 0
    output.on('data', () => { writes++ })
    await expect(connection.request('write', { content: 'x'.repeat(256) }, z.null())).rejects.toThrow('frame or write queue limit')
    expect(writes).toBe(0)
  })

  it('bounds queued bytes while the first frame is backpressured', async () => {
    const input = new PassThrough()
    let finishWrite: (() => void) | undefined
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { finishWrite = callback } })
    const connection = new SshRpcPeer(input, output, 256, 8)
    onTestFinished(() => { connection.close(); finishWrite?.() })
    const first = connection.request('write', { content: 'a'.repeat(100) }, z.null())
    const second = connection.request('write', { content: 'b'.repeat(100) }, z.null())
    const settled = Promise.allSettled([first, second])
    await expect(connection.request('write', { content: 'c'.repeat(100) }, z.null())).rejects.toThrow('frame or write queue limit')
    connection.close()
    expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
  })

  it('resumes a backpressured write after drain and accepts its response', async () => {
    const input = new PassThrough()
    const entered = Promise.withResolvers<Buffer>()
    let finishWrite: (() => void) | undefined
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) { finishWrite = callback; entered.resolve(chunk) },
    })
    const connection = new SshRpcPeer(input, output, 4096, 8)
    onTestFinished(() => { connection.close(); finishWrite?.() })
    const request = connection.request('read', {}, z.string())
    const payload = JSON.parse((await entered.promise).subarray(4).toString()) as { id: string }
    const drained = once(output, 'drain')
    finishWrite!()
    await drained
    input.write(frame({ type: 'result', id: payload.id, value: 'after drain' }))
    expect(await request).toBe('after drain')
    expect(output.listenerCount('drain')).toBe(0)
  })

  it('settles reentrant transport closure before a drain listener is attached', async () => {
    const input = new PassThrough()
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) { connection.close(new Error('closed during write')); callback() },
    })
    const connection = new SshRpcPeer(input, output, 4096, 8)
    onTestFinished(() => { connection.close() })
    await expect(connection.request('write', {}, z.null())).rejects.toThrow('closed during write')
    expect(output.listenerCount('drain')).toBe(0)
  })

  it('contains cancellation racing transport closure', async () => {
    const { connection } = peer()
    const controller = new AbortController()
    const pending = connection.request('write', {}, z.null(), controller.signal)
    const rejected = expect(pending).rejects.toThrow('unknown')
    connection.close()
    controller.abort()
    await rejected
  })

  it.each(['input', 'output'] as const)('reports %s I/O errors to pending requests', async (which) => {
    const state = peer()
    const pending = state.connection.request('read', {}, z.null())
    const rejected = expect(pending).rejects.toThrow('I/O failure')
    state[which].destroy(new Error('I/O failure'))
    await rejected
  })

  it.each([0, 4097])('rejects incoming payload length %i before allocation', async (length) => {
    const { connection, input } = peer()
    const closed = once(connection, 'closed')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(length)
    input.write(header)
    expect((await closed)[0]).toMatchObject({ message: 'SSH helper sent an invalid frame length' })
  })

  it.each([null, { type: 'unknown' }, { type: 'result', id: 1, value: null }])('rejects malformed JSON protocol fields', async (raw) => {
    const { connection, input } = peer()
    const closed = once(connection, 'closed')
    input.write(frame(raw))
    expect((await closed)[0]).toBeInstanceOf(Error)
  })

  it('rejects invalid JSON bytes within a complete frame', async () => {
    const { connection, input } = peer()
    const closed = once(connection, 'closed')
    input.write(Buffer.from([0, 0, 0, 1, 123]))
    expect((await closed)[0]).toBeInstanceOf(SyntaxError)
  })

  it.each(['header', 'payload'] as const)('reports an unknown outcome when EOF splits the %s', async (part) => {
    const { connection, input } = peer()
    const closed = once(connection, 'closed')
    const full = frame({ type: 'cancel', id: 'cancelled' })
    input.end(full.subarray(0, part === 'header' ? 2 : full.length - 1))
    expect((await closed)[0]).toMatchObject({ message: 'SSH helper disconnected during a frame; outcome is unknown' })
  })

  it('accepts fragmented Uint8Array chunks and more than one frame per chunk', async () => {
    const whole = frame({ type: 'request', id: 'one', method: 'echo', params: 'first' })
    const second = frame({ type: 'request', id: 'two', method: 'echo', params: 'second' })
    const input = new Readable({ objectMode: true, read() {} })
    const output = new PassThrough()
    output.resume()
    const received = Promise.withResolvers<undefined>()
    const values: unknown[] = []
    const connection = new SshRpcPeer(input, output, 4096, 8, async (_method, value) => {
      values.push(value)
      if (values.length === 2) received.resolve(undefined)
      return value
    })
    onTestFinished(() => { connection.close() })
    input.push(new Uint8Array(whole.subarray(0, 2)))
    await new Promise((resolve) => { setImmediate(resolve) })
    input.push(new Uint8Array(whole.subarray(2, 9)))
    await new Promise((resolve) => { setImmediate(resolve) })
    input.push(new Uint8Array(Buffer.concat([whole.subarray(9), second])))
    await received.promise
    expect(values).toEqual(['first', 'second'])
  })

  it.each(['unexpected', 'duplicate', 'excessive'] as const)('rejects an %s inbound request', async (kind) => {
    const released = Promise.withResolvers<undefined>()
    const { connection, input } = peer({
      pending: 1,
      ...(kind === 'unexpected' ? {} : { handler: async () => { await released.promise; return null } }),
    })
    onTestFinished(() => { released.resolve(undefined) })
    const closed = once(connection, 'closed')
    input.write(frame({ type: 'request', id: 'one', method: 'read', params: {} }))
    if (kind !== 'unexpected') input.write(frame({ type: 'request', id: kind === 'duplicate' ? 'one' : 'two', method: 'read', params: {} }))
    expect((await closed)[0]).toMatchObject({ message: 'SSH helper received an unexpected or excessive request' })
  })

  it('ignores late replies and unknown cancellation identities', async () => {
    const { connection, input } = peer()
    input.write(Buffer.concat([
      frame({ type: 'result', id: 'expired', value: null }),
      frame({ type: 'error', id: 'expired', error: { name: 'Error', message: 'late' } }),
      frame({ type: 'cancel', id: 'absent' }),
    ]))
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(input.destroyed).toBe(false)
    connection.close()
  })

  it('encodes an operation without a return value as JSON null', async () => {
    const { client } = pair(async () => undefined)
    expect(await client.request('notify', {}, z.null())).toBeNull()
  })

  it('serializes a primitive AbortSignal reason as a remote error', async () => {
    const controller = new AbortController()
    controller.abort('operation owner cancelled')
    const { client } = pair(async () => { controller.signal.throwIfAborted() })
    await expect(client.request('read', {}, z.null())).rejects.toMatchObject({ message: 'operation owner cancelled', code: undefined })
  })

  it('omits non-string native error codes from the wire error metadata', async () => {
    const { client } = pair(async () => { throw Object.assign(new Error('native operation failed'), { code: 5 }) })
    await expect(client.request('read', {}, z.null())).rejects.toMatchObject({ message: 'native operation failed', code: undefined })
  })
})
