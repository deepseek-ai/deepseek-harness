/** Strict async-function-body evaluation with host bindings as parameters. */
import { resolve } from 'node:path'
import { compileFunction, constants } from 'node:vm'
import { ModuleHooksImportLoader } from '../imports/module-hooks.ts'
import type { ProgramEvaluator, ProgramEvaluatorOptions } from './types.ts'

type AsyncProgram = (...args: unknown[]) => Promise<unknown>

/**
 * Create an evaluator whose function-local declarations end with each call.
 * @param options - Runner diagnostics and optional synchronous import handling.
 * @returns Binding globals, asynchronous evaluation and resource cleanup.
 */
export function createAsyncFunctionEvaluator(options: ProgramEvaluatorOptions): ProgramEvaluator {
  const globals = Object.create(null) as Record<string, unknown>
  const imports = options.importHandler === undefined ? undefined : new ModuleHooksImportLoader(options.importHandler)
  let closed = false
  return {
    globals,
    evaluate(code, finish) {
      if (closed) throw new Error('PTC evaluator is closed')
      /* v8 ignore next -- The arrow supplies the intrinsic constructor and is never invoked. */
      const AsyncFunction = (async () => {}).constructor as new (...args: string[]) => AsyncProgram
      const body = `'use strict';\n${code}`
      let fn: AsyncProgram
      if (imports === undefined) fn = new AsyncFunction(...Object.keys(globals), body)
      else {
        const sourceUrl = imports.forFile(resolve(process.cwd(), 'ptc-program.js'))
        const factory = compileFunction('return new (async () => {}).constructor(...args)', ['args'], {
          filename: sourceUrl, importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        }) as (args: string[]) => AsyncProgram
        // V8 caches constructor bodies across callers; each evaluator and filename needs a distinct source URL.
        fn = factory([...Object.keys(globals), `${body}\n//# sourceURL=${sourceUrl}`])
      }
      void fn(...Object.values(globals)).then(
        (value) => { finish({ ok: true, value }) },
        (error: unknown) => { finish({ ok: false, error }) },
      )
    },
    close() { closed = true; imports?.close() },
  }
}
