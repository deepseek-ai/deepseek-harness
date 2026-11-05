/** Select one child evaluator without process-lifetime policy. */
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import { createAsyncFunctionEvaluator } from './async-function.ts'
import { createReplEvaluator } from './repl.ts'
import { createVmScriptEvaluator } from './vm-script.ts'
import type { ProgramEvaluator, ProgramEvaluatorOptions, ProgramImportHandler } from './types.ts'

const evaluators: Record<PtcProgramFormat, (options: ProgramEvaluatorOptions) => ProgramEvaluator> = {
  'function-body': createAsyncFunctionEvaluator,
  repl: createReplEvaluator,
  script: createVmScriptEvaluator,
}

/**
 * Create the selected evaluator for either a fresh or retained process.
 * @param format - Evaluation syntax selected by the host.
 * @param reportError - Asynchronous diagnostics attributed to the active evaluation.
 * @param importHandler - Runner-local import handling; omission uses Node's loader.
 * @returns Globals, evaluation entry point, and resource cleanup.
 */
export function createProgramEvaluator(
  format: PtcProgramFormat, reportError: (message: string) => void, importHandler?: ProgramImportHandler,
): ProgramEvaluator {
  return evaluators[format]({ reportError, ...importHandler === undefined ? {} : { importHandler } })
}
