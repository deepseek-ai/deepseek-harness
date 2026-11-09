import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { PtcImage } from '@deepseek-ai/dsh-ptc-runtime'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

const modes = [
  { executionMode: 'per-call', scriptPersistence: false },
  { executionMode: 'persistent-in-memory', scriptPersistence: false },
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
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['%s %d %j %% text 7 { n: 1 } [ 2, 3 ]'])
    expect(result.value).toBeUndefined()
  })

  it('inspects large binary views with a bounded text preview', async () => {
    const { run } = await setup()
    const result = await run(`
      const { Buffer } = await import('node:buffer');
      inspect(Buffer.alloc(16 * 1024 * 1024), new Uint8Array(16 * 1024 * 1024));
    `)
    expect(result.error).toBeUndefined()
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)).toHaveLength(1)
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)[0]).toContain('<Buffer')
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)[0]).toContain('Uint8Array(')
    expect(result.output.filter(block => block.type === 'text').map(block => block.text)[0]!.length).toBeLessThan(2_000)
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
      { type: 'text', text: 'true sha256:before /images/before.png 8 4 true' },
      { type: 'text', text: 'before { windowId: 23 }' },
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

  it('retains a text prefix when output overflows after an image', async () => {
    const { runtime } = await mountRuntime(new Context(), { ...mode, maxOutputBytes: 256 })
    const image = new PtcImage('/images/selected.png', { attachmentId: AttachmentId('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const result = await runtime.run(runtime.resolve({
      program: 'inspect("before", await tools.image({}), "x".repeat(512))',
      bindings: [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }],
      discardCompletion: true,
    }))
    expect(result.error?.kind).toBe('output-limit')
    expect(result.output[0]).toEqual({ type: 'text', text: 'before' })
    expect(result.output.every(block => block.type === 'text')).toBe(true)
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
    expect(captured.output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['selected'])
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
      'object true', 'log\n', 'info\n', 'warn\n', 'error\n', 'debug\n', '{ native: true }\n', 'after',
    ])
    expect(runtime.executionInstructions).toContain('Use inspect(...values) to display output. Do not use console.')
  })

  it('allows local console declarations and retains a program-owned console', async () => {
    const { runtime, run } = await setup()
    const source = 'const console = { value: 42 }; inspect(console.value)'
    const local = await run(mode.executionMode === 'per-call' ? source : `{ ${source} }`)
    expect(local.error).toBeUndefined()
    expect(local.output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['42'])
    if (runtime.retainsState) {
      expect((await run('var console = { value: 17 }')).error).toBeUndefined()
      expect((await run('inspect(console.value)')).output.filter(block => block.type === 'text').map(block => block.text)).toEqual(['17'])
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
