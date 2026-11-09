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

  it('renders each inspected argument independently and preserves format placeholders', async () => {
    const { run } = await setup()
    const result = await run('Harness.inspect("%s %d %j %%", "text", 7, { n: 1 }, [2, 3]);')
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['%s %d %j %% text 7 { n: 1 } [ 2, 3 ]'])
    expect(result.value).toBeUndefined()
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
    const captured = await run(`Harness.inspect("selected"); ${completion('"hidden"')}`)
    expect(captured.logs).toEqual(['selected'])
    expect(captured.value).toBeUndefined()
  })

  it('omits the console global and preserves ordinary undefined-variable behavior', async () => {
    const { runtime, run } = await setup()
    const caught = await run(`
      Harness.inspect(typeof console, globalThis.console, Object.hasOwn(globalThis, 'console'));
      for (const read of [() => console, () => console.log]) {
        try { read() } catch (error) { Harness.inspect(error.name, error.message) }
      }
    `)
    expect(caught.error).toBeUndefined()
    expect(caught.logs).toEqual(['undefined undefined false', ...Array<string>(2).fill('ReferenceError console is not defined')])
    const failed = await run('void console')
    expect(failed.error?.kind).toBe('exception')
    expect(failed.error?.message).toContain('ReferenceError: console is not defined')
    expect(runtime.executionInstructions).toContain('Console is unavailable. Use Harness.inspect(...values) for output.')
    const local = await run('{ const console = { value: 42 }; Harness.inspect(console.value) }')
    expect(local.error).toBeUndefined()
    expect(local.logs).toEqual(['42'])
    if (runtime.retainsState) {
      expect((await run('var console = { value: 17 }')).error).toBeUndefined()
      expect((await run('Harness.inspect(console.value)')).logs).toEqual(['17'])
    }
  })

  it('routes all enabled console methods through inspect with independent arguments', async () => {
    const { runtime, run } = await setup(true)
    const result = await run(`
      Harness.inspect("selected", { n: 1 });
      for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
        Harness.inspect(console[method] === Harness.inspect);
        console[method]("%s", method);
      }
    `)
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['selected { n: 1 }', 'true', '%s log', 'true', '%s info', 'true', '%s warn', 'true', '%s error', 'true', '%s debug'])
    expect(runtime.executionInstructions).toContain('Use Harness.inspect(...values) for output.')
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
