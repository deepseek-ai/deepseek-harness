/** Scoped REPL evaluation for the child loop: context, dynamic imports, completion, and REPL-style asynchronous failures. */
import { resolve } from 'node:path'
import { inspect, types } from 'node:util'
import { constants, createContext, Script } from 'node:vm'
import { VmModuleImportLoader } from '../imports/vm-modules.ts'
import { ScopedReplScopes, type ScopedReplProgram, type ScopedReplRedeclaration } from './scoped-repl.ts'
import type { ProgramEvaluator, ProgramEvaluatorOptions } from './types.ts'

/** Environment choices for one scoped REPL evaluator; omitted fields use the documented defaults. */
export interface ScopedReplEvaluatorOptions extends ProgramEvaluatorOptions {
  /** Force strict mode for every program; when off, a program's own leading "use strict" decides. Defaults to true. */
  strict?: boolean
  /** Allow eval, new Function and WebAssembly compilation inside the program context; defaults to false. */
  codeGeneration?: boolean
  /** Use the last top-level expression statement as the completion value; defaults to true. */
  finalExpression?: boolean
}

/**
 * Create an evaluator whose programs see copies of earlier top-level bindings and may declare any of them again.
 * Each program is a separate Script in one retained context; the scope chain lives in {@link ScopedReplScopes}.
 * Programs load modules only with dynamic `import()`; there is no `require`, `module`, or built-in module global.
 * Relative specifiers resolve from the working directory at creation, also after later calls change directory.
 * A final Promise is returned without being awaited. Asynchronous program failures go to `reportError` through a domain,
 * as in Node's REPL, instead of terminating the process.
 * @param options - Runner diagnostics, optional import handling, and environment choices.
 * @returns Context globals, sequential evaluation, and resource cleanup.
 */
export function createScopedReplEvaluator(options: ScopedReplEvaluatorOptions): ProgramEvaluator {
  const finalExpression = options.finalExpression ?? true
  // Generated filenames are import referrers; relative file access in programs still follows process.cwd().
  const baseDirectory = process.cwd()
  // A null prototype keeps global lookups from reaching the main realm's Function. Copied main-realm values still expose it
  // (setTimeout.constructor), so codeGeneration limits only this context's own eval, Function and WebAssembly; it is not isolation.
  const sandbox = Object.create(null) as Record<string, unknown>
  const context = createContext(sandbox, options.codeGeneration === true ? {} : { codeGeneration: { strings: false, wasm: false } })
  const realm = new Script('globalThis').runInContext(context) as object
  for (const key of Reflect.ownKeys(globalThis)) {
    if (key !== 'global' && !Object.hasOwn(realm, key)) Object.defineProperty(sandbox, key, Object.getOwnPropertyDescriptor(globalThis, key) as PropertyDescriptor)
  }
  sandbox.global = realm
  const imports = options.importHandler === undefined ? undefined : new VmModuleImportLoader(options.importHandler, context)
  // Loaded on use: bundles that never run scoped REPL programs, such as the browser worker image, carry no domain module.
  const programDomain = process.getBuiltinModule('node:domain').create()
  programDomain.on('error', (error: unknown) => { options.reportError(`Uncaught ${describeThrown(error)}`) })
  const scopes = new ScopedReplScopes({ strict: options.strict ?? true, onRedeclaration: reportRedeclarations })
  let submissions = 0
  let closed = false
  return {
    globals: sandbox,
    evaluate(code, finish) {
      if (closed) throw new Error('PTC evaluator is closed')
      // No file exists at this hidden path; its directory anchors relative imports.
      const filename = resolve(baseDirectory, `.ptc-repl-${++submissions}.js`)
      let program: ScopedReplProgram
      try {
        program = scopes.compile(code, {
          filename, context, finalExpression,
          importModuleDynamically: imports?.forFile(filename) ?? constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        })
      } catch (error: unknown) {
        finish({ ok: false, error })
        return
      }
      // The bound Reflect.apply lets the microtask call the program itself, so synchronous throws carry no evaluator frames.
      const start = Reflect.apply.bind(undefined, program, undefined, []) as ScopedReplProgram
      void programDomain.run(() => Promise.resolve().then(start)).then(
        (completion) => { finish({ ok: true, value: completion?.value }) },
        (error: unknown) => { finish({ ok: false, error }) },
      )
    },
    close() {
      closed = true
      imports?.close()
    },
  }
}

/**
 * Describe a value thrown by asynchronous program work without ever throwing.
 * A throw escaping the domain error listener would end the process, and programs control the values they throw.
 * @param error - Value the program threw or rejected with.
 * @returns The error's string stack or `name: message`, the inspected value without domain markers, or a fixed description.
 */
function describeThrown(error: unknown): string {
  try {
    if (types.isNativeError(error)) {
      // Programs can replace stack with any value; only a string stack is shown.
      const stack: unknown = error.stack
      return typeof stack === 'string' ? stack : `${error.name}: ${error.message}`
    }
    // The domain marks thrown objects; node:repl removes these markers before printing them.
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'domainThrown') === true) {
      Reflect.deleteProperty(error, 'domain')
      Reflect.deleteProperty(error, 'domainThrown')
    }
    return inspect(error)
  } catch (_failure: unknown) {
    // The program can make its stack accessor, toString, or custom inspection throw.
    return 'program threw an unrenderable value'
  }
}

/**
 * Report names declared again after an earlier program bound them.
 * @param _redeclarations - Each redeclared name with its earlier and current keyword.
 */
function reportRedeclarations(_redeclarations: readonly ScopedReplRedeclaration[]): void {
  // TODO: Write redeclaration warnings to the program console once their wording is decided.
}
