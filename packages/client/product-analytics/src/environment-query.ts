/** Bounded, cancellable queries of fixed operating-system metadata commands. */
import { execFile, type ChildProcess } from 'node:child_process'

/** Fixed reasons exposed instead of command output or raw errors. */
export type MissingReason = 'unavailable' | 'invalid-value' | 'query-failed' | 'timeout' | 'output-limit' | 'unsupported'

/** Successful stdout or an isolated query failure. */
export type QueryResult = { kind: 'value'; stdout: string } | { kind: 'missing'; reason: MissingReason }

/** Deployment limits and the owning analytics lifetime. */
export interface QueryOptions {
  /** Maximum execution time of each query, in milliseconds. */
  timeoutMillis: number
  /** Maximum bytes captured from either output stream. */
  maxOutputBytes: number
  /** Disposal aborts the command and waits for its close event. */
  signal: AbortSignal
}

/**
 * Execute fixed argv without a shell; failures omit only dependent metadata.
 * @param command - operating-system executable, never event-supplied text.
 * @param args - fixed metadata query arguments.
 * @param options - output/time limits and owner lifetime.
 * @returns stdout or a fixed failure reason, after the child closes.
 */
export async function queryEnvironment(command: string, args: readonly string[], options: QueryOptions): Promise<QueryResult> {
  const result = Promise.withResolvers<QueryResult>()
  let child: ChildProcess
  try {
    child = execFile(command, [...args], {
      encoding: 'utf8', windowsHide: true, signal: options.signal, killSignal: 'SIGKILL',
      timeout: options.timeoutMillis, maxBuffer: options.maxOutputBytes,
    }, (error, stdout) => {
      if (error === null) { result.resolve({ kind: 'value', stdout }); return }
      const reason = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
        : error.killed && !options.signal.aborted ? 'timeout' : 'query-failed'
      result.resolve({ kind: 'missing', reason })
    })
  } catch (_error) {
    // Synchronous OS spawn failures create no child; other queries remain owned.
    return { kind: 'missing', reason: 'query-failed' }
  }
  // execFile can report abort before stdio closes; disposal owns both settlements.
  const closed = new Promise<void>((resolve) => { child.once('close', () => { resolve() }) })
  const [output] = await Promise.all([result.promise, closed])
  return output
}
