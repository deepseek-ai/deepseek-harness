/** Strict async-function-body evaluation with host bindings as parameters. */
import type { ProgramEvaluator } from './types.ts'

/**
 * Create an evaluator whose function-local declarations end with each call.
 * @returns Binding globals, asynchronous evaluation and resource cleanup.
 */
export function createAsyncFunctionEvaluator(): ProgramEvaluator {
  const globals = Object.create(null) as Record<string, unknown>
  return {
    globals,
    evaluate(code, finish) {
      // The async function constructor, reached through an instance because
      // `AsyncFunction` is not a global. The program body is strict-mode.
      /* v8 ignore next -- the arrow exists only to reach the AsyncFunction constructor; it is never invoked. */
      const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>
      const fn = new AsyncFunction(...Object.keys(globals), `'use strict';\n${code}`)
      void fn(...Object.values(globals)).then(
        (value) => { finish({ ok: true, value }) },
        (error: unknown) => { finish({ ok: false, error }) },
      )
    },
    close() {},
  }
}
