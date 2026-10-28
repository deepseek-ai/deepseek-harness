/** Controllable tunnel worker process for the supervisor unit bench. */

import type { TunnelWorkerEvent } from '@deepseek-ai/dsh-experimental-liveshare-protocol'
import type { TunnelProcessCommand, TunnelWorkerInput } from '../src/host/tunnel-worker.ts'

/** One worker the supervisor started, driven by the spec. */
export class FakeTunnelWorker {
  /** Every worker the supervisor constructed. */
  static readonly instances: FakeTunnelWorker[] = []

  /** Commands the supervisor sent. */
  readonly sent: TunnelWorkerInput[] = []

  /** Events the supervisor would receive from the process. */
  listener: ((event: TunnelWorkerEvent) => void) | undefined

  started = false
  stopped = false

  /**
   * Record one construction.
   * @param options Command the supervisor chose.
   */
  constructor(readonly options: { readonly command: TunnelProcessCommand }) {
    FakeTunnelWorker.instances.push(this)
  }

  /**
   * Subscribe the supervisor.
   * @param listener Event sink.
   * @returns Disposer.
   */
  onEvent(listener: (event: TunnelWorkerEvent) => void): () => void {
    this.listener = listener
    return () => { this.listener = undefined }
  }

  /** Mark the process started. */
  start(): void {
    this.started = true
  }

  /**
   * Record one command.
   * @param command Command to carry out.
   */
  send(command: TunnelWorkerInput): void {
    this.sent.push(command)
  }

  /** Mark the process stopped. */
  async stop(): Promise<void> {
    this.stopped = true
  }

  /**
   * Deliver one worker event.
   * @param event Event the process reported.
   */
  emit(event: Record<string, unknown>): void {
    this.listener?.(event as never)
  }
}
