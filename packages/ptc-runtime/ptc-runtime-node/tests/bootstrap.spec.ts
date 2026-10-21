import { describe, expect, it, vi } from 'vitest'
import { LogBuffer, makeBindingErrorClasses, makeConsoleShim, makeNamespaces, captureStreamWrites, prepareCompletion, prepareException, runProgram } from '../src/bootstrap.ts'
import type { PatchableStream } from '../src/bootstrap.ts'
import type { HostMethods } from '../src/protocol.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from '../src/json-wire.ts'

function host(): Omit<HostMethods, 'ready'> & { logs: string[]; limits: number } {
  const calls = {
    logs: [] as string[], limits: 0,
    invoke: vi.fn<HostMethods['invoke']>(async () => encodePtcJsonWire(42)),
    log: (text: string) => { calls.logs.push(text) },
    outputLimit: () => { calls.limits += 1 },
  }
  return calls
}
function fakeStreams(): { stdout: PatchableStream; stderr: PatchableStream } {
  return { stdout: { write: () => true }, stderr: { write: () => true } }
}
const BOOT = { maxOutputBytes: 65_536 }
const TOOL_ERROR_CLASS = { name: 'ToolCallError', memberNameProperty: 'toolName' } as const
function toolNamespace(names: string[]) { return { global: 'tools', names, errorClass: TOOL_ERROR_CLASS } }

describe('LogBuffer', () => {
  it('streams entries to the sink until the byte budget, then emits one fitting prefix and reports the limit once', () => {
    const seen: string[] = []
    let limits = 0
    const buffer = new LogBuffer(15, text => seen.push(text), () => { limits += 1 })
    buffer.push('12345')
    buffer.push('123456')
    buffer.push('dropped')
    expect(seen).toEqual(['12345', '123'])
    expect(limits).toBe(1)
    expect(buffer.remainingOutputBytes()).toBe(0)

    const exactlyFull: string[] = []
    const fullBuffer = new LogBuffer(6, text => exactlyFull.push(text))
    fullBuffer.push('12')
    fullBuffer.push('no-prefix-fits')
    expect(exactlyFull).toEqual(['12'])
  })
})

describe('makeConsoleShim', () => {
  it('captures the five methods and renders non-strings inspect-style', () => {
    const seen: string[] = []
    const shim = makeConsoleShim(new LogBuffer(1_000, text => seen.push(text)))
    shim.log('plain', { a: 1 })
    shim.info('i')
    shim.warn('w')
    shim.error('e')
    shim.debug('d')
    expect(seen).toEqual(['plain { a: 1 }', 'i', 'w', 'e', 'd'])
  })
})

describe('captureStreamWrites', () => {
  it('redirects writes into the buffer and restores on request', () => {
    const seen: string[] = []
    const buffer = new LogBuffer(1_000, text => seen.push(text))
    let underlying = ''
    const stream: PatchableStream = { write: (chunk: unknown) => { underlying += String(chunk); return true } }
    const restore = captureStreamWrites(buffer, stream)
    stream.write('captured', 'utf8')
    stream.write(Buffer.from('bytes'))
    restore()
    stream.write('after')
    expect(seen).toEqual(['captured', 'bytes'])
    expect(underlying).toBe('after')
  })

  it('invokes the write callback asynchronously, in both optional-encoding shapes', async () => {
    const buffer = new LogBuffer(1_000, () => {})
    const stream: PatchableStream = { write: () => true }
    captureStreamWrites(buffer, stream)
    const calls: (Error | null | undefined)[] = []
    stream.write('two-arg', (error?: Error | null) => calls.push(error))
    stream.write('three-arg', 'utf8', (error?: Error | null) => calls.push(error))
    // Node's contract: the callback fires after the write call returns.
    expect(calls).toEqual([])
    await new Promise<void>(resolve => stream.write('awaited flush', resolve))
    expect(calls).toEqual([null, null])
  })

  it('still fires the callback for a write the exhausted budget drops', async () => {
    const buffer = new LogBuffer(4, () => {})
    const stream: PatchableStream = { write: () => true }
    captureStreamWrites(buffer, stream)
    stream.write('this write overflows the budget and is dropped')
    await new Promise<void>(resolve => stream.write('also dropped', resolve))
  })
})

describe('prepareCompletion', () => {
  it('omits undefined and passes lossless JSON values exactly', () => {
    expect(prepareCompletion(undefined, 100)).toEqual({})
    expect(prepareCompletion({ a: [1, 'two'] }, 100)).toEqual({ value: encodePtcJsonWire({ a: [1, 'two'] }) })
  })

  it('turns every lossy completion shape into invalid-output', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = Array(2)
    class Exotic { readonly marker = true }
    for (const value of [{ fn: () => 1 }, -0, Number.POSITIVE_INFINITY, sparse, cyclic, new Exotic()]) {
      expect(prepareCompletion(value, 1_000)).toEqual({
        error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
      })
    }
  })

  it('reports an oversized value instead of substituting rendered text', () => {
    expect(prepareCompletion('x'.repeat(50), 10)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 10 bytes' },
    })
  })

  it('measures the exact JSON serialization at and over the boundary', () => {
    expect(prepareCompletion('€', 5)).toEqual({ value: encodePtcJsonWire('€') })
    expect(prepareCompletion('€', 4)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 4 bytes' },
    })
  })

  it('contains a getter failure as invalid-output', () => {
    const value = Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('getter exploded') } })
    expect(prepareCompletion(value, 1_000)).toEqual({
      error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' },
    })
  })

  it('uses the remaining combined budget for invalid-output diagnostics', () => {
    expect(prepareCompletion(() => 1, 4, 64)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' },
    })
  })
})

describe('prepareException', () => {
  it('passes a fitting diagnostic and rejects one byte over without carrying its text', () => {
    expect(prepareException('boom', 6, 64)).toEqual({ error: { kind: 'exception', message: 'boom' } })
    expect(prepareException('boom', 5, 64)).toEqual({
      error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' },
    })
  })

  it('contains a thrown value whose string conversion fails', () => {
    const thrown = { toString() { throw new Error('cannot render') } }
    expect(prepareException(thrown, 1_000)).toEqual({
      error: { kind: 'exception', message: 'program threw an unrenderable value' },
    })

    const strangeStack = Object.defineProperty(new Error('ignored'), 'stack', { value: 42 })
    expect(prepareException(strangeStack, 1_000)).toEqual({
      error: { kind: 'exception', message: '42' },
    })
  })
})

describe('makeNamespaces', () => {
  it('rejects malformed remote results and keeps prototype-colliding function names callable', async () => {
    const remote = host()
    remote.invoke = vi.fn(async (_global, name) => name === 'bad' ? [undefined] as never : encodePtcJsonWire(`${name}-ok`))
    const [tools] = makeNamespaces({ namespaces: [{ global: 'tools', names: ['bad', '__proto__', 'constructor', 'toString'] }] }, remote) as [Record<string, (args: unknown) => Promise<unknown>>]
    expect(Object.getPrototypeOf(tools)).toBeNull()
    for (const name of ['__proto__', 'constructor', 'toString']) await expect(tools[name]?.({})).resolves.toBe(`${name}-ok`)
    await expect(tools.bad?.({})).rejects.toThrow('binding resolution must be lossless JSON')
  })

  it('uses the declared constructor for remote and argument failures', async () => {
    const remote = host()
    const data = { namespaces: [toolNamespace(['x'])] }
    const classes = makeBindingErrorClasses(data)
    const [tools] = makeNamespaces(data, remote, classes) as [Record<string, (args: unknown) => Promise<unknown>>]
    const decorated = [1]
    Object.defineProperty(decorated, 'extra', { value: true })
    const throwing = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('getter failed') } })
    for (const value of [() => 1, new Date(), decorated, throwing]) {
      await expect(tools.x?.(value)).rejects.toMatchObject({ name: 'ToolCallError', toolName: 'x', message: 'binding arguments must be lossless JSON' })
    }
    expect(vi.mocked(remote.invoke).mock.calls).toEqual([])
    for (const failure of [new Error('denied'), 'raw failure']) {
      remote.invoke = async () => { throw failure }
      const result = tools.x?.({})
      await expect(result).rejects.toBeInstanceOf(classes.get('tools'))
      await expect(result).rejects.toMatchObject({ name: 'ToolCallError', toolName: 'x', message: failure instanceof Error ? failure.message : failure })
    }
  })

  it('uses ordinary Error when the namespace declares no rejection class', async () => {
    const remote = host()
    remote.invoke = async () => { throw new Error('helper denied') }
    const [helpers] = makeNamespaces({ namespaces: [{ global: 'helpers', names: ['x'] }] }, remote) as [Record<string, (args: unknown) => Promise<unknown>>]
    await expect(helpers.x?.({})).rejects.toMatchObject({ name: 'Error', message: 'helper denied' })
    await expect(helpers.x?.(() => 1)).rejects.toThrow('binding arguments must be lossless JSON')
  })
})

describe('runProgram', () => {
  it('returns the completion after streaming logs and invoking host functions', async () => {
    const remote = host()
    remote.invoke = async (_global, _name, wire) => {
      const args = decodePtcJsonWire(wire) as { n: number }
      return encodePtcJsonWire(args.n * 2)
    }
    const result = await runProgram(remote, { ...BOOT, code: 'const doubled = await tools.double({ n: 21 }); console.log("got", doubled); return { doubled };', namespaces: [{ global: 'tools', names: ['double'] }] }, fakeStreams())
    expect(remote.logs).toEqual(['got 42'])
    expect(decodePtcJsonWire(result.value)).toEqual({ doubled: 42 })
  })

  it('reports captured output overflow before completing', async () => {
    const remote = host()
    const result = await runProgram(remote, { maxOutputBytes: 4, code: 'console.log("12345"); return null', namespaces: [] }, fakeStreams())
    expect(remote.logs).toEqual([])
    expect(remote.limits).toBe(1)
    expect(result).toEqual({ error: { kind: 'output-limit', message: 'outer output exceeded 4 bytes' } })
  })

  it.each([
    ['throw new Error("boom")', 'boom'],
    ['throw "raw-throw"', 'raw-throw'],
    ['const e = new Error("bare"); e.stack = undefined; throw e', 'bare'],
  ])('returns bounded program exceptions for %s', async (code, message) => {
    const result = await runProgram(host(), { ...BOOT, code, namespaces: [] }, fakeStreams())
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain(message)
    expect(result.value).toBeUndefined()
  })

  it.each(['throw "x".repeat(1_000_000)', 'throw new Error("x".repeat(1_000_000))'])('bounds large diagnostics for %s', async (code) => {
    expect(await runProgram(host(), { maxOutputBytes: 64, code, namespaces: [] }, fakeStreams())).toEqual({ error: { kind: 'output-limit', message: 'outer output exceeded 64 bytes' } })
  })

  it.each([
    ['tools', 'ToolCallError', 'toolName'],
    ['helpers', 'HelperCallError', 'helperName'],
  ])('injects the declared rejection class for %s', async (global, name, memberNameProperty) => {
    const remote = host()
    remote.invoke = async () => { throw new Error('denied by host') }
    const result = await runProgram(remote, {
      ...BOOT,
      code: `try { await ${global}.x({}) } catch (error) { return { caught: error instanceof ${name}, name: error.name, member: error.${memberNameProperty}, message: error.message } }`,
      namespaces: [{ global, names: ['x'], errorClass: { name, memberNameProperty } }],
    }, fakeStreams())
    expect(decodePtcJsonWire(result.value)).toEqual({ caught: true, name, member: 'x', message: 'denied by host' })
  })

  it('leaves the owned output streams connected to their capture sink', async () => {
    const remote = host()
    const streams = fakeStreams()
    await runProgram(remote, { ...BOOT, code: 'return 1', namespaces: [] }, streams)
    streams.stdout.write('captured')
    expect(remote.logs).toEqual(['captured'])
  })
})
