/** Add exit metadata without changing Vitest's fork scheduling or failure handling. */
import type { ChildProcess } from 'node:child_process'
import { ForksPoolWorker } from 'vitest/node'
import type { PoolOptions, PoolRunnerInitializer, WorkerRequest, WorkerResponse } from 'vitest/node'

const FINISHED_RESPONSE_TYPE: WorkerResponse['type'] = 'testfileFinished'

/**
 * Attribute only outstanding requests; stop silences exits, while cancel and a
 * worker error observed before that stop do not.
 */
class DiagnosticForkWorker extends ForksPoolWorker {
  private expectedExit = false
  private observing = false
  private workerErrored = false
  private request: Extract<WorkerRequest, { type: 'run' | 'collect' }> | undefined
  private readonly reportExit: (this: ChildProcess | undefined, code: number | null, signal?: NodeJS.Signals | null) => void
  private readonly observeError: () => void

  constructor(options: PoolOptions) {
    super(options)
    const report = (child: ChildProcess | undefined, code: number | null, signal: NodeJS.Signals | null | undefined): void => {
      if (this.expectedExit) return
      options.project.vitest.logger.error(`coverage-worker-exit: ${JSON.stringify({
        pid: child?.pid ?? null,
        project: options.project.name,
        workerId: this.request?.context.workerId ?? null,
        files: this.request?.context.files.map(file => file.filepath) ?? [],
        exitCode: code,
        signalCode: signal ?? null,
      })}`)
    }
    // ForksPoolWorker.on forwards Node ChildProcess events and their receiver.
    this.reportExit = function (code, signal) { report(this, code, signal) }
    this.observeError = () => {
      // A channel that closed under a send means the worker is not shutting down
      // orderly, so the exit that follows keeps its code and signal. A stop
      // requested before this error still silences that exit.
      if (!this.expectedExit) this.workerErrored = true
    }
  }

  override async start(): Promise<void> {
    await super.start()
    this.on('exit', this.reportExit)
    this.on('error', this.observeError)
    this.observing = true
  }

  override send(message: WorkerRequest): void {
    if (message.type === 'run' || message.type === 'collect') this.request = message
    if (message.type === 'stop' && !this.workerErrored) this.expectedExit = true
    super.send(message)
  }

  /** Vitest routes worker responses here; completion covers the whole run/collect request. */
  override deserialize(data: unknown): unknown {
    const response = super.deserialize(data)
    if (typeof response === 'object' && response !== null
      && '__vitest_worker_response__' in response && response.__vitest_worker_response__ === true
      && 'type' in response && response.type === FINISHED_RESPONSE_TYPE) {
      this.request = undefined
    }
    return response
  }

  override async stop(): Promise<void> {
    // A worker that already errored is not shutting down orderly; keep the exit
    // observer so its code and signal still reach the coverage log.
    if (!this.workerErrored) {
      this.expectedExit = true
      if (this.observing) {
        this.off('exit', this.reportExit)
        this.observing = false
      }
    }
    await super.stop()
  }
}

/** Fork pool with additive process-exit diagnostics for coverage partitions. */
export const coverageForkPool: PoolRunnerInitializer = {
  name: 'coverage-forks',
  createPoolWorker: options => new DiagnosticForkWorker(options),
}
