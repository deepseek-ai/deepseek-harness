/** Evaluation syntax and operations shared by the three child evaluators. */
/** Supported child evaluation syntax, independent of process lifetime. */
export type ProgramFormat = 'function-body' | 'repl' | 'script'

/** A dynamic import requested by a program in the runner process. */
export interface ProgramImportRequest {
  /** Specifier after JavaScript's import argument conversion. */
  specifier: string
  /** Absolute filename of the program that contains this import, retained with its functions. */
  referrer: string
  /** Import attributes supplied by the program, or an empty object. */
  attributes: Readonly<Record<string, string | undefined>>
}

/** Runner-owned handling of one dynamic import. */
export type ProgramImportResult =
  | { type: 'default' }
  | { type: 'redirect'; specifier: string }
  | {
    type: 'module'
    /**
     * Own enumerable string properties become exports, including `default`.
     * Values stay in this process and retain their identity, prototypes and closures.
     * One exports object identifies one module per evaluator; names and values are read once.
     */
    exports: Record<string, unknown>
  }

/**
 * Intercept program imports inside the runner, independently of evaluation syntax.
 * Default and redirected imports use Node's loader without reentering this handler.
 * A thrown or rejected value rejects the program's import; there is no fallback after failure.
 * VM Script accepts async handlers and requires --experimental-vm-modules.
 * AsyncFunction and Node REPL require synchronous decisions and no VM startup flag.
 * @param request - Specifier, original program filename and import attributes.
 * @returns Native loading, one native redirect, or runner-local module exports.
 */
export type ProgramImportHandler = (request: ProgramImportRequest) => ProgramImportResult | Promise<ProgramImportResult>

/** Runner capabilities supplied to every evaluator. */
export interface ProgramEvaluatorOptions {
  /** Asynchronous diagnostics attributed to the active evaluation. */
  reportError: (message: string) => void
  /** Omission uses native imports; AsyncFunction and Node REPL require synchronous decisions. */
  importHandler?: ProgramImportHandler
}

/** One evaluation's completion or thrown value. */
type EvaluationResult = { ok: true; value: unknown } | { ok: false; error: unknown }

/** Program globals and resources owned by one evaluator. */
export interface ProgramEvaluator {
  /** Mutable globals populated with the current evaluation's bindings. */
  globals: Record<string, unknown>
  /**
   * Evaluate source and deliver its result after any supported asynchronous work.
   * @param code - Type-stripped program in the selected syntax.
   * @param finish - Callback receiving the completion or exception.
   */
  evaluate(code: string, finish: (result: EvaluationResult) => void): void
  /** Release evaluator-owned resources after evaluation or process shutdown. */
  close(): void
}
