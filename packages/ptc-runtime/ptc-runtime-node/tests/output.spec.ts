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
  async function setup(enableConsole = false) {
    const { runtime } = await mountRuntime(new Context(), enableConsole ? { ...mode, enableConsole: true } : mode)
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
    expect(result.logs).toEqual(['%s %d %j %% text 7 { n: 1 } [ 2, 3 ]'])
    expect(result.value).toBeUndefined()
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
        if (Reflect.ownKeys(before).join() !== "path,width,height") throw new Error("Unexpected Image fields");
        inspect(before instanceof Image, before.path, before.width, before.height, Object.isFrozen(before));
        inspect("before", { windowId: 23 }, before, "after", [after, { screenshot: before }]);
        inspect({ forged: { path: before.path, width: 8, height: 4 } });
      `,
      bindings: [{ global: 'tools', functions: { before: () => Promise.resolve(before), after: () => Promise.resolve(after) } }],
      discardCompletion: true,
    }))
    expect(result.error).toBeUndefined()
    expect(result.logs[0]).toBe('true /images/before.png 8 4 true')
    expect(result.logs[1]).toBe('before { windowId: 23 }')
    expect(result.logs[2]).toContain('after [')
    expect(result.images).toEqual([
      { afterLog: 2, attachment: before.attachment },
      { afterLog: 3, attachment: after.attachment },
      { afterLog: 3, attachment: before.attachment },
    ])
    expect(result.images?.[0]?.attachment).toBe(before.attachment)
    expect(result.images?.[1]?.attachment).toBe(after.attachment)
  })

  it('keeps uninspected images in the program and exposes image output before an exception', async () => {
    const { runtime } = await setup()
    const image = new PtcImage('/images/selected.png', { attachmentId: AttachmentId('sha256:selected'), mediaType: 'image/png', bytes: 64, width: 8, height: 4 })
    const bindings = [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }]
    const quiet = await runtime.run(runtime.resolve({ program: 'await tools.image({})', bindings, discardCompletion: true }))
    expect(quiet.images).toBeUndefined()
    expect(quiet.logs).toEqual([])
    const failed = await runtime.run(runtime.resolve({ program: 'inspect(await tools.image({})); throw new Error("after image")', bindings, discardCompletion: true }))
    expect(failed.images).toEqual([{ afterLog: 0, attachment: image.attachment }])
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
    expect(first.images).toBeUndefined()
    const second = await runtime.run(runtime.resolve({ program: 'inspect(retainedImage)', stateOwner, discardCompletion: true, bindings: [] }))
    expect(second.error).toBeUndefined()
    expect(second.images).toEqual([{ afterLog: 0, attachment: image.attachment }])
    await runtime.release(stateOwner)
  })

  it('bounds explicitly inspected image descriptors while allowing uninspected images', async () => {
    const { runtime } = await mountRuntime(new Context(), { ...mode, maxOutputBytes: 128 })
    const image = new PtcImage('/images/large.png', { attachmentId: AttachmentId('sha256:large'), mediaType: 'image/png', bytes: 64, width: 8, height: 4, name: 'x'.repeat(200) })
    const bindings = [{ global: 'tools', functions: { image: () => Promise.resolve(image) } }]
    const quiet = await runtime.run(runtime.resolve({ program: 'await tools.image({})', bindings, discardCompletion: true }))
    expect(quiet.error).toBeUndefined()
    const selected = await runtime.run(runtime.resolve({ program: 'inspect(await tools.image({}))', bindings, discardCompletion: true }))
    expect(selected.error?.kind).toBe('output-limit')
    expect(selected.images).toBeUndefined()
  })

  it('discards completion values without reading their getters or requiring lossless JSON', async () => {
    const { run, completion } = await setup()
    const object = await run(completion('({ get value() { throw new Error("completion getter ran") } })'))
    expect(object.error).toBeUndefined()
    expect(object.logs).toEqual([])
    expect(object.value).toBeUndefined()
    const bigint = await run(completion('42n'))
    expect(bigint.error).toBeUndefined()
    expect(bigint.value).toBeUndefined()
    const captured = await run(`inspect("selected"); ${completion('"hidden"')}`)
    expect(captured.logs).toEqual(['selected'])
    expect(captured.value).toBeUndefined()
  })

  it('omits the console global and preserves ordinary undefined-variable behavior', async () => {
    const { runtime, run } = await setup()
    const caught = await run(`
      inspect(typeof console, globalThis.console, Object.hasOwn(globalThis, 'console'));
      for (const read of [() => console, () => console.log]) {
        try { read() } catch (error) { inspect(error.name, error.message) }
      }
    `)
    expect(caught.error).toBeUndefined()
    expect(caught.logs).toEqual(['undefined undefined false', ...Array<string>(2).fill('ReferenceError console is not defined')])
    const failed = await run('void console')
    expect(failed.error?.kind).toBe('exception')
    expect(failed.error?.message).toContain('ReferenceError: console is not defined')
    expect(runtime.executionInstructions).toContain('Console is unavailable. Use inspect(...values) for output.')
    const local = await run('{ const console = { value: 42 }; inspect(console.value) }')
    expect(local.error).toBeUndefined()
    expect(local.logs).toEqual(['42'])
    if (runtime.retainsState) {
      expect((await run('var console = { value: 17 }')).error).toBeUndefined()
      expect((await run('inspect(console.value)')).logs).toEqual(['17'])
    }
  })

  it('routes all enabled console methods through inspect with independent arguments', async () => {
    const { runtime, run } = await setup(true)
    const result = await run(`
      inspect("selected", { n: 1 });
      for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        inspect(console[method] === inspect);
        console[method]("%s", method);
      }
    `)
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['selected { n: 1 }', 'true', '%s log', 'true', '%s info', 'true', '%s warn', 'true', '%s error', 'true', '%s debug'])
    expect(runtime.executionInstructions).toContain('Use inspect(...values) for output.')
    expect(runtime.executionInstructions).not.toContain('console')
  })

  it.each([false, true])('keeps imported modules in the native realm with console enabled %s', async (enabled) => {
    const { run } = await setup(enabled)
    const source = 'console.warn("module warning"); console.dir({ dependency: true });'
    const result = await run(`await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(source)}`)})`)
    if (mode.executionMode === 'per-call') {
      expect(result.error?.kind).toBe('exception')
      expect(result.error?.message).toContain(enabled ? 'console.dir is not a function' : 'console is not defined')
    } else {
      expect(result.error).toBeUndefined()
      expect(result.logs.join('\n')).toContain('module warning')
      expect(result.logs.join('\n')).toContain('dependency: true')
    }
  })

  it('preserves completion values for direct runtime consumers that request them', async () => {
    const { run, completion } = await setup()
    expect((await run(completion('42'), false)).value).toBe(42)
  })
})
