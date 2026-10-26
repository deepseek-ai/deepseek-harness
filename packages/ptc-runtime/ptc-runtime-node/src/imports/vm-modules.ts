/** Adapt runner-local import decisions to Node's VM module callbacks. */
import * as vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { registerHooks, type ImportAttributes, type ResolveFnOutput } from 'node:module'
import type { ProgramImportHandler } from '../evaluators/types.ts'
import { ImportEvaluationEndedError } from './evaluation-ended.ts'

/* v8 ignore next 4 -- Typed decisions exhaust this union; the standalone child cannot depend on built workspace packages. */
function assertNever(value: never): never {
  throw new Error(`Unsupported PTC import decision: ${String(value)}`)
}

// Node >=24.9 supplies explicit graph linking; the installed Node declarations omit these methods.
interface SourceModule extends vm.SourceTextModule {
  instantiate(): void
  linkRequests(modules: vm.Module[]): void
  readonly moduleRequests: readonly (vm.ModuleRequest & { phase: string })[]
}
const SourceModule = vm.SourceTextModule as new (code: string, options: vm.SourceTextModuleOptions) => SourceModule

/** Node retains evaluation state; the loader owns asynchronous dependency resolution. */
interface ModuleRecord {
  module: vm.Module
  dependencies?: Promise<ModuleRecord[]>
  expired?: boolean
}

type ImportResult = ModuleRecord | { namespace: Record<string, unknown> }

/** Modules belong to one evaluator; each compiled program retains its own resolution filename. */
export class VmModuleImportLoader {
  private modules = new WeakMap<Record<string, unknown>, ModuleRecord>()
  private files = new Map<string, Promise<ModuleRecord>>()
  private readonly handler: ProgramImportHandler
  private readonly context: vm.Context
  private closed = false
  // Keep resolved URLs on Node's loader even when this file's importer transforms import().
  private readonly nativeImport = vm.compileFunction('return import(url, { with: attributes })', ['url', 'attributes'], {
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (url: string, attributes: ImportAttributes) => Promise<unknown>

  /**
   * Own module instances for one evaluator's runner-local handler.
   * @param handler - Runner-local import decisions.
   * @param context - Script context receiving the imported modules.
   */
  constructor(handler: ProgramImportHandler, context: vm.Context) {
    this.handler = handler
    this.context = context
    if (typeof vm.SyntheticModule !== 'function') {
      throw new Error('PTC importHandler requires the runner to start with --experimental-vm-modules')
    }
  }

  /**
   * Bind import resolution to the filename used to compile a program.
   * @param filename - Absolute program filename, captured before its evaluation.
   * @returns Callback implementing the runner's import handler.
   */
  forFile(filename: string): vm.DynamicModuleLoader<object> {
    return this.callback(pathToFileURL(filename).href)
  }

  /** Reject further handler calls and release cached modules; imported values remain usable. */
  close(): void {
    this.closed = true
    this.modules = new WeakMap()
    this.files.clear()
  }

  private assertOpen(late = false): void {
    if (this.closed) throw new Error(late ? 'PTC evaluator closed before its import completed' : 'PTC evaluator is closed')
  }

  private callback(referrer: string): vm.DynamicModuleLoader<object> {
    const load = async (specifier: string, _referrer: object, attributes: ImportAttributes, phase = 'evaluation') => {
      const record = await this.request(specifier, referrer, attributes, phase)
      this.assertOpen(true)
      if ('namespace' in record) return record.namespace
      await this.link(record, new Set())
      this.assertOpen(true)
      if (record.module instanceof SourceModule && record.module.status === 'unlinked') record.module.instantiate()
      await record.module.evaluate()
      this.assertOpen(true)
      return record.module
    }
    // Node accepts native namespaces; its callback declarations only describe vm.Module results.
    return load as vm.DynamicModuleLoader<object>
  }

  private async request(
    specifier: string, referrer: string, attributes: ImportAttributes, phase: string, staticImport = false,
  ): Promise<ImportResult> {
    this.assertOpen()
    if (phase !== 'evaluation') throw new Error('PTC importHandler supports evaluation-phase imports only')
    let result
    try {
      result = await this.handler({ specifier, referrer: fileURLToPath(referrer), attributes })
    } catch (error) {
      // A closing temporary process must not resume detached program catch handlers.
      if (error instanceof ImportEvaluationEndedError && !error.retainsState) return new Promise<never>(() => {})
      throw error
    }
    this.assertOpen(true)
    switch (result.type) {
      case 'module': return this.module(result.exports)
      case 'redirect': specifier = result.specifier; break
      case 'default': break
      /* v8 ignore next -- The runner supplies the closed ProgramImportResult union. */
      default: return assertNever(result)
    }
    const resolved = resolveImport(specifier, referrer)
    const url = new URL(resolved.url)
    if (isSourceModule(url, resolved.format)) {
      if (Object.keys(attributes).length) throw new TypeError(`PTC ESM imports do not accept import attributes: ${url.href}`)
      return this.file(url)
    }
    if (staticImport) {
      // Export the namespace as a value so native Promise assimilation cannot consume its then export.
      const source = `import * as namespace from ${JSON.stringify(url.href)} with ${JSON.stringify(attributes)}; export { namespace }`
      const loaded = await this.nativeImport(`data:text/javascript,${encodeURIComponent(source)}`, {}) as { namespace: Record<string, unknown> }
      this.assertOpen(true)
      return { namespace: loaded.namespace }
    }
    const value = await this.nativeImport(url.href, attributes)
    this.assertOpen(true)
    if (types.isModuleNamespaceObject(value)) return { namespace: value as Record<string, unknown> }
    // A native then export can settle to any value; the VM callback still requires a module.
    return this.module({ then(resolve: (result: unknown) => void) { resolve(value) } })
  }

  private async file(url: URL): Promise<ModuleRecord> {
    let pending = this.files.get(url.href)
    if (!pending) {
      pending = this.sourceModule(url)
      this.files.set(url.href, pending)
    }
    const record = await pending
    if (record.expired || (record.module.status === 'errored' && record.module.error instanceof ImportEvaluationEndedError)) {
      if (this.files.get(url.href) === pending) this.files.delete(url.href)
      return this.file(url)
    }
    return record
  }

  private async sourceModule(url: URL): Promise<ModuleRecord> {
    const source = await readFile(url, 'utf8')
    this.assertOpen(true)
    const filename = fileURLToPath(url)
    return { module: new SourceModule(source, {
      context: this.context,
      identifier: url.href,
      initializeImportMeta(meta) {
        meta.url = url.href
        meta.filename = filename
        meta.dirname = dirname(filename)
        meta.main = false
        meta.resolve = (specifier: string) => resolveImport(specifier, url.href).url
      },
      importModuleDynamically: this.callback(url.href),
    }) }
  }

  private async link(record: ModuleRecord, visited: Set<ModuleRecord>): Promise<void> {
    if (visited.has(record)) return
    visited.add(record)
    record.dependencies ??= this.dependencies(record.module)
    try {
      const dependencies = await record.dependencies
      this.assertOpen(true)
      await Promise.all(dependencies.map(dependency => this.link(dependency, visited)))
    } catch (error) {
      if (error instanceof ImportEvaluationEndedError) record.expired = true
      throw error
    }
  }

  private async dependencies(module: vm.Module): Promise<ModuleRecord[]> {
    if (module instanceof SourceModule) {
      const dependencies = await Promise.all(module.moduleRequests.map(async (request) => {
        const result = await this.request(request.specifier, module.identifier, request.attributes, request.phase, true)
        return 'namespace' in result ? this.module(result.namespace) : result
      }))
      this.assertOpen(true)
      // Cache direct dependencies before walking them: cycles must not await their own graph.
      module.linkRequests(dependencies.map(record => record.module))
      return dependencies
    }
    /* v8 ignore next -- SyntheticModule has no dependencies, so Node never calls its linker. */
    await module.link(() => module)
    return []
  }

  private module(exports: Record<string, unknown>): ModuleRecord {
    this.assertOpen(true)
    const existing = this.modules.get(exports)
    if (existing) return existing
    const names = Object.keys(exports)
    const module = new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, exports[name])
    }, { context: this.context })
    const record = { module }
    this.modules.set(exports, record)
    return record
  }
}

/** Resolve with the native loader's conditions and flags while retaining the importing filename. */
function resolveImport(specifier: string, parentURL: string): ResolveFnOutput {
  const marker = 'dsh-ptc:resolve'
  let format: ResolveFnOutput['format']
  const hooks = registerHooks({
    resolve(request, context, nextResolve) {
      if (request !== marker) return nextResolve(request, context)
      const resolved = nextResolve(specifier, { ...context, parentURL })
      format = resolved.format
      return resolved
    },
  })
  try { return { url: import.meta.resolve(marker), format } }
  finally { hooks.deregister() }
}

/** Explicit file ESM stays in the evaluator; other formats retain Node's loader. */
function isSourceModule(url: URL, format: ResolveFnOutput['format']): boolean {
  if (url.protocol !== 'file:') return false
  const extension = extname(fileURLToPath(url))
  if (extension === '.mjs') return true
  return extension === '.js' && format === 'module'
}
