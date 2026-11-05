import { Duplex, PassThrough } from 'node:stream'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createProcessRpc } from '../src/rpc.ts'
import { rawPeer } from './raw-peer.ts'

function endpoints() {
  const inbound = new PassThrough()
  const outbound = new PassThrough()
  const local = Duplex.from({ readable: inbound, writable: outbound })
  const remote = Duplex.from({ readable: outbound, writable: inbound })
  local.on('error', () => {})
  remote.on('error', () => {})
  onTestFinished(() => { local.destroy(); remote.destroy() })
  return { local, remote }
}

it('matches concurrent bidirectional results and preserves remote rejection messages', async () => {
  const { local, remote } = endpoints()
  const release = Promise.withResolvers<string>()
  const entered = Promise.withResolvers<undefined>()
  const failures = vi.fn()
  const left = createProcessRpc<{ slow(): Promise<string>; fail(): never }, { double(value: number): number }>(local, 4096,
    { double: value => value * 2 }, [], failures)
  const right = createProcessRpc<{ double(value: number): number }, { slow(): Promise<string>; fail(): never }>(remote, 4096, {
    slow: () => { entered.resolve(undefined); return release.promise },
    fail: () => { throw new Error('binding denied') },
  }, [], failures)
  onTestFinished(() => { release.resolve('cleanup'); left.$close(); right.$close() })
  const pending = left.slow()
  await entered.promise
  expect(await right.double(21)).toBe(42)
  await expect(left.fail()).rejects.toThrow('binding denied')
  release.resolve('completed')
  expect(await pending).toBe('completed')
  expect(failures).not.toHaveBeenCalled()
})

it('delivers a non-Error rejection as its text', async () => {
  const thrown: unknown = 'denied'
  const { local, remote } = endpoints()
  const left = createProcessRpc<{ fail(): never }, Record<string, never>>(local, 4096, {}, [], () => {})
  const right = createProcessRpc<Record<string, never>, { fail(): never }>(remote, 4096, { fail: () => { throw thrown } }, [], () => {})
  onTestFinished(() => { left.$close(); right.$close() })
  await expect(left.fail()).rejects.toThrow(String(thrown))
})

it('does not invoke a method received beside traffic that closed the endpoint', async () => {
  const { local, remote } = endpoints()
  const failure = Promise.withResolvers<string>()
  const allowed = vi.fn()
  const endpoint = createProcessRpc(local, 4096, { allowed }, [], (_error, kind) => { failure.resolve(kind) })
  onTestFinished(() => { endpoint.$close() })
  remote.write(`{\n${JSON.stringify({ t: 'q', m: 'allowed', a: [] })}\n`)
  expect(await failure.promise).toBe('protocol')
  await new Promise(resolve => setImmediate(resolve))
  expect(allowed).not.toHaveBeenCalled()
})

it('lets execution own the deadline and rejects outstanding calls when the transport closes', async () => {
  const { local, remote } = endpoints()
  const received = Promise.withResolvers<undefined>()
  const raw = rawPeer(remote, () => { received.resolve(undefined) })
  const endpoint = createProcessRpc<{ wait(): Promise<void> }, Record<string, never>>(local, 4096, {}, [], () => {})
  onTestFinished(() => { endpoint.$close(); raw.close() })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = endpoint.wait()
    const rejected = expect(pending).rejects.toThrow('rpc is closed')
    await received.promise
    const settled = vi.fn()
    void pending.then(settled, settled)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(settled).not.toHaveBeenCalled()
    endpoint.$close()
    await rejected
    await expect(endpoint.wait()).rejects.toThrow('rpc is closed')
  } finally { vi.useRealTimers() }
})

it('sends notifications without allocating response identifiers', async () => {
  const { local, remote } = endpoints()
  const received = Promise.withResolvers<unknown>()
  const raw = rawPeer(remote, (message) => { received.resolve(message) })
  const endpoint = createProcessRpc<{ log(text: string): void }, Record<string, never>>(local, 4096, {}, ['log'], () => {})
  onTestFinished(() => { endpoint.$close(); raw.close() })
  await endpoint.log('visible')
  expect(await received.promise).toEqual({ t: 'q', m: 'log', a: ['visible'] })
})

it('ignores a response for another call and returns the matching result', async () => {
  const { local, remote } = endpoints()
  const endpoint = createProcessRpc<{ value(): string }, Record<string, never>>(local, 4096, {}, [], () => {})
  const raw = rawPeer(remote, (request) => {
    const { i } = request as { i: string }
    void raw.send({ t: 's', i: 'unrelated', r: 'wrong' })
    void raw.send({ t: 's', i, r: 'right' })
  })
  onTestFinished(() => { endpoint.$close(); raw.close() })
  expect(await endpoint.value()).toBe('right')
})

it('answers calls to methods it does not own and ignores unknown messages', async () => {
  const { local, remote } = endpoints()
  const failures = vi.fn()
  const allowed = vi.fn()
  const replies: unknown[] = []
  const answered = Promise.withResolvers<undefined>()
  const endpoint = createProcessRpc(local, 4096, { allowed }, [], failures)
  const raw = rawPeer(remote, (message) => {
    replies.push(message)
    if (replies.length === 2) answered.resolve(undefined)
  })
  onTestFinished(() => { endpoint.$close(); raw.close() })
  for (const message of [{ t: 'unknown' }, { t: 's', i: 'stray', e: 'unstructured' }, { t: 'q', i: 'a', m: 'constructor', a: [] }, { t: 'q', i: 'b', m: 'toString', a: [] }]) {
    await raw.send(message)
  }
  await answered.promise
  expect(replies).toEqual(['constructor', 'toString'].map((name, index) => ({ t: 's', i: 'ab'[index], e: { message: `[birpc] function "${name}" not found` } })))
  expect(allowed).not.toHaveBeenCalled()
  expect(failures).not.toHaveBeenCalled()
  expect(endpoint.$closed).toBe(false)
})

it('reassembles fragmented UTF-8 and consecutive JSON lines', async () => {
  const { local, remote } = endpoints()
  const received: string[] = []
  const complete = Promise.withResolvers<undefined>()
  const endpoint = createProcessRpc(local, 1024, { log(text: string) {
    received.push(text)
    if (received.length === 2) complete.resolve(undefined)
  } }, [], (error) => { complete.reject(error) })
  onTestFinished(() => { endpoint.$close() })
  const bytes = Buffer.from(['你好🙂\ninside', 'next'].map(text => JSON.stringify({ t: 'q', m: 'log', a: [text] }) + '\n').join(''))
  for (const byte of bytes) remote.write(Buffer.from([byte]))
  await complete.promise
  expect(received).toEqual(['你好🙂\ninside', 'next'])
})

it.each([
  [Buffer.from('{\n'), false],
  [Buffer.from('null\n'), false],
  [Buffer.from([0xff, 10]), false],
  [Buffer.from('{'), true],
  [Buffer.from([0xe2]), true],
  [Buffer.from(`{${'x'.repeat(64)}`), false],
  [Buffer.from([0, 0, 0, 2, 123, 125]), false],
])('rejects invalid or oversized JSON lines before dispatch (%j, EOF %s)', async (bytes, eof) => {
  const { local, remote } = endpoints()
  const failed = Promise.withResolvers<string>()
  const endpoint = createProcessRpc(local, 64, {}, [], (_error, kind) => { failed.resolve(kind) })
  onTestFinished(() => { endpoint.$close() })
  if (eof) remote.end(bytes)
  else remote.write(bytes)
  expect(await failed.promise).toBe('protocol')
})

it('bounds the native writable queue and rejects all outstanding calls on overflow', async () => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, _callback) {} })
  const failed = Promise.withResolvers<Error>()
  const endpoint = createProcessRpc<{ invoke(value: string): Promise<string> }, Record<string, never>>(stream, 256, {}, [], (error) => {
    failed.resolve(error)
  })
  onTestFinished(() => { endpoint.$close() })
  const calls = Array.from({ length: 4 }, () => endpoint.invoke('x'.repeat(64)))
  const results = Promise.allSettled(calls)
  expect((await failed.promise).message).toContain('queued bytes')
  expect((await results).every(result => result.status === 'rejected')).toBe(true)
})

it.each(['error', 'close', 'end'] as const)('rejects a pending call and distinguishes transport %s', async (event) => {
  const entered = Promise.withResolvers<undefined>()
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, _callback) { entered.resolve(undefined) } })
  const failed = Promise.withResolvers<string>()
  const endpoint = createProcessRpc<{ wait(): Promise<void> }, Record<string, never>>(stream, 256, {}, [], (_error, kind) => {
    failed.resolve(kind)
  })
  onTestFinished(() => { endpoint.$close() })
  const rejected = expect(endpoint.wait()).rejects.toThrow('closed')
  await entered.promise
  stream.emit(event, new Error('transport failed'))
  expect(await failed.promise).toBe(event === 'error' ? 'io' : 'closed')
  await rejected
})
