/** Existing retained bootstrap entry delegates to the shared Node evaluation loop. */
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import type { Duplex } from 'node:stream'
import { runNodeMain } from './process.ts'
import type { ProgramProcess } from './process.ts'
import type { ProgramImportHandler } from './evaluators/types.ts'

/**
 * Serve evaluations through the installed retained-bootstrap entry.
 * @param stream - Inherited private control endpoint.
 * @param maxMessageBytes - Maximum control frame and queued output bytes.
 * @param processState - Native child process; structural test doubles do not replace Node's globals or built-in exports.
 * @param format - Default syntax for hosts that omit it from program data.
 * @param importHandler - Runner-local import decisions; omission retains native loading.
 * @returns After control closure and evaluator cleanup.
 */
export function runPersistentMain(
  stream: Duplex, maxMessageBytes: number, processState: ProgramProcess, format: PtcProgramFormat = 'repl',
  importHandler?: ProgramImportHandler,
): Promise<void> {
  return runNodeMain(stream, maxMessageBytes, processState, format, importHandler)
}
