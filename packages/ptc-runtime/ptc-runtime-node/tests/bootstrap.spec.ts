import { runInNewContext } from 'node:vm'
import { inspect as nodeInspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { LogBuffer, makeBindingErrorClass, makeInspect, makeNamespaces, captureStreamWrites, prepareCompletion, prepareException } from '../src/bootstrap.ts'
import type { BindingErrorConstructor, ImageInspectOptions, PatchableStream } from '../src/bootstrap.ts'
import type { HostMethods } from '../src/protocol.ts'
import { encodePtcJsonWire } from '../src/json-wire.ts'

function host(): Pick<HostMethods, 'invoke'> {
  return { invoke: vi.fn<HostMethods['invoke']>(async () => encodePtcJsonWire(42)) }
}
const TOOL_ERROR_CLASS = { name: 'ToolCallError', memberNameProperty: 'toolName' } as const
function toolNamespace(names: string[]) { return { global: 'tools', names, errorClass: TOOL_ERROR_CLASS } }

function inspectedImage(collectImage: ReturnType<typeof makeInspect>['collectImage'], path: string, width = 8, height = 4) {
  const image = { path, width, height }
  Object.defineProperty(image, nodeInspect.custom, {
    value(this: object, _depth: number | null, options: ImageInspectOptions): object {
      collectImage(this, options)
      return this
    },
  })
  return Object.freeze(image)
}

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

describe('makeInspect', () => {
  it('includes its emitted newline in output accounting', () => {
    const text: string[] = []
    const limit = vi.fn()
    makeInspect(new LogBuffer(7, value => text.push(value), limit), new WeakMap(), () => {}).inspect('12')
    expect(text).toEqual(['12'])
    expect(limit).toHaveBeenCalledOnce()
    const exact: string[] = []
    makeInspect(new LogBuffer(8, value => exact.push(value), limit), new WeakMap(), () => {}).inspect('12')
    expect(exact).toEqual(['12\n'])
    expect(limit).toHaveBeenCalledOnce()
  })

  it('renders inspected arguments into captured output', () => {
    const seen: string[] = []
    const { inspect } = makeInspect(new LogBuffer(1_000, text => seen.push(text)), new WeakMap(), () => {})
    inspect('plain', { a: 1 })
    expect(seen).toEqual(['plain { a: 1 }\n'])
  })

  it.each([
    ['Buffer', Buffer.from([1, 2, 3]), '<Buffer 01 02 03>'],
    ['TypedArray', new Uint8Array([1, 2, 3]), 'Uint8Array(3) [ 1, 2, 3 ]'],
    ['function', () => 1, '[Function'],
    ['Error', new Error('inspection failure'), 'Error: inspection failure'],
    ['bigint', 1n, '1n'],
    ['non-finite number', Infinity, 'Infinity'],
    ['negative zero', -0, '-0'],
    ['undefined property', { value: undefined }, '{ value: undefined }'],
  ])('displays a %s argument and continues execution', (_name, value, expected) => {
    const text: string[] = []
    const { inspect } = makeInspect({ push: line => text.push(line) }, new WeakMap(), () => {})
    inspect('before', value, 'after')
    expect(text).toHaveLength(1)
    expect(text[0]).toContain(expected)
    expect(text[0]).toMatch(/^before .* after\n$/s)
  })

  it('displays revoked proxies and accessors without invoking them', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const text: string[] = []
    const { inspect } = makeInspect({ push: line => text.push(line) }, new WeakMap(), () => {})
    inspect(revoked.proxy, { get value() { throw new Error('getter') } })
    expect(text).toEqual(['<Revoked Proxy> { value: [Getter] }\n'])
  })

  it('renders complete arrays, long strings and deeply nested objects', () => {
    const value = {
      lines: Array.from({ length: 330 }, (_, index) => ({ number: index + 1, text: `line ${index + 1}` })),
      text: 'x'.repeat(12_000),
      nested: { a: { b: { c: { d: { e: { answer: 42 } } } } } },
    }
    const text: string[] = []
    makeInspect(new LogBuffer(100_000, line => text.push(line)), new WeakMap(), () => {}).inspect(value)
    expect(text).toHaveLength(1)
    expect(runInNewContext(`(${text[0]!})`)).toEqual(value)
  })

  it('preserves preceding arguments when a custom formatter throws', () => {
    const value = { [Symbol.for('nodejs.util.inspect.custom')]() { throw new Error('formatter failed') } }
    const text: string[] = []
    const { inspect } = makeInspect(new LogBuffer(1_000, line => text.push(line)), new WeakMap(), () => {})
    expect(() => { inspect('before', value, 'after') }).toThrow('formatter failed')
    expect(text).toEqual(['before\n'])
  })

  it('emits registered images in argument order from arrays and objects', () => {
    const images = new WeakMap<object, string>()
    const text: string[] = []
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push: line => text.push(line) }, images, id => selected.push(id))
    const one = inspectedImage(collectImage, '/one.png')
    const two = inspectedImage(collectImage, '/two.png', 4, 8)
    images.set(one, 'one').set(two, 'two')
    const value = { first: [one, { second: two }] }
    inspect('before', value, 'after', one)
    expect(selected).toEqual(['one', 'two', 'one'])
    expect(runInNewContext(`(${text[0]!.slice('before '.length)})`)).toEqual(value)
    expect(text[1]).toBe('after\n')
    inspect({ path: '/fake.png', width: 1, height: 1 }, null)
    inspect()
    expect(selected).toEqual(['one', 'two', 'one'])
    expect(text.slice(2)).toEqual(["{ path: '/fake.png', width: 1, height: 1 } null\n", '\n'])
  })

  it('does not select images behind getters', () => {
    const images = new WeakMap<object, string>()
    const text: string[] = []
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push: line => text.push(line) }, images, id => selected.push(id))
    const image = inspectedImage(collectImage, '/image.png')
    images.set(image, 'image')
    const read = vi.fn(() => image)
    inspect({ get image() { return read() } })
    expect(read).not.toHaveBeenCalled()
    expect(text).toEqual(['{ image: [Getter] }\n'])
    expect(selected).toEqual([])
  })

  it('does not select images hidden by a custom formatter', () => {
    const images = new WeakMap<object, string>()
    const text: string[] = []
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push: line => text.push(line) }, images, id => selected.push(id))
    const image = inspectedImage(collectImage, '/image.png')
    images.set(image, 'image')
    inspect({
      image,
      [nodeInspect.custom]() { return 'summary' },
    })
    expect(text).toEqual(['summary\n'])
    expect(selected).toEqual([])
  })

  it('selects registered images returned by a custom formatter', () => {
    const images = new WeakMap<object, string>()
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push() {} }, images, id => selected.push(id))
    const image = inspectedImage(collectImage, '/image.png')
    images.set(image, 'image')
    inspect({ [nodeInspect.custom]() { return { image } } })
    inspect({ image: inspectedImage(collectImage, '/forged.png') })
    expect(selected).toEqual(['image'])
  })

  it('keeps collectors separate across reentrant inspection calls', () => {
    const images = new WeakMap<object, string>()
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push() {} }, images, id => selected.push(id))
    const one = inspectedImage(collectImage, '/one.png')
    const two = inspectedImage(collectImage, '/two.png')
    images.set(one, 'one').set(two, 'two')
    inspect({
      [nodeInspect.custom](_depth: number | null, options: ImageInspectOptions) {
        nodeInspect({ image: one }, options)
        inspect({ image: two })
        return nodeInspect({ image: one }, options)
      },
    })
    expect(selected).toEqual(['two', 'one', 'one'])
  })

  it('discards collected images when their containing value fails to format', () => {
    const images = new WeakMap<object, string>()
    const text: string[] = []
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push: line => text.push(line) }, images, id => selected.push(id))
    const image = inspectedImage(collectImage, '/image.png')
    images.set(image, 'image')
    expect(() => {
      inspect('before', {
        image,
        bad: { [nodeInspect.custom]() { throw new Error('formatter failed') } },
      })
    }).toThrow('formatter failed')
    expect(text).toEqual(['before\n'])
    expect(selected).toEqual([])
    inspect({ image })
    expect(selected).toEqual(['image'])
  })

  it('selects images from Map entries, Set values and enumerable symbol properties', () => {
    const images = new WeakMap<object, string>()
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push() {} }, images, id => selected.push(id))
    const one = inspectedImage(collectImage, '/one.png')
    const two = inspectedImage(collectImage, '/two.png', 4, 8)
    images.set(one, 'one').set(two, 'two')
    const value = {
      map: new Map([[one, two]]),
      set: new Set([two, one]),
      [Symbol('image')]: one,
    }
    Object.defineProperty(value, 'hidden', { value: two })
    inspect(value)
    expect(selected).toEqual(['one', 'two', 'two', 'one', 'one'])
  })

  it('reads Map and Set entries without consulting overridden methods', () => {
    const images = new WeakMap<object, string>()
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push() {} }, images, id => selected.push(id))
    const image = inspectedImage(collectImage, '/image.png')
    images.set(image, 'image')
    const map = new Map([['image', image]])
    const set = new Set([image])
    Object.defineProperty(map, 'forEach', { get() { throw new Error('map getter') } })
    Object.defineProperty(set, 'forEach', { get() { throw new Error('set getter') } })
    inspect(map, set)
    expect(selected).toEqual(['image', 'image'])
  })

  it('finds images in cyclic containers alongside binary views', () => {
    const images = new WeakMap<object, string>()
    const selected: string[] = []
    const { inspect, collectImage } = makeInspect({ push() {} }, images, id => selected.push(id))
    const image = inspectedImage(collectImage, '/image.png')
    images.set(image, 'image')
    const value: Record<string, unknown> = { binary: new Uint8Array([1, 2, 3]), image }
    value.self = value
    inspect(value)
    expect(selected).toEqual(['image'])
  })

  it('displays undefined arguments and cycles', () => {
    const text: string[] = []
    const { inspect } = makeInspect({ push: line => text.push(line) }, new WeakMap(), () => {})
    inspect(undefined)
    expect(text).toEqual(['undefined\n'])
    inspect(null)
    expect(text).toEqual(['undefined\n', 'null\n'])
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    inspect(cyclic)
    expect(text.at(-1)).toBe('<ref *1> { self: [Circular *1] }\n')
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
  it.each([
    ['const error = new Error("foreign"); error.stack = "foreign stack"; error', 'foreign stack'],
    ['const error = new Error("bare"); error.stack = undefined; error', 'bare'],
    ['const error = new Error("hidden"); Object.defineProperty(error, "stack", { get() { throw 1 } }); error', 'program threw an unrenderable value'],
  ])('formats a cross-realm error through the shared diagnostic path: %s', (source, message) => {
    const error: unknown = runInNewContext(source)
    expect(prepareException(error, 1_000)).toEqual({ error: { kind: 'exception', message } })
  })

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
    const [tools] = makeNamespaces({ namespaces: [{ global: 'tools', names: ['bad', '__proto__', 'constructor', 'toString'] }] }, remote, new Map<string, BindingErrorConstructor>()) as [Record<string, (args: unknown) => Promise<unknown>>]
    expect(Object.getPrototypeOf(tools)).toBeNull()
    for (const name of ['__proto__', 'constructor', 'toString']) await expect(tools[name]?.({})).resolves.toBe(`${name}-ok`)
    await expect(tools.bad?.({})).rejects.toThrow('binding resolution must be lossless JSON')
  })

  it('uses the declared constructor for remote and argument failures', async () => {
    const remote = host()
    const data = { namespaces: [toolNamespace(['x'])] }
    const classes = new Map([['tools', makeBindingErrorClass(TOOL_ERROR_CLASS)]])
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
    const [helpers] = makeNamespaces({ namespaces: [{ global: 'helpers', names: ['x'] }] }, remote, new Map<string, BindingErrorConstructor>()) as [Record<string, (args: unknown) => Promise<unknown>>]
    await expect(helpers.x?.({})).rejects.toMatchObject({ name: 'Error', message: 'helper denied' })
    await expect(helpers.x?.(() => 1)).rejects.toThrow('binding arguments must be lossless JSON')
  })
})
