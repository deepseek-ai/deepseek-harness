/** Adapt runner-local import decisions to Node's VM module callbacks. */
import * as vm from 'node:vm'
import type { ImportAttributes } from 'node:module'
import type { ProgramImportHandler } from '../evaluators/types.ts'

/* v8 ignore next 4 -- Typed decisions exhaust this union; the standalone child cannot depend on built workspace packages. */
function assertNever(value: never): never {
  throw new Error(`Unsupported PTC import decision: ${String(value)}`)
}

type NativeImport = (specifier: string, attributes: ImportAttributes) => Promise<unknown>
type ImportLoader = vm.DynamicModuleLoader<object> | typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER

/** Modules belong to one evaluator; each compiled program retains its own resolution filename. */
export class VmModuleImportLoader {
  private modules = new WeakMap<Record<string, unknown>, Promise<vm.Module>>()
  private readonly handler: ProgramImportHandler | undefined
  private readonly context: vm.Context
  private closed = false

  /**
   * Own module instances for one evaluator's runner-local handler.
   * @param handler - Import decisions, or undefined to retain Node's default loader.
   * @param context - Script context receiving the imported modules.
   */
  constructor(handler: ProgramImportHandler | undefined, context: vm.Context) {
    this.handler = handler
    this.context = context
    if (handler !== undefined && typeof vm.SyntheticModule !== 'function') {
      throw new Error('PTC importHandler requires the runner to start with --experimental-vm-modules')
    }
  }

  /**
   * Bind import resolution to the filename used to compile a program.
   * @param filename - Absolute program filename, captured before its evaluation.
   * @returns Native loading or a callback implementing the runner's import handler.
   */
  forFile(filename: string): ImportLoader {
    const handler = this.handler
    if (handler === undefined) return vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    let nativeImport: NativeImport | undefined
    const load = async (specifier: string, _referrer: object, attributes: ImportAttributes, phase = 'evaluation'): Promise<unknown> => {
      if (this.closed) throw new Error('PTC evaluator is closed')
      if (phase !== 'evaluation') throw new Error('PTC importHandler supports evaluation-phase imports only')
      const result = await handler({ specifier, referrer: filename, attributes })
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cleanup can close the evaluator during the handler await.
      if (this.closed) throw new Error('PTC evaluator closed before its import completed')
      switch (result.type) {
        case 'module': return this.module(result.exports)
        case 'redirect': specifier = result.specifier; break
        case 'default': break
        /* v8 ignore next -- The runner supplies the closed ProgramImportResult union. */
        default: return assertNever(result)
      }
      nativeImport ??= vm.compileFunction('return import(specifier, { with: attributes })', ['specifier', 'attributes'], {
        filename, importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      }) as NativeImport
      return nativeImport(specifier, attributes)
    }
    // Node accepts namespace objects as well as vm.Module; the Node types declare only vm.Module.
    return load as vm.DynamicModuleLoader<object>
  }

  /** Reject further handler calls and release cached modules; imported values remain usable. */
  close(): void {
    this.closed = true
    this.modules = new WeakMap()
  }

  private module(exports: Record<string, unknown>): Promise<vm.Module> {
    const existing = this.modules.get(exports)
    if (existing) return existing
    const names = Object.keys(exports)
    const module = new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, exports[name])
    }, { context: this.context })
    const ready = (async () => {
      /* v8 ignore next -- SyntheticModule has no dependencies, so Node never calls its linker. */
      await module.link(() => module)
      await module.evaluate()
      return module
    })()
    this.modules.set(exports, ready)
    return ready
  }
}
