/** Existing retained bootstrap entry delegates to the shared Node evaluation loop. */
import type { Duplex } from 'node:stream'
import { runNodeMain } from './process.ts'
import type { ProgramProcess } from './process.ts'

/**
 * Serve evaluations through the installed retained-bootstrap entry.
 * @param stream - Inherited private control endpoint.
 * @param maxMessageBytes - Maximum control frame and queued output bytes.
 * @param processState - Child environment, output and directory control.
 * @returns After control closure and evaluator cleanup.
 */
export function runPersistentMain(
  stream: Duplex, maxMessageBytes: number, processState: ProgramProcess,
): Promise<void> {
  return runNodeMain(stream, maxMessageBytes, processState, 'repl')
}
