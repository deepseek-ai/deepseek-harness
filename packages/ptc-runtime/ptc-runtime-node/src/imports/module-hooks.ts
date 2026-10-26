/** AsyncFunction and REPL imports backed by runner-local ESM exports and synchronous module hooks. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import * as module from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProgramImportHandler } from '../evaluators/types.ts'
import { ImportEvaluationEndedError } from './evaluation-ended.ts'

/* v8 ignore next 4 -- Typed decisions exhaust this union; the standalone child cannot depend on built workspace packages. */
function assertNever(value: never): never {
  throw new Error(`Unsupported PTC import decision: ${String(value)}`)
}

/** Module hooks and an export bridge owned by one native evaluator. */
export class ModuleHooksImportLoader {
  private readonly identity = randomUUID()
  private readonly bridgeName = `dsh.ptc.imports.${this.identity}`
  private readonly bridgeKey = Symbol.for(this.bridgeName)
  private readonly hooks: module.ModuleHooks
  private readonly programs = new Map<string | undefined, string>()
  private readonly replPrograms = new Map<string | undefined, string>()
  private readonly scope = new AsyncLocalStorage<boolean>()
  private readonly sources = new Map<string, string>()
  private readonly bindings = new Map<string, Record<string, unknown>>()
  private modules = new WeakMap<Record<string, unknown>, string>()
  private sequence = 0
  private closed = false

  /**
   * Install synchronous hooks for this evaluator's programs only.
   * @param handler - Runner-local decisions; returning a Promise rejects the import.
   */
  constructor(handler: ProgramImportHandler) {
    this.hooks = module.registerHooks({
      resolve: (specifier, context, nextResolve) => {
        const filename = this.programs.get(context.parentURL)
          ?? (this.scope.getStore() ? this.replPrograms.get(context.parentURL) : undefined)
        if (filename === undefined) return nextResolve(specifier, context)
        let result
        try {
          result = handler({ specifier, referrer: filename, attributes: context.importAttributes })
        } catch (error) {
          if (error instanceof ImportEvaluationEndedError && !error.retainsState) {
            return { url: 'data:text/javascript,await new Promise(() => {})', shortCircuit: true }
          }
          throw error
        }
        if ('then' in result) {
          // Native hooks cannot await this result; consume a rejection before reporting unsupported handling.
          void result.catch(() => {})
          throw new Error('Native PTC imports require a synchronous importHandler')
        }
        switch (result.type) {
          case 'module': return { url: this.moduleUrl(result.exports), importAttributes: {}, shortCircuit: true }
          case 'redirect': specifier = result.specifier; break
          case 'default': break
          /* v8 ignore next -- The runner supplies the closed ProgramImportResult union. */
          default: return assertNever(result)
        }
        return nextResolve(specifier, { ...context, parentURL: pathToFileURL(filename).href })
      },
      load: (url, context, nextLoad) => {
        const source = this.sources.get(url)
        this.sources.delete(url)
        return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true }
      },
    })
    const bridge = Object.freeze({ get: (url: string) => {
      const exports = this.bindings.get(url)
      this.bindings.delete(url)
      return exports
    } })
    Object.defineProperty(globalThis, this.bridgeKey, { value: bridge, configurable: true })
  }

  /**
   * Register an AsyncFunction import parent owned by this evaluator.
   * @param filename - Absolute program filename, captured before its evaluation.
   * @returns Unique program URL for the native compiler and constructor source URL.
   */
  forFile(filename: string): string {
    const url = `${pathToFileURL(filename).href}?${this.identity}`
    this.programs.set(url, filename)
    return url
  }

  /**
   * Attribute Node REPL imports to this evaluator, including asynchronous callbacks.
   * @param filename - Absolute program filename for the evaluation's working directory.
   * @param evaluate - Start the REPL evaluation while its import scope is active.
   */
  runRepl(filename: string, evaluate: () => void): void {
    if (this.closed) throw new Error('PTC evaluator is closed')
    // Node REPL captures cwd/repl as its import parent, independently of its diagnostic filename.
    this.replPrograms.set(pathToFileURL(join(dirname(filename), 'repl')).href, filename)
    this.scope.run(true, evaluate)
  }

  /** Deregister hooks and remove the export bridge; Node retains loaded ESM namespaces until process exit. */
  close(): void {
    this.closed = true
    this.hooks.deregister()
    Reflect.deleteProperty(globalThis, this.bridgeKey)
    this.programs.clear()
    this.replPrograms.clear()
    this.scope.disable()
    this.sources.clear()
    this.bindings.clear()
    this.modules = new WeakMap()
  }

  private moduleUrl(exports: Record<string, unknown>): string {
    const existing = this.modules.get(exports)
    if (existing !== undefined) return existing
    const url = `dsh-ptc-module:${this.identity}/${++this.sequence}`
    const declarations = Object.keys(exports).map((name, index) =>
      `const value${index} = bindings[${JSON.stringify(name)}]; export { value${index} as ${JSON.stringify(name)} };`)
    const lookup = `globalThis[Symbol.for(${JSON.stringify(this.bridgeName)})].get(${JSON.stringify(url)})`
    this.sources.set(url, `const bindings = ${lookup};\n${declarations.join('\n')}`)
    this.bindings.set(url, exports)
    this.modules.set(exports, url)
    return url
  }
}
