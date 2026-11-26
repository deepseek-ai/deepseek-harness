import { readFile } from 'node:fs/promises'
import { PassThrough, Transform, Writable } from 'node:stream'
import { serialize } from 'node:v8'
import { describe, expect, it, vi } from 'vitest'
import {
  asError, ENVIRONMENT_PROTOCOL_VERSION, minPartBytes, RemoteRequestError, RpcDisconnectedError, RpcNotSentError, RpcPeer,
  type RpcHandler, type RpcLimits,
} from '../src/protocol.ts'
import { decodeFrames, frame, type WireFrame } from './fixtures/frames.ts'

const limits: RpcLimits = { maxFrameBytes: 1024, maxMessageBytes: 8192, maxPending: 2, cancelGraceMs: 10_000 }

/** Part frames carrying the encoding of `message`, `room` bytes each, as a sender with 1024-byte frames splits it. */
function parts(message: unknown, id: number, reply: boolean, room = minPartBytes()): Buffer[] {
  const payload = serialize(message)
  const result: Buffer[] = []
  for (let offset = 0; offset < payload.length; offset += room) {
    result.push(frame({ type: 'part', id, reply, size: payload.length, data: payload.subarray(offset, offset + room) }))
  }
  return result
}

/** Frame lengths among written bytes. */
function frameSizes(bytes: Buffer): number[] {
  const result: number[] = []
  for (let offset = 0; offset + 4 <= bytes.length; offset += 4 + bytes.readUInt32BE(offset)) result.push(bytes.readUInt32BE(offset))
  return result
}

/** A pipe whose written bytes reach `sink` at once but whose writes complete only when the test releases them. */
function gate(): { stream: Writable; sink: PassThrough; release: () => void; frames: () => WireFrame[] } {
  const sink = new PassThrough()
  const held: (() => void)[] = []
  const chunks: Buffer[] = []
  const stream = new Writable({
    writev(written, callback) {
      for (const { chunk } of written) {
        chunks.push(chunk as Buffer)
        sink.write(chunk)
      }
      held.push(callback)
    },
  })
  const release = (): void => { for (const callback of held.splice(0)) callback() }
  return { stream, sink, release, frames: () => decodeFrames(Buffer.concat(chunks)) }
}

interface Pair { client: RpcPeer; server: RpcPeer; toServer: Transform; toClient: PassThrough; wire: () => Buffer }

/** Two connected peers; `wire` returns the bytes the client has sent. */
function pair(handler?: RpcHandler, left = limits, right = limits, clientHandler?: RpcHandler): Pair {
  const written: Buffer[] = []
  const toServer = new Transform({ transform(chunk: Buffer, _encoding, callback) { written.push(chunk); callback(null, chunk) } })
  const toClient = new PassThrough()
  const client = new RpcPeer(toClient, toServer, left, clientHandler)
  const server = new RpcPeer(toServer, toClient, right, handler)
  return { client, server, toServer, toClient, wire: () => Buffer.concat(written) }
}

/** A peer whose input the test writes and whose output it decodes; its handler echoes `echo` requests. */
function raw(peerLimits = limits): { peer: RpcPeer; input: PassThrough; frames: () => WireFrame[] } {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: Buffer[] = []
  output.on('data', (chunk: Buffer) => { written.push(chunk) })
  const peer = new RpcPeer(input, output, peerLimits, async (method, params) => method === 'echo' ? params : undefined)
  return { peer, input, frames: () => decodeFrames(Buffer.concat(written)) }
}

/**
 * Wait until a `raw` peer has read every frame written to its input so far, which its answer to a later request shows.
 * @returns a function that waits once per call.
 */
function drainer(input: PassThrough, frames: () => WireFrame[]): () => Promise<void> {
  let marker = 100
  return async () => {
    const id = ++marker
    input.write(frame({ type: 'request', id, method: 'echo', params: id }))
    await vi.waitFor(() => { expect(frames()).toContainEqual({ type: 'result', id, value: id }) })
  }
}

/** Length of the request encoding that carries `n` one-byte characters as its parameters. */
const requestBytes = (id: number, n: number): number => serialize({ type: 'request', id, method: 'm', params: 'x'.repeat(n) }).length

/** Characters that make request `id` encode to exactly `target` bytes. */
function fill(id: number, target: number): number {
  let n = target - requestBytes(id, 0)
  while (requestBytes(id, n) > target) n--
  expect(requestBytes(id, n)).toBe(target)
  return n
}

describe('RpcPeer', () => {
  it('round-trips structured-clone values, including binary data and undefined, in both directions', async () => {
    const echo: RpcHandler = async (_method, params) => params
    const { client, server } = pair(echo, limits, limits, echo)
    const value = {
      bytes: new Uint8Array([0, 1, 255]), buffer: Buffer.from('binary'), missing: undefined, nested: [undefined, null, 10n],
      date: new Date(0), map: new Map([['key', new Set([1])]]),
    }
    for (const [from, to] of [[client, 'server'], [server, 'client']] as const) {
      const echoed = await from.request('echo', value) as typeof value
      expect(echoed, to).toEqual(value)
      expect(Object.hasOwn(echoed, 'missing')).toBe(true)
      expect(Buffer.isBuffer(echoed.buffer)).toBe(true)
      expect(Buffer.isBuffer(echoed.bytes)).toBe(false)
      expect(echoed.bytes).toBeInstanceOf(Uint8Array)
      await expect(from.request('echo', undefined)).resolves.toBeUndefined()
    }
  })

  it('reports remote errors with their name, message and string code', async () => {
    const { client } = pair(async (method) => {
      switch (method) {
        case 'typed': throw Object.assign(new TypeError('bad input'), { code: 'E_INPUT' })
        case 'errno': return await readFile('/nonexistent/dsh-environment-protocol')
        case 'numeric': throw Object.assign(new Error('numeric code'), { code: 42 })
        case 'named': throw Object.assign(new Error('numeric name'), { name: 42 })
        case 'undescribable': throw Object.create(null)
        default: throw 'plain' // A non-Error rejection reaches the peer as text.
      }
    })
    const typed = await client.request('typed', null).catch((error: unknown) => error)
    expect(typed).toBeInstanceOf(RemoteRequestError)
    expect(typed).toMatchObject({ name: 'TypeError', message: 'bad input', code: 'E_INPUT' })
    await expect(client.request('errno', null)).rejects.toMatchObject({ name: 'Error', code: 'ENOENT' })
    for (const [method, name, message] of [
      ['numeric', 'Error', 'numeric code'], ['plain', 'Error', 'plain'], ['named', '42', 'numeric name'],
      ['undescribable', 'Error', 'Execution environment request failed with a value that cannot be described'],
    ] as const) {
      const failure = asError(await client.request(method, null).catch((error: unknown) => error))
      expect(failure).toMatchObject({ name, message })
      expect(Object.hasOwn(failure, 'code')).toBe(false)
    }
    expect(client.failed).toBe(false)
  })

  it('cancels a served request and ignores its late result', async () => {
    const aborted = Promise.withResolvers<unknown>()
    const started = Promise.withResolvers<undefined>()
    const late = Promise.withResolvers<string>()
    const { client } = pair(async (method, params, signal) => {
      if (method === 'echo') return params
      signal.addEventListener('abort', () => { aborted.resolve(signal.reason) })
      started.resolve(undefined)
      return await late.promise
    })
    const controller = new AbortController()
    const request = client.request('wait', null, controller.signal)
    await started.promise
    controller.abort(new Error('stop'))
    await expect(request).rejects.toThrow('stop')
    await expect(aborted.promise).resolves.toEqual(expect.objectContaining({ message: 'Execution environment request cancelled by its caller' }))
    late.resolve('late')
    await expect(client.request('echo', 1)).resolves.toBe(1)
  })

  it('ignores answers to unknown request ids', async () => {
    const { peer, input, frames } = raw()
    input.write(Buffer.concat([
      frame({ type: 'result', id: 99, value: null }),
      frame({ type: 'error', id: 98, error: { name: 'Error', message: 'x' } }),
      frame({ type: 'part', id: 97, reply: true, size: 3000, data: new Uint8Array(minPartBytes()) }),
      frame({ type: 'request', id: 1, method: 'echo', params: 1 }),
    ]))
    await vi.waitFor(() => { expect(frames()).toEqual([{ type: 'result', id: 1, value: 1 }]) })
    expect(peer.failed).toBe(false)
  })

  it('rejects a pre-aborted request and requests beyond the pending limit', async () => {
    const { client } = pair(() => new Promise(() => {}))
    await expect(client.request('x', null, AbortSignal.abort(new Error('early')))).rejects.toThrow('early')
    void client.request('x', null).catch(() => {})
    void client.request('x', null).catch(() => {})
    await expect(client.request('x', null)).rejects.toThrow('pending request limit')
  })

  it('cuts the fields of an error answer that would not fit one frame, without closing', async () => {
    // A getter that throws while the answer is encoded supplies an error message of any length.
    const unsendable = Object.defineProperty({}, 'value', { enumerable: true, get: () => { throw new Error('x'.repeat(3000)) } })
    const { client } = pair(async method => method === 'unsendable' ? unsendable : 1)
    const failure = asError(await client.request('unsendable', null).catch((error: unknown) => error))
    expect(failure.message).toMatch(/^Execution environment cannot send a value that structured clone does not support: x+…$/)
    expect(failure.message.length).toBe(Math.floor((limits.maxFrameBytes - 128) / 4))
    await expect(client.request('other', null)).resolves.toBe(1)
    expect(client.failed).toBe(false)
  })

  it('refuses a message over maxMessageBytes before sending, and reports an oversized result, without closing', async () => {
    const { client, wire } = pair(async (method, params) => method === 'big' ? 'x'.repeat(9000) : params)
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(client.request('echo', 'y'.repeat(9000))).rejects.toThrow(/^Execution environment message of 9\d{3} bytes exceeds maxMessageBytes \(8192\)$/)
    }
    expect(wire()).toHaveLength(0)
    const oversized = client.request('big', null)
    await expect(oversized).rejects.toBeInstanceOf(RemoteRequestError)
    await expect(oversized).rejects.toThrow(/exceeds maxMessageBytes \(8192\)$/)
    // Refused requests took no slot.
    await expect(Promise.all([client.request('echo', 1), client.request('echo', 2)])).resolves.toEqual([1, 2])
    expect(client.failed).toBe(false)
  })

  it('accepts a message of exactly maxMessageBytes and refuses one byte more', async () => {
    const { client } = pair(async (_method, params) => typeof params === 'string' ? params.length : params)
    await expect(client.request('m', 'x'.repeat(fill(1, 8192)))).resolves.toBe(fill(1, 8192))
    await expect(client.request('m', 'x'.repeat(fill(2, 8192) + 1))).rejects.toThrow('exceeds maxMessageBytes')
  })

  it('sends a message over maxFrameBytes as parts no larger than the frame limit, in both directions', async () => {
    const data = Buffer.from(Array.from({ length: 3000 }, (_, index) => index % 251))
    const { client, wire } = pair(async (_method, params) => Buffer.concat([params as Buffer, params as Buffer]))
    await expect(client.request('twice', data)).resolves.toEqual(Buffer.concat([data, data]))
    const sizes = frameSizes(wire())
    expect(sizes.length).toBeGreaterThan(2)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(1024)
    expect(decodeFrames(wire()).every(sent => sent.type === 'part' && sent.id === 1 && sent.reply === false)).toBe(true)
  })

  it('sends a message of exactly maxFrameBytes as one frame and one byte more as parts', async () => {
    const { client, wire } = pair(async (_method, params) => (params as string).length)
    const exact = fill(1, 1024)
    await expect(client.request('m', 'x'.repeat(exact))).resolves.toBe(exact)
    expect(frameSizes(wire())).toEqual([1024])
    const over = fill(2, 1024) + 1
    await expect(client.request('m', 'x'.repeat(over))).resolves.toBe(over)
    expect(decodeFrames(wire()).slice(1).map(sent => sent.type)).toEqual(['part', 'part'])
  })

  it('interleaves the parts of concurrent messages that fit maxMessageBytes together and lets a small message pass them', async () => {
    const three = { ...limits, maxPending: 3 }
    const { client, wire } = pair(async (_method, params) => params instanceof Uint8Array ? params.length : params, three, three)
    const [first, second, small] = await Promise.all([
      client.request('a', new Uint8Array(4000).fill(1)), client.request('b', new Uint8Array(4000).fill(2)), client.request('c', 'small'),
    ])
    expect([first, second, small]).toEqual([4000, 4000, 'small'])
    const order = decodeFrames(wire()).map(sent => sent.id)
    const last = (id: number): number => order.lastIndexOf(id)
    expect(order.indexOf(2)).toBeLessThan(last(1))
    expect(order.indexOf(3)).toBeLessThan(Math.min(last(1), last(2)))
  })

  it('sends larger messages as parts one after another, while single frames pass them', async () => {
    const three = { ...limits, maxPending: 3 }
    const { client, wire } = pair(async (_method, params) => params instanceof Uint8Array ? params.length : params, three, three)
    await expect(Promise.all([
      client.request('a', new Uint8Array(5000)), client.request('b', new Uint8Array(5000)), client.request('c', 'small'),
    ])).resolves.toEqual([5000, 5000, 'small'])
    const order = decodeFrames(wire()).map(sent => sent.id)
    expect(order.lastIndexOf(1)).toBeLessThan(order.indexOf(2))
    expect(order.indexOf(3)).toBeLessThan(order.lastIndexOf(1))
  })

  it('frees the slot of a request cancelled while it waits to be sent as parts, sending nothing of it', async () => {
    const toServer = gate()
    const toClient = new PassThrough()
    const client = new RpcPeer(toClient, toServer.stream, { ...limits, maxPending: 2 })
    new RpcPeer(toServer.sink, toClient, limits, async (_method, params) => params instanceof Uint8Array ? params.length : params)
    const first = client.request('a', new Uint8Array(5000))
    const controller = new AbortController()
    const queued = client.request('b', new Uint8Array(5000), controller.signal)
    controller.abort(new Error('stop'))
    await expect(queued).rejects.toThrow('stop')
    const later = client.request('echo', 'later')
    const pump = setInterval(() => { toServer.release() }, 1)
    try {
      await expect(Promise.all([first, later])).resolves.toEqual([5000, 'later'])
    } finally {
      clearInterval(pump)
    }
    expect(toServer.frames().filter(sent => sent.id === 2)).toEqual([])
    expect(client.failed).toBe(false)
  })

  it('answers with the cancellation of an answer that waits to be sent as parts', async () => {
    const toClient = gate()
    const toServer = new PassThrough()
    const client = new RpcPeer(toClient.sink, toServer, { ...limits, maxPending: 2 })
    let handled = 0
    new RpcPeer(toServer, toClient.stream, limits, async () => {
      handled++
      return new Uint8Array(5000)
    })
    const first = client.request('a', null)
    const controller = new AbortController()
    const second = client.request('b', null, controller.signal)
    await vi.waitFor(() => { expect(handled).toBe(2) })
    controller.abort(new Error('stop'))
    await expect(second).rejects.toThrow('stop')
    const pump = setInterval(() => { toClient.release() }, 1)
    try {
      await expect(first).resolves.toEqual(new Uint8Array(5000))
      // The cancellation's answer frees the slot.
      await vi.waitFor(async () => { await expect(client.request('c', null)).resolves.toEqual(new Uint8Array(5000)) })
    } finally {
      clearInterval(pump)
    }
    expect(toClient.frames().filter(sent => sent.id === 2))
      .toEqual([{ type: 'error', id: 2, error: { name: 'Error', message: 'Execution environment request cancelled by its caller' } }])
  })

  it('keeps at most maxMessageBytes of partially received messages and closes on a peer that sends more at once', async () => {
    const held = (id: number) => ({ type: 'request', id, method: 'hold', params: new Uint8Array(4000) })
    const request = (id: number) => parts(held(id), id, false)
    const answer = parts({ type: 'result', id: 1, value: new Uint8Array(4000) }, 1, true)
    const { peer, input, frames } = raw({ ...limits, maxPending: 4 })
    const drained = drainer(input, frames)
    const controller = new AbortController()
    const cancelled = peer.request('x', null, controller.signal)
    input.write(Buffer.concat([answer[0]!, request(1)[0]!]))
    await drained()
    // The answer of a cancelled request is no longer kept, which leaves room for another request.
    controller.abort(new Error('stop'))
    await expect(cancelled).rejects.toThrow('stop')
    input.write(request(2)[0]!)
    input.write(Buffer.concat(answer.slice(1)))
    // A completed message returns its room.
    input.write(Buffer.concat(request(1).slice(1)))
    input.write(request(3)[0]!)
    await drained()
    expect(peer.failed).toBe(false)
    input.write(request(4)[0]!)
    const size = serialize(held(4)).length
    expect((await peer.closed).message)
      .toBe(`Execution environment peer sent parts of messages totalling ${3 * size} bytes at once, over maxMessageBytes (8192)`)
  })

  it('reassembles interleaved parts of several answers', async () => {
    const { peer, input } = raw()
    const first = peer.request('a', null)
    const second = peer.request('b', null)
    const one = parts({ type: 'result', id: 1, value: 'a'.repeat(1200) }, 1, true)
    const two = parts({ type: 'error', id: 2, error: { name: 'RangeError', message: 'b'.repeat(1200), code: 'E_B' } }, 2, true)
    for (let index = 0; index < Math.max(one.length, two.length); index++) {
      for (const part of [one[index], two[index]]) if (part !== undefined) input.write(part)
    }
    await expect(first).resolves.toBe('a'.repeat(1200))
    await expect(second).rejects.toMatchObject({ name: 'RangeError', message: 'b'.repeat(1200), code: 'E_B' })
  })

  it('stops sending a cancelled request, whose parts the other peer drops before answering the cancellation', async () => {
    const toServer = gate()
    const toClient = new PassThrough()
    let invoked = 0
    const client = new RpcPeer(toClient, toServer.stream, { ...limits, maxPending: 1 })
    new RpcPeer(toServer.sink, toClient, limits, async (_method, params) => { invoked++; return params })
    const controller = new AbortController()
    const request = client.request('echo', new Uint8Array(5000), controller.signal)
    await vi.waitFor(() => { expect(toServer.frames()).toHaveLength(1) })
    controller.abort(new Error('stop'))
    await expect(request).rejects.toThrow('stop')
    toServer.release()
    await vi.waitFor(() => { expect(toServer.frames().map(sent => sent.type)).toEqual(['part', 'cancel']) })
    toServer.release()
    // The slot frees once the other peer answers the cancellation.
    await vi.waitFor(async () => {
      const probe = client.request('echo', 'probe')
      toServer.release()
      await expect(probe).resolves.toBe('probe')
    })
    expect(invoked).toBe(1)
    expect(client.failed).toBe(false)
  })

  it('stops sending a cancelled answer and reports the cancellation instead', async () => {
    const toClient = gate()
    const toServer = new PassThrough()
    let served: AbortSignal | undefined
    const client = new RpcPeer(toClient.sink, toServer, { ...limits, maxPending: 1 })
    new RpcPeer(toServer, toClient.stream, limits, async (method, params, signal) => {
      served = signal
      return method === 'big' ? new Uint8Array(5000) : params
    })
    const controller = new AbortController()
    const request = client.request('big', null, controller.signal)
    await vi.waitFor(() => { expect(toClient.frames()).toHaveLength(1) })
    controller.abort(new Error('stop'))
    await expect(request).rejects.toThrow('stop')
    await vi.waitFor(() => { expect(served?.aborted).toBe(true) })
    toClient.release()
    await vi.waitFor(() => { expect(toClient.frames().map(sent => sent.type)).toEqual(['part', 'error']) })
    expect(toClient.frames()[1]).toEqual({ type: 'error', id: 1, error: { name: 'Error', message: 'Execution environment request cancelled by its caller' } })
    toClient.release()
    // The slot frees once the cancellation's answer arrives.
    await vi.waitFor(async () => { await expect(client.request('echo', 'probe')).resolves.toBe('probe') })
  })

  it('drops the answer of a cancelled request as it arrives and frees the slot once it completes', async () => {
    const { peer, input, frames } = raw({ ...limits, maxPending: 1 })
    const drained = drainer(input, frames)
    // Cancelled while its answer arrives, and before its answer starts.
    for (const [id, before] of [[1, 1], [2, 0]] as const) {
      const controller = new AbortController()
      const request = peer.request('x', null, controller.signal)
      const answer = parts({ type: 'result', id, value: new Uint8Array(3000) }, id, true)
      for (const part of answer.slice(0, before)) input.write(part)
      await drained()
      controller.abort(new Error('stop'))
      await expect(request).rejects.toThrow('stop')
      await expect(peer.request('x', null)).rejects.toThrow('pending request limit reached')
      for (const part of answer.slice(before)) input.write(part)
      await drained()
    }
    const probe = peer.request('probe', null)
    input.write(frame({ type: 'result', id: 3, value: 'answered' }))
    await expect(probe).resolves.toBe('answered')
    expect(peer.failed).toBe(false)
  })

  it('drops partially received messages and stops sending when the connection closes', async () => {
    const toServer = gate()
    const toClient = new PassThrough()
    let invoked = 0
    const client = new RpcPeer(toClient, toServer.stream, limits)
    const server = new RpcPeer(toServer.sink, toClient, limits, async () => { invoked++ })
    const request = client.request('echo', new Uint8Array(5000))
    // This message waits for the first to leave room before its parts are sent.
    const queued = client.request('echo', new Uint8Array(5000))
    await vi.waitFor(() => { expect(toServer.frames()).toHaveLength(1) })
    server.close(new Error('gone'))
    await expect(request).rejects.toThrow()
    await expect(queued).rejects.toThrow()
    toServer.release()
    await new Promise(resolve => setImmediate(resolve))
    expect(invoked).toBe(0)
    expect(client.failed).toBe(true)
  })

  it('reassembles frames split across chunks and splits frames sharing a chunk', async () => {
    const { input, frames } = raw()
    const bytes = Buffer.concat([
      frame({ type: 'request', id: 1, method: 'echo', params: 'é' }), frame({ type: 'request', id: 2, method: 'echo', params: 2 }),
    ])
    for (const [start, end] of [[0, 1], [1, 3], [3, 10], [10, 52], [52, bytes.length]]) {
      input.write(bytes.subarray(start, end))
      // The peer reads each write as its own chunk once the event loop turns.
      await new Promise(resolve => setImmediate(resolve))
    }
    await vi.waitFor(() => { expect(frames()).toHaveLength(2) })
    expect(frames()).toEqual([{ type: 'result', id: 1, value: 'é' }, { type: 'result', id: 2, value: 2 }])
  })

  it('accepts a frame of exactly maxFrameBytes and closes on an empty or larger one', async () => {
    const accepted = raw()
    const body = serialize({ type: 'request', id: 1, method: 'echo', params: '' })
    const padded = serialize({ type: 'request', id: 1, method: 'echo', params: 'x'.repeat(1024 - body.length - 1) })
    expect(padded.length).toBe(1024)
    accepted.input.write(frame({ type: 'request', id: 1, method: 'echo', params: 'x'.repeat(1024 - body.length - 1) }))
    await vi.waitFor(() => { expect(accepted.frames()).toHaveLength(1) })
    for (const size of [0, 1025]) {
      const refused = raw()
      const pending = refused.peer.request('x', null)
      const header = Buffer.alloc(4)
      header.writeUInt32BE(size)
      refused.input.write(header)
      await expect(pending).rejects.toThrow(`Execution environment peer sent a frame of ${size} bytes; frames hold 1 to 1024 bytes`)
      expect(refused.peer.failed).toBe(true)
      await expect(refused.peer.request('x', null)).rejects.toBeInstanceOf(RpcNotSentError)
    }
  })

  it('bounds a message in one frame by maxMessageBytes too', async () => {
    const { peer, input } = raw({ ...limits, maxFrameBytes: 4096, maxMessageBytes: 2048 })
    const message = { type: 'request', id: 1, method: 'echo', params: 'x'.repeat(3000) }
    input.write(frame(message))
    expect((await peer.closed).message)
      .toBe(`Execution environment peer sent a message of ${serialize(message).length} bytes, over maxMessageBytes (2048)`)
  })

  it('names a peer that speaks the newline-delimited JSON of protocol 2', async () => {
    const { peer, input } = raw()
    input.write('{"type":"request","id":1,"method":"auth","params":{"protocol":2}}\n')
    expect((await peer.closed).message)
      .toBe(`Execution environment peer sent newline-delimited JSON, which protocol 2 and earlier use; this peer speaks protocol ${ENVIRONMENT_PROTOCOL_VERSION}`)
  })

  it('closes on undecodable and invalid frames, unexpected requests and excess served requests', async () => {
    const undecodable = raw()
    undecodable.input.write(Buffer.from([0, 0, 0, 3, 1, 2, 3]))
    expect((await undecodable.peer.closed).message).toMatch(/^Execution environment peer sent an undecodable frame: /)

    const invalid = raw()
    invalid.input.write(frame({ type: 'nope' }))
    expect((await invalid.peer.closed).message).toContain('Invalid')

    const { client: unhandled, toClient } = pair()
    toClient.write(frame({ type: 'request', id: 1, method: 'x', params: null }))
    expect((await unhandled.closed).message).toBe('Execution environment peer sent an unexpected or excessive request')

    const busy = new PassThrough()
    const peer = new RpcPeer(busy, new PassThrough(), limits, () => new Promise(() => {}))
    busy.write(Buffer.concat([frame({ type: 'request', id: 1, method: 'x', params: null }), frame({ type: 'request', id: 1, method: 'x', params: null })]))
    expect((await peer.closed).message).toContain('unexpected or excessive')
  })

  it('counts partially received requests against the pending limit and refuses reused ids', async () => {
    const request = (id: number) => parts({ type: 'request', id, method: 'echo', params: 'x'.repeat(1200) }, id, false)
    for (const sent of [
      [request(1)[0]!, request(2)[0]!, request(3)[0]!],
      [request(1)[0]!, frame({ type: 'request', id: 1, method: 'echo', params: null })],
      [frame({ type: 'request', id: 1, method: 'hold', params: null }), request(1)[0]!],
    ]) {
      const input = new PassThrough()
      const peer = new RpcPeer(input, new PassThrough(), limits, () => new Promise(() => {}))
      input.write(Buffer.concat(sent))
      expect((await peer.closed).message).toBe('Execution environment peer sent an unexpected or excessive request')
    }
    const { client: unhandled, toClient } = pair()
    toClient.write(request(1)[0]!)
    expect((await unhandled.closed).message).toBe('Execution environment peer sent an unexpected or excessive request')
  })

  it('closes on parts over maxMessageBytes, inconsistent or short parts and parts of something other than a message', async () => {
    const message = { type: 'request', id: 1, method: 'echo', params: 'x'.repeat(1200) }
    const cases: [Buffer[], string | RegExp][] = [
      [[frame({ type: 'part', id: 1, reply: false, size: 9000, data: new Uint8Array(10) })], 'Execution environment peer sent a message of 9000 bytes, over maxMessageBytes (8192)'],
      [[frame({ type: 'part', id: 1, reply: false, size: 4, data: new Uint8Array(5) })], 'Execution environment peer sent inconsistent message parts'],
      [[
        frame({ type: 'part', id: 1, reply: false, size: 3000, data: new Uint8Array(minPartBytes()) }),
        frame({ type: 'part', id: 1, reply: false, size: 3001, data: new Uint8Array(minPartBytes()) }),
      ], 'Execution environment peer sent inconsistent message parts'],
      ...[0, minPartBytes() - 1].map((bytes): [Buffer[], string] => [
        [frame({ type: 'part', id: 1, reply: false, size: 3000, data: new Uint8Array(bytes) })],
        `Execution environment peer sent a part of ${bytes} bytes before the last part of its message; such parts carry at least ${minPartBytes()} bytes`,
      ]),
      [parts({ ...message, id: 2 }, 1, false), 'Execution environment peer sent inconsistent message parts'],
      [parts({ type: 'cancel', id: 1, padding: 'x'.repeat(1200) }, 1, false), /Invalid/],
      [[frame({ type: 'part', id: 1, reply: false, size: 100, data: new Uint8Array(100) })], /^Execution environment peer sent an undecodable frame: /],
    ]
    for (const [sent, reason] of cases) {
      const { peer, input } = raw()
      input.write(Buffer.concat(sent))
      expect((await peer.closed).message).toMatch(reason)
    }
    // An answer must not carry a request.
    const { peer, input } = raw()
    void peer.request('x', null).catch(() => {})
    input.write(Buffer.concat(parts({ ...message, id: 1 }, 1, true)))
    expect((await peer.closed).message).toBe('Execution environment peer sent inconsistent message parts')
  })

  it('reports a clean disconnect and a disconnect inside a frame', async () => {
    const clean = raw()
    const pending = clean.peer.request('x', null)
    clean.input.end()
    await expect(pending).rejects.toBeInstanceOf(RpcDisconnectedError)

    const partial = raw()
    partial.input.end(Buffer.from([0, 0]))
    expect((await partial.peer.closed).message).toContain('during a frame')
  })

  it('closes on stream errors, aborts served requests and rejects sends after close', async () => {
    const served = Promise.withResolvers<unknown>()
    const started = Promise.withResolvers<undefined>()
    const { client, server, toServer } = pair(async (_method, _params, signal) => {
      signal.addEventListener('abort', () => { served.resolve(signal.reason) })
      started.resolve(undefined)
      return await new Promise(() => {})
    })
    void client.request('x', null).catch(() => {})
    await started.promise
    toServer.emit('error', new Error('pipe broke'))
    await expect(served.promise).resolves.toEqual(expect.objectContaining({ message: 'pipe broke' }))
    expect((await server.closed).message).toBe('pipe broke')
    server.close(new Error('ignored'))
    expect((await server.closed).message).toBe('pipe broke')
  })

  it('closes when a write fails asynchronously and rejects the request that wrote', async () => {
    const output = new PassThrough({ write: (_chunk, _encoding, callback) => { callback(new Error('write failed')) } })
    output.on('error', () => {}) // The peer also observes the stream error event.
    const peer = new RpcPeer(new PassThrough(), output, limits)
    await expect(peer.request('x', null)).rejects.toThrow('write failed')
    expect(peer.failed).toBe(true)
  })

  it('rejects a write queued behind a write that closes the peer', async () => {
    let fail: ((error: Error) => void) | undefined
    const output = new PassThrough({ write: (_chunk, _encoding, callback) => { fail = callback } })
    output.on('error', () => {}) // The peer also observes the stream error event.
    const peer = new RpcPeer(new PassThrough(), output, limits)
    const first = peer.request('a', null)
    const second = peer.request('b', null)
    await vi.waitFor(() => { expect(fail).toBeDefined() })
    fail!(new Error('write failed'))
    await expect(first).rejects.toThrow('write failed')
    await expect(second).rejects.toThrow('write failed')
  })

  it('keeps a cancelled slot until the other peer settles it, so refills never overrun the server', async () => {
    const ignored = Promise.withResolvers<string>()
    const { client } = pair(async (method, params, signal) => {
      if (method === 'echo') return params
      if (method === 'ignore') return await ignored.promise
      return await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
    })
    const honoured = new AbortController()
    const first = client.request('honour', null, honoured.signal)
    honoured.abort(new Error('stop'))
    await expect(first).rejects.toThrow('stop')
    // The server answers the cancel before this later request, so its reply means the slot was released.
    await expect(client.request('echo', 0)).resolves.toBe(0)
    await expect(Promise.all([client.request('echo', 1), client.request('echo', 2)])).resolves.toEqual([1, 2])

    const ignoring = new AbortController()
    const second = client.request('ignore', null, ignoring.signal)
    ignoring.abort(new Error('stop'))
    await expect(second).rejects.toThrow('stop')
    const [kept, refused] = await Promise.allSettled([client.request('echo', 3), client.request('echo', 4)])
    expect(kept).toEqual({ status: 'fulfilled', value: 3 })
    expect(refused.status).toBe('rejected')
    expect(refused.status === 'rejected' && asError(refused.reason).message).toBe('Execution environment pending request limit reached')
    ignored.resolve('late')
    await expect(client.request('echo', 0)).resolves.toBe(0)
    await expect(Promise.all([client.request('echo', 5), client.request('echo', 6)])).resolves.toEqual([5, 6])
    expect(client.failed).toBe(false)
  })

  it('rejects parameters and results that structured clone cannot copy, without leaking a slot', async () => {
    const { client } = pair(async (_method, params) => params === 'function' ? { callback: () => 1 } : params)
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(client.request('x', { callback: () => 1 }))
        .rejects.toThrow('Execution environment cannot send a value that structured clone does not support: () => 1 could not be cloned.')
    }
    await expect(client.request('x', Symbol('s'))).rejects.toThrow('Symbol(s) could not be cloned.')
    const result = client.request('x', 'function')
    await expect(result).rejects.toBeInstanceOf(RemoteRequestError)
    await expect(result).rejects.toThrow('() => 1 could not be cloned.')
    await expect(Promise.all([client.request('x', 1n), client.request('x', 2n)])).resolves.toEqual([1n, 2n])
    expect(client.failed).toBe(false)
  })

  it('closes the connection when the other peer keeps a cancelled request past the grace period', async () => {
    const { client } = pair(() => new Promise(() => {}), { ...limits, cancelGraceMs: 20 })
    const controller = new AbortController()
    const request = client.request('ignore', null, controller.signal)
    controller.abort(new Error('stop'))
    await expect(request).rejects.toThrow('stop')
    expect((await client.closed).message).toBe('Execution environment peer did not stop a cancelled request within 20 ms')
  })

  it('refuses text chunks from a stream with an encoding', async () => {
    const { peer, input } = raw()
    input.setEncoding('utf8')
    input.write(frame({ type: 'request', id: 1, method: 'echo', params: 'é' }))
    expect((await peer.closed).message).toBe('Execution environment channel delivered text; frames need a byte stream without an encoding')
  })
})
