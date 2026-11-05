/** Node REPL evaluation with declarations retained in its context. */
import { start } from 'node:repl'
import { resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { ModuleHooksImportLoader } from '../imports/module-hooks.ts'
import type { ProgramEvaluator, ProgramEvaluatorOptions } from './types.ts'

/**
 * Create a REPL whose globals survive sequential evaluations until close.
 * @param options - Runner diagnostics and optional synchronous import handling.
 * @returns Retained globals, asynchronous evaluation and REPL cleanup.
 */
export function createReplEvaluator(options: ProgramEvaluatorOptions): ProgramEvaluator {
  const imports = options.importHandler === undefined ? undefined : new ModuleHooksImportLoader(options.importHandler)
  const input = new PassThrough()
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const message = chunk.toString().trim()
    if (message) options.reportError(message)
    callback()
  } })
  const repl = start({ input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true })
  // Interactive result setters print notices; program assignments use ordinary retained globals.
  for (const name of ['_', '_error']) {
    Object.defineProperty(repl.context, name, { configurable: true, enumerable: true, writable: true, value: undefined })
  }
  return {
    globals: repl.context,
    evaluate(code, finish) {
      // Node's REPL treats a leading brace as an object expression before transforming await.
      const program = code.trimStart().startsWith('{') ? `;${code}` : code
      const evaluate = (): void => {
        repl.eval(`${program}\n`, repl.context, 'ptc-repl', (error: Error | null, value: unknown) => {
          finish(error ? { ok: false, error } : { ok: true, value })
        })
      }
      if (imports === undefined) evaluate()
      else imports.runRepl(resolve(process.cwd(), 'ptc-program.js'), evaluate)
    },
    close() {
      imports?.close()
      repl.close()
      input.destroy()
      output.destroy()
    },
  }
}
