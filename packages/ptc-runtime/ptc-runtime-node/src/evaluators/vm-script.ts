/** VM Script evaluation with Node globals and retained Script-scope declarations. */
import { resolve } from 'node:path'
import { types } from 'node:util'
import { constants, createContext, Script, type Context, type ScriptOptions } from 'node:vm'
import { VmModuleImportLoader } from '../imports/vm-modules.ts'
import { processTopLevelAwait } from './vm-script-await.ts'
import type { ProgramEvaluator, ProgramEvaluatorOptions } from './types.ts'

/**
 * Create a VM context supporting Script completion values and top-level await.
 * @param options - Runner diagnostics and optional import handling.
 * @returns Retained globals, asynchronous evaluation and resource cleanup.
 */
export function createVmScriptEvaluator(options: ProgramEvaluatorOptions): ProgramEvaluator {
  const context = createScriptContext()
  const imports = options.importHandler === undefined ? undefined : new VmModuleImportLoader(options.importHandler, context)
  return {
    globals: context,
    evaluate(code, finish) {
      void evaluateScript(code, context, imports).then(
        (value) => { finish({ ok: true, value }) },
        (error: unknown) => { finish({ ok: false, error }) },
      )
    },
    close() { imports?.close() },
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
 * @param imports - Runner-local import handling, or undefined for Node's default loader.
 * @returns The script completion value after Promise settlement.
 */
async function evaluateScript(code: string, context: Context, imports: VmModuleImportLoader | undefined): Promise<unknown> {
  try {
    const filename = resolve(process.cwd(), 'ptc-program.js')
    const options: ScriptOptions = {
      filename,
      importModuleDynamically: imports === undefined ? constants.USE_MAIN_CONTEXT_DEFAULT_LOADER : imports.forFile(filename),
    }
    const compiled = compileScript(code, options)
    const value: unknown = await compiled.script.runInContext(context)
    // Node's transform boxes the last expression; the PTC caller also awaits that expression.
    return compiled.transformed ? await (value as { value: unknown } | undefined)?.value : value
  } catch (error: unknown) {
    if (!types.isNativeError(error)) throw error
    // Script errors belong to another realm; preserve their diagnostics for the bootstrap.
    let detail: string
    try { detail = error.stack ?? error.message } catch { detail = 'program threw an unrenderable value' }
    const failure = new Error(detail)
    failure.stack = detail
    throw failure
  }
}

/** Detect top-level await before native compilation can interpret await as an identifier. */
function compileScript(code: string, options: ScriptOptions): { script: Script; transformed: boolean } {
  if (code.includes('await')) {
    // Complete submissions need no REPL continuation; the newline terminates trailing comments.
    const source = code.startsWith('#!') ? `//${code.slice(2)}` : code
    let transformed: string | null
    try { transformed = processTopLevelAwait(`${source}\n`) } catch (error: unknown) {
      // Parser diagnostics describe the program; transformer stack frames do not.
      if (error instanceof SyntaxError) error.stack = `${error.name}: ${error.message}`
      throw error
    }
    if (transformed !== null) return { script: new Script(transformed, options), transformed: true }
  }
  return { script: new Script(code, options), transformed: false }
}
