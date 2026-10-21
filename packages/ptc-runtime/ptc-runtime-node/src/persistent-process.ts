/** Existing retained bootstrap entry delegates to the shared Node evaluation loop. */
import type { Duplex } from 'node:stream'
import { runNodeMain } from './process.ts'
import type { ProgramProcess } from './process.ts'
import type { ProgramFormat, ProgramImportHandler } from './evaluators/types.ts'

/** Process state required by retained bootstraps that change cwd between evaluations. */
export interface PersistentProcess extends ProgramProcess {
  chdir(directory: string): void
}

/**
 * Serve evaluations through the installed retained-bootstrap entry.
 * @param stream - Inherited private control endpoint.
 * @param maxMessageBytes - Maximum control frame and queued output bytes.
 * @param processState - Child environment, output and directory control.
 * @param format - Default syntax for hosts that omit it from program data.
 * @param importHandler - Runner-local import decisions; omission retains native loading.
 * @returns After control closure and evaluator cleanup.
 */
export function runPersistentMain(
  stream: Duplex, maxMessageBytes: number, processState: PersistentProcess, format: ProgramFormat = 'repl',
  importHandler?: ProgramImportHandler,
): Promise<void> {
  return runNodeMain(stream, maxMessageBytes, processState, format, importHandler)
}
