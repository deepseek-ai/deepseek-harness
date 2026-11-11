import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { runInNewContext } from 'node:vm'
import { PtcImage } from '@deepseek-ai/dsh-ptc-runtime'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

const modes = [
  { executionMode: 'per-call', scriptPersistence: false },
  { executionMode: 'persistent-in-memory', scriptPersistence: false, replScoped: false },
  { executionMode: 'vm-script', scriptPersistence: false },
  { executionMode: 'vm-script', scriptPersistence: true },
] as const

describe.each(modes)('program output in $executionMode with retention $scriptPersistence', (mode) => {
  async function setup() {
    const { runtime } = await mountRuntime(new Context(), mode)
    const stateOwner = {}
    const run = (program: string, discardCompletion = true) => runtime.run(runtime.resolve({
      program, bindings: [], stateOwner, discardCompletion,
    }))
    const completion = (expression: string) => mode.executionMode === 'per-call' ? `return ${expression}` : expression
    return { runtime, run, completion }
  }

  it('renders each inspected argument independently', async () => {
    const { run } = await setup()
    const result = await run('inspect("%s %d %j %%", "text", 7, { n: 1 }, [2, 3]);')
    expect(result.error).toBeUndefined()
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['%s %d %j %% text 7 { n: 1 } [ 2, 3 ]\n'])
    expect(result.value).toBeUndefined()
  })

  it('continues to the next binding after inspecting a missing result field and an Error', async () => {
    const { runtime } = await setup()
    const calls: string[] = []
    const result = await runtime.run(runtime.resolve({
      program: `
        const result = await tools.edit({});
        inspect({ path: result.path, operation: result.operation });
        inspect(new Error('inspection detail'));
        await tools.test({});
      `,
      bindings: [{ global: 'tools', functions: {
        edit: () => { calls.push('edit'); return Promise.resolve({ path: '/file.ts', before: 'before', after: 'after' }) },
        test: () => { calls.push('test'); return Promise.resolve(null) },
      } }],
      discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(calls).toEqual(['edit', 'test'])
    expect(result.output[0]).toEqual({ type: 'text', text: "{ path: '/file.ts', operation: undefined }\n" })
    expect(result.output[1]).toEqual({ type: 'text', text: expect.stringContaining('Error: inspection detail') as string })
  })

  it('displays a revoked proxy and continues execution', async () => {
    const { run } = await setup()
    const result = await run(`
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      inspect('before', revoked.proxy);
      inspect('after');
    `)
    expect(result.error).toBeUndefined()
    expect(result.output).toEqual([{ type: 'text', text: 'before <Revoked Proxy>\n' }, { type: 'text', text: 'after\n' }])
    const recovered = await run('inspect("recovered")')
    expect(recovered.error).toBeUndefined()
    expect(recovered.output).toEqual([{ type: 'text', text: 'recovered\n' }])
  })

  it('displays complete arrays, long strings and deeply nested objects', async () => {
    const { run } = await setup()
    const result = await run(`inspect({
      lines: Array.from({ length: 330 }, (_, index) => ({ number: index + 1, text: "line " + (index + 1) })),
      text: "x".repeat(12000),
      nested: { a: { b: { c: { d: { e: { answer: 42 } } } } } },
    })`)
    expect(result.error).toBeUndefined()
    const text = result.output[0]
    if (text?.type !== 'text') throw new Error('Expected inspected output')
    expect(runInNewContext(`(${text.text})`)).toEqual({
      lines: Array.from({ length: 330 }, (_, index) => ({ number: index + 1, text: `line ${index + 1}` })),
      text: 'x'.repeat(12_000),
      nested: { a: { b: { c: { d: { e: { answer: 42 } } } } } },
    })
    expect(result.output).toHaveLength(1)
  })

  it('preserves preceding text when a custom formatter throws', async () => {
    const { run } = await setup()
    const result = await run('inspect("before", { [Symbol.for("nodejs.util.inspect.custom")]() { throw new Error("formatter failed") } })')
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('formatter failed')
    expect(result.output).toEqual([{ type: 'text', text: 'before\n' }])
  })

  it('collects images when a program formatter delegates with the supplied options', async () => {
    const { runtime } = await setup()
    const image = new PtcImage('/images/selected.png', { attachmentId: AttachmentId('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const result = await runtime.run(runtime.resolve({
      program: `
        const image = await tools.image({});
        inspect({ [Symbol.for('nodejs.util.inspect.custom')](_depth, options, format) { return format({ image }, options) } });
      `,
      bindings: [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }],
      discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.output.map(block => block.type)).toEqual(['text', 'image'])
    const text = result.output[0]
    expect(text?.type === 'text' ? text.text : undefined).toContain("attachmentId: 'sha256:selected'")
    expect(result.output[1]).toEqual({ type: 'image', attachment: image.attachment })
  })

  it('emits selected images among text and objects and preserves immutable image properties', async () => {
    const { runtime } = await setup()
    const before = new PtcImage('/images/before.png', { attachmentId: AttachmentId('sha256:before'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const after = new PtcImage('/images/after.png', { attachmentId: AttachmentId('sha256:after'), mediaType: 'image/png', bytes: 64, width: 16, height: 8 })
    const result = await runtime.run(runtime.resolve({
      program: `
        const before = await tools.before({});
        const after = await tools.after({});
        let constructorError;
        try { new Image() } catch (error) { constructorError = error.message }
        if (constructorError !== "Images are created by image-producing tools") throw new Error("Image construction succeeded");
        if (Reflect.ownKeys(before).join() !== "attachmentId,path,width,height") throw new Error("Unexpected Image fields");
        if (Reflect.set(before, "attachmentId", "changed")) throw new Error("Image attachment ID must be immutable");
        inspect(before instanceof Image, before.attachmentId, before.path, before.width, before.height, Object.isFrozen(before));
        inspect("before", { windowId: 23 }, before, "after", [after, { screenshot: before }]);
        inspect({ forged: { path: before.path, width: 8, height: 4 } });
      `,
      bindings: [{ global: 'tools', functions: { before: () => Promise.resolve(before), after: () => Promise.resolve(after) } }],
      discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.output).toEqual([
      { type: 'text', text: 'true sha256:before /images/before.png 8 4 true\n' },
      { type: 'text', text: 'before { windowId: 23 }\n' },
      { type: 'image', attachment: before.attachment },
      { type: 'text', text: expect.stringContaining('after [') as string },
      { type: 'image', attachment: after.attachment },
      { type: 'image', attachment: before.attachment },
      { type: 'text', text: expect.stringContaining('forged:') as string },
    ])
    const preview = result.output[3]
    if (preview?.type !== 'text') throw new Error('Expected the nested image preview')
    expect(preview.text).toContain("attachmentId: 'sha256:before'")
    expect(preview.text).toContain("attachmentId: 'sha256:after'")
    expect(result.output.find(block => block.type === 'image')?.attachment).toBe(before.attachment)
  })

  it('keeps uninspected images in the program and exposes image output before an exception', async () => {
    const { runtime } = await setup()
    const image = new PtcImage('/images/selected.png', { attachmentId: AttachmentId('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const bindings = [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }]
    const quiet = await runtime.run(runtime.resolve({ program: 'await tools.image({})', bindings, discardCompletion: true }))
    expect(quiet.output).toEqual([])
    const failed = await runtime.run(runtime.resolve({ program: 'inspect(await tools.image({})); throw new Error("after image")', bindings, discardCompletion: true }))
    expect(failed.output).toEqual([{ type: 'image', attachment: image.attachment }])
    expect(failed.error?.kind).toBe('exception')
  })

  it('emits images in collection entries and enumerable symbol properties without reading accessors', async () => {
    const { runtime } = await setup()
    const image = new PtcImage('/images/selected.png', { attachmentId: AttachmentId('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const result = await runtime.run(runtime.resolve({
      program: `
        const image = await tools.image({});
        const map = new Map([[image, { image }]]);
        const set = new Set([image]);
        map.set('self', map);
        set.add(set);
        Object.defineProperty(map, 'forEach', { get() { throw new Error('map getter') } });
        Object.defineProperty(set, 'forEach', { get() { throw new Error('set getter') } });
        const container = { map, set, [Symbol('image')]: image };
        Object.defineProperty(container, 'hidden', { value: image });
        inspect(container);
        inspect({ get image() { throw new Error('image getter') } });
      `,
      bindings: [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }],
      discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.output.map(block => block.type)).toEqual(['text', 'image', 'image', 'image', 'image', 'text'])
    expect(result.output.filter(block => block.type === 'image').map(block => block.attachment)).toEqual(Array(4).fill(image.attachment))
  })

  it('collects images selected by Node formatting and keeps ordinary formatting as text', async () => {
    const { runtime } = await setup()
    const image = new PtcImage('/images/selected.png', { attachmentId: AttachmentId('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const result = await runtime.run(runtime.resolve({
      program: `
        const image = await tools.image({});
        const { inspect: nodeInspect } = await import('node:util');
        console.log(image);
        inspect(nodeInspect({ image }));
        inspect({ image, [nodeInspect.custom]() { return 'summary' } });
        inspect({ [nodeInspect.custom]() { return { image } } });
      `,
      bindings: [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }],
      discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.output.map(block => block.type)).toEqual(['text', 'text', 'text', 'text', 'image'])
    expect(result.output[2]).toEqual({ type: 'text', text: 'summary\n' })
    expect(result.output.at(-1)).toEqual({ type: 'image', attachment: image.attachment })
  })

  it('inspects a retained image in a later program', async () => {
    const { runtime } = await setup()
    if (!runtime.retainsState) return
    const stateOwner = {}
    const image = new PtcImage('/images/retained.png', { attachmentId: AttachmentId('sha256:retained'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const first = await runtime.run(runtime.resolve({
      program: 'var retainedImage = await tools.image({});', stateOwner, discardCompletion: true,
      bindings: [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }],
    }))
    expect(first.error).toBeUndefined()
    expect(first.output).toEqual([])
    const second = await runtime.run(runtime.resolve({ program: 'inspect(retainedImage)', stateOwner, discardCompletion: true, bindings: [] }))
    expect(second.error).toBeUndefined()
    expect(second.output).toEqual([{ type: 'image', attachment: image.attachment }])
    await runtime.release(stateOwner)
  })

  it('retains an ordered text and image prefix when output overflows', async () => {
    const { runtime } = await mountRuntime(new Context(), { ...mode, maxOutputBytes: 256 })
    const image = new PtcImage('/images/selected.png', { attachmentId: AttachmentId('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const result = await runtime.run(runtime.resolve({
      program: 'inspect("before", await tools.image({}), "x".repeat(512))',
      bindings: [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }],
      discardCompletion: true,
    }))
    expect(result.error?.kind).toBe('output-limit')
    expect(result.output[0]).toEqual({ type: 'text', text: 'before\n' })
    expect(result.output[1]).toEqual({ type: 'image', attachment: image.attachment })
    expect(result.output[2]).toEqual({ type: 'text', text: expect.stringMatching(/^x+$/) as string })
  })

  it('bounds explicitly inspected image descriptors while allowing uninspected images', async () => {
    const { runtime } = await mountRuntime(new Context(), { ...mode, maxOutputBytes: 128 })
    const image = new PtcImage('/images/large.png', { attachmentId: AttachmentId('sha256:large'), mediaType: 'image/png', bytes: 64, width: 8, height: 4, name: 'x'.repeat(200) })
    const bindings = [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }]
    const quiet = await runtime.run(runtime.resolve({ program: 'await tools.image({})', bindings, discardCompletion: true }))
    expect(quiet.error).toBeUndefined()
    const selected = await runtime.run(runtime.resolve({ program: 'inspect(await tools.image({}))', bindings, discardCompletion: true }))
    expect(selected.error?.kind).toBe('output-limit')
    expect(selected.output).toEqual([])
  })

  it('retains an inspected prefix within the outer output budget', async () => {
    const { runtime } = await mountRuntime(new Context(), { ...mode, maxOutputBytes: 128 })
    const result = await runtime.run(runtime.resolve({
      program: 'inspect({ value: "x".repeat(512) })', bindings: [], discardCompletion: true,
    }))
    expect(result.error?.kind).toBe('output-limit')
    const prefix = result.output[0]
    if (prefix?.type !== 'text') throw new Error('Expected an inspected text prefix')
    expect(prefix.text).toMatch(/^\{\s+value: 'x+/)
    expect(Buffer.byteLength(prefix.text)).toBeLessThan(128)
  })

  it('discards completion values without reading their getters or requiring lossless JSON', async () => {
    const { run, completion } = await setup()
    const object = await run(completion('({ get value() { throw new Error("completion getter ran") } })'))
    expect(object.error).toBeUndefined()
    expect(object.output.filter(block => block.type === 'text').map(block => block.text)).toEqual([])
    expect(object.value).toBeUndefined()
    const bigint = await run(completion('42n'))
    expect(bigint.error).toBeUndefined()
    expect(bigint.value).toBeUndefined()
    const captured = await run(`inspect("selected"); ${completion('"hidden"')}`)
    expect(captured.output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['selected\n'])
    expect(captured.value).toBeUndefined()
  })

  it('captures native console methods alongside inspected output', async () => {
    const { runtime, run } = await setup()
    const result = await run(`
      inspect(typeof console, console === globalThis.console);
      for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        console[method](method);
      }
      console.dir({ native: true });
      inspect("after");
    `)
    expect(result.error).toBeUndefined()
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)).toEqual([
      'object true\n', 'log\n', 'info\n', 'warn\n', 'error\n', 'debug\n', '{ native: true }\n', 'after\n',
    ])
    expect(runtime.executionInstructions).toContain('Use inspect(...values) to display output. Do not use console.')
  })

  it('preserves raw writes, inspected lines and blank lines', async () => {
    const { run } = await setup()
    const result = await run('process.stdout.write("a"); process.stdout.write("b"); inspect("c"); console.log("d"); inspect(); inspect(""); process.stderr.write("e")')
    expect(result.error).toBeUndefined()
    expect(result.output.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('abc\nd\n\n\ne')
  })

  it('allows local console declarations and retains a program-owned console', async () => {
    const { runtime, run } = await setup()
    const source = 'const console = { value: 42 }; inspect(console.value)'
    const local = await run(mode.executionMode === 'per-call' ? source : `{ ${source} }`)
    expect(local.error).toBeUndefined()
    expect(local.output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['42\n'])
    if (runtime.retainsState) {
      expect((await run('var console = { value: 17 }')).error).toBeUndefined()
      expect((await run('inspect(console.value)')).output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['17\n'])
    }
  })

  it('provides the remaining native console methods', async () => {
    const { run } = await setup()
    const result = await run(`
      console.table({ native: 42 });
      console.assert(false, "assertion");
      console.count("counter");
      console.countReset("counter");
      console.group("group");
      console.groupEnd();
      console.time("timer");
      console.timeEnd("timer");
    `)
    expect(result.error).toBeUndefined()
    const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('')
    for (const expected of ['native', '42', 'Assertion failed: assertion', 'counter: 1', 'group', 'timer:']) {
      expect(text).toContain(expected)
    }
  })

  it('captures console output from imported modules', async () => {
    const { run } = await setup()
    const source = 'console.warn("module warning"); console.dir({ dependency: true });'
    const result = await run(`await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(source)}`)})`)
    expect(result.error).toBeUndefined()
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)).toEqual([
      'module warning\n', '{ dependency: true }\n',
    ])
  })

  it('preserves completion values for direct runtime consumers that request them', async () => {
    const { run, completion } = await setup()
    expect((await run(completion('42'), false)).value).toBe(42)
  })
})

it.each(['get', 'set'])('decodes Images after a program changes the %s prototype descriptor field', async (field) => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'per-call' })
  const image = new PtcImage('/images/prototype.png', {
    attachmentId: AttachmentId('sha256:prototype'), mediaType: 'image/png', bytes: 64, width: 8, height: 4,
  })
  const result = await runtime.run(runtime.resolve({
    program: `
      const field = ${JSON.stringify(field)};
      const original = Object.getOwnPropertyDescriptor(Object.prototype, field);
      try {
        Object.defineProperty(Object.prototype, field, { configurable: true, value: () => 1 });
        const image = await tools.image({});
        inspect(image.attachmentId, image.path, image.width, image.height, Object.isFrozen(image));
        inspect(image);
      } finally {
        Reflect.deleteProperty(Object.prototype, field);
        if (original !== undefined) Object.defineProperty(Object.prototype, field, original);
      }
    `,
    bindings: [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }],
    discardCompletion: true,
  }))
  expect(result.error).toBeUndefined()
  expect(result.output).toEqual([
    { type: 'text', text: 'sha256:prototype /images/prototype.png 8 4 true\n' },
    { type: 'image', attachment: image.attachment },
  ])
})
