import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

it.each([false, true])('preserves binding error identity and imported realm semantics with retention %s', async (scriptPersistence) => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence })
  const result = await runtime.run(runtime.resolve({
    program: `
      const array = await tools.array({});
      const {types} = await import('node:util');
      let failure;
      try { await tools.fail({}) } catch (error) {
        failure = [error instanceof ToolCallError, error instanceof Error, error.name, error.toolName, error.message, types.isNativeError(error)];
      }
      ({array: [Array.isArray(array), array instanceof Array], failure})
    `,
    bindings: [{ global: 'tools', functions: { array: async () => [1, 2], fail: async () => { throw new Error('denied') } },
      errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' } }], stateOwner: {},
  }))
  expect(result.error).toBeUndefined()
  expect(result.value).toEqual({ array: [true, false], failure: [true, false, 'ToolCallError', 'fail', 'denied', true] })
})

it.each([
  'setImmediate(() => { throw new Error("uncaught callback") }); await new Promise(() => {})',
  'void Promise.reject(new Error("unhandled rejection")); await new Promise(() => {})',
])('discards retained Script state after an asynchronous process failure: %s', async (program) => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence: true })
  const stateOwner = {}
  const run = (source: string) => runtime.run(runtime.resolve({ program: source, bindings: [], stateOwner }))
  expect((await run('let retained = 17; retained')).value).toBe(17)
  const failure = await run(program)
  expect(failure.error?.kind).toBe('worker-exit')
  expect(failure.error?.message).toContain('retained variables were cleared')
  expect((await run('typeof retained')).value).toBe('undefined')
})

it('cancels a temporary Script after a binding handshake and starts the next call fresh', async () => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script' })
  const entered: PromiseWithResolvers<void> = Promise.withResolvers()
  const controller = new AbortController()
  const pending = runtime.run(runtime.resolve({
    program: 'let retained = 1; await tools.enter({}); await new Promise(() => {})',
    bindings: [{ global: 'tools', functions: { enter: async () => { entered.resolve(); return null } } }], signal: controller.signal,
  }))
  try {
    await entered.promise
    controller.abort('stop Script')
    expect((await pending).error).toEqual({ kind: 'abort', message: 'stop Script' })
    expect((await runtime.run(runtime.resolve({ program: 'typeof retained', bindings: [] }))).value).toBe('undefined')
  } finally { controller.abort(); await pending }
})

it.each([false, true])('accepts adjacent var patterns and comments in Script loops with retention %s', async (scriptPersistence) => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence })
  const result = await runtime.run(runtime.resolve({
    program: 'for (var{x} of [{x: 1}]) { await 0 }; for (var[y] of [[2]]) { await 0 }; for (var/* comment */z of [3]) { await 0 }; [x, y, z]',
    bindings: [], stateOwner: {},
  }))
  expect(result.error).toBeUndefined()
  expect(result.value).toEqual([1, 2, 3])
})

it.each([false, true])('reports native Script parse errors with their source position and no compiler frames with retention %s', async (scriptPersistence) => {
  const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence })
  const result = await runtime.run(runtime.resolve({ program: 'let duplicate; let duplicate;', bindings: [], stateOwner: {} }))
  expect(result.error?.kind).toBe('exception')
  expect(result.error?.message).toContain('ptc-program.js:1')
  expect(result.error?.message).toContain("SyntaxError: Identifier 'duplicate' has already been declared")
  expect(result.error?.message).not.toContain('vm-script')
  expect(result.error?.message).not.toContain('node:vm')
})
