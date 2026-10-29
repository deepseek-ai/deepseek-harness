/** VM Script evaluation with Node globals and retained Script-scope declarations. */
import { resolve } from 'node:path'
import { constants, createContext, Script, type Context, type ScriptOptions } from 'node:vm'
import { processTopLevelAwait } from './vm-script-await.ts'
import type { ProgramEvaluator } from './types.ts'

/**
 * Create a VM context supporting Script completion values and top-level await.
 * @returns Retained globals, asynchronous evaluation and resource cleanup.
 */
export function createVmScriptEvaluator(): ProgramEvaluator {
  const context = createScriptContext()
  return {
    globals: context,
    evaluate(code, finish) {
      void evaluateScript(code, context).then(
        (value) => { finish({ ok: true, value }) },
        (error: unknown) => { finish({ ok: false, error }) },
      )
    },
    close() {},
  }
}

/**
 * Create an independent program context with Node globals.
 * @returns A context reusable for sequential evaluations.
 */
function createScriptContext(): Context {
  const globals = Object.create(null) as Record<string, unknown>
  const context = createContext(globals)
  const realm = new Script('globalThis').runInContext(context) as Record<string, unknown>
  for (const key of Reflect.ownKeys(globalThis)) {
    if (key === 'global' || Object.hasOwn(realm, key)) continue
    Object.defineProperty(globals, key, Object.getOwnPropertyDescriptor(globalThis, key) as PropertyDescriptor)
  }
  globals.global = realm
  return context
}

/**
 * Evaluate a script, lowering top-level await while retaining Script-scope declarations.
 * @param code - Type-stripped JavaScript; top-level return is not supported.
 * @param context - Program globals and declarations retained between evaluations.
 * @returns The script completion value after Promise settlement.
 */
async function evaluateScript(code: string, context: Context): Promise<unknown> {
  const options: ScriptOptions = {
    filename: resolve(process.cwd(), 'ptc-program.js'),
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }
  const compiled = compileScript(code, options)
  const value: unknown = await compiled.script.runInContext(context)
  // Node's transform boxes the last expression; the PTC caller also awaits that expression.
  return compiled.transformed ? await (value as { value: unknown } | undefined)?.value : value
}

/** Detect top-level await before native compilation can interpret await as an identifier. */
function compileScript(code: string, options: ScriptOptions): { script: Script; transformed: boolean } {
  try {
    let transformed: string | null = null
    if (code.includes('await')) {
      // Complete submissions need no REPL continuation; the newline terminates trailing comments.
      const source = code.startsWith('#!') ? `//${code.slice(2)}` : code
      transformed = processTopLevelAwait(`${source}\n`)
    }
    return { script: new Script(transformed ?? code, options), transformed: transformed !== null }
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      // V8 places the source location and caret before the error heading and its compiler frames.
      const heading = `${error.name}: ${error.message}`
      const stack = error.stack ?? ''
      const headingStart = stack.indexOf(`\n${heading}`)
      error.stack = headingStart < 0 ? heading : stack.slice(0, headingStart + heading.length + 1)
    }
    throw error
  }
}
