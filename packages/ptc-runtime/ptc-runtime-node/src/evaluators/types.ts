/** Evaluation results and operations shared by the three child evaluators. */

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
