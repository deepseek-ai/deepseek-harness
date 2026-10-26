/** Node REPL evaluation with declarations retained in its context. */
import { start } from 'node:repl'
import { PassThrough, Writable } from 'node:stream'
import type { ProgramEvaluator } from './types.ts'

/**
 * Create a REPL whose globals survive sequential evaluations until close.
 * @param reportError - REPL diagnostics attributed to the active evaluation.
 * @returns Retained globals, asynchronous evaluation and REPL cleanup.
 */
export function createReplEvaluator(reportError: (message: string) => void): ProgramEvaluator {
  const input = new PassThrough()
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const message = chunk.toString().trim()
    if (message) reportError(message)
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
      repl.eval(`${program}\n`, repl.context, 'ptc-repl', (error: Error | null, value: unknown) => {
        finish(error ? { ok: false, error } : { ok: true, value })
      })
    },
    close() {
      repl.close()
      input.destroy()
      output.destroy()
    },
  }
}
