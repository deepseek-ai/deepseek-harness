/** One controllable child process standing in for the tunnel worker. */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

/** The child surface the supervisor reads and drives. */
export class FakeTunnelChild extends EventEmitter {
  /** Every child the supervisor spawned, in order. */
  static readonly spawned: FakeTunnelChild[] = []

  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly sent: unknown[] = []
  readonly kills: string[] = []
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly pid = 4242

  /**
   * Record one spawn.
   * @param executable Node executable the supervisor chose.
   * @param args argv handed to the worker.
   */
  constructor(readonly executable: string, readonly args: readonly string[]) {
    super()
    FakeTunnelChild.spawned.push(this)
  }

  /**
   * Record one IPC command.
   * @param message Command the supervisor sent.
   * @returns Whether the other side accepted it.
   */
  send(message: unknown): boolean {
    this.sent.push(message)
    return true
  }

  /**
   * Record one signal.
   * @param signal Signal the supervisor sent.
   */
  kill(signal: string): boolean {
    this.kills.push(signal)
    return true
  }

  /**
   * Report a successful exit.
   * @param code Exit code.
   */
  exit(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}
