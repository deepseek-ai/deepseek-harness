/** One CLI plugin's account operations: one at a time, Host-owned, observable by any number of Remote subscribers. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CliCommandExecutor, CliCommandResult, CliRunOptions } from './executor.ts'
import type { CliAccountView, CliCommandFailure, CliOperation, CliOperationId, CliOperationResult } from './types.ts'

/** What a plugin's operation may do while it runs. */
export interface CliOperationControl<Phase extends string, Command extends string> {
  /**
   * Enter a phase and withdraw the current link.
   * @param phase - the plugin's phase, or `checking` for a check that follows another step.
   * @throws the cancellation reason after the operation was cancelled.
   */
  stage(phase: Phase | 'checking'): void
  /**
   * Offer an authorization link to the page; an untrusted, malformed, or late link is ignored.
   * @param url - an HTTPS URL on one of the plugin's authorization hosts or their subdomains, without credentials.
   */
  offer(url: string): void
  /**
   * Run one command and record its classification as the operation's failure if the operation then fails.
   * @param command - the plugin's identifier for the command.
   * @param args - native arguments without the executable.
   * @param signal - the operation's signal.
   * @param options - the deadline choice and an output-line observer.
   * @returns the command's exit code and output, whatever the exit code.
   * @throws what {@link CliCommandExecutor.run} throws.
   */
  run(command: Command, args: readonly string[], signal: AbortSignal, options?: CliRunOptions): Promise<CliCommandResult>
}

/** A plugin's account identity, executor, and rules. */
export interface CliAccountRuntimeOptions<Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure> {
  /** Prefix for errors and log records, such as `wecom`. */
  readonly name: string
  /** The executor the runtime runs commands with and disposes with itself. */
  readonly cli: CliCommandExecutor
  readonly logger: Context['logger']
  /** The account before the first check. */
  readonly account: Account
  /** The operation each new subscriber starts when none runs. */
  readonly check: Kind
  /** The plugin phases in which `cancel` stops an operation; the runtime's own phases are never cancellable. */
  readonly cancellable: readonly Phase[]
  /** Hosts whose HTTPS links, and their subdomains' links, may reach the page. */
  readonly authorizationHosts: readonly string[]
  /**
   * Keep only safe, allowlisted facts from a command result; it never sees exception messages.
   * Before a command exits it receives a result with a null exit code and empty output.
   */
  readonly classify: (command: Failure['command'], result: CliCommandResult) => Failure
}

/**
 * Classify a command by its exit code alone, for CLIs whose error output has no safe structure.
 * @param command - the plugin's identifier for the command.
 * @param result - the command's observed exit code and output.
 * @returns the command identifier and exit code.
 */
export function exitFailure<Command extends string>(command: Command, result: CliCommandResult): CliCommandFailure<Command> {
  return { command, exitCode: result.exitCode }
}

class Operation<Kind extends string, Phase extends string, Failure extends CliCommandFailure> {
  readonly id = brandString<CliOperationId>(randomUUID())
  readonly controller = new AbortController()
  phase: Phase | 'checking' | 'cancelling' = 'checking'
  authorizationUrl: string | undefined
  failure: Failure | undefined
  done: Promise<void> = Promise.resolve()

  constructor(readonly kind: Kind, private readonly cancellable: ReadonlySet<string>) {}

  get canCancel(): boolean {
    return this.cancellable.has(this.phase)
  }

  view(): CliOperation<Kind, Phase> {
    const link = this.authorizationUrl === undefined ? {} : { authorizationUrl: this.authorizationUrl }
    return { id: this.id, kind: this.kind, phase: this.phase, cancellable: this.canCancel, ...link }
  }
}

/**
 * Runs at most one account operation at a time; subscribers observe it without owning it. A failed operation logs and
 * returns only its last command's classification, because exceptions and native output may contain credentials.
 */
export abstract class CliAccountRuntime<
  Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure = CliCommandFailure,
> {
  private account: Account
  private active: Operation<Kind, Phase, Failure> | undefined
  private result: CliOperationResult<Kind, Failure> | undefined
  private readonly cancellable: ReadonlySet<string>
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param options - the plugin's account identity, executor, and rules. */
  constructor(private readonly options: CliAccountRuntimeOptions<Account, Kind, Phase, Failure>) {
    this.account = options.account
    this.cancellable = new Set(options.cancellable)
  }

  /**
   * Carry out one operation. Throwing fails it, unless the operation was cancelled.
   * @param kind - the requested operation.
   * @param control - phase changes, link offers, and classified command runs for this operation.
   * @param signal - aborts on cancellation or disposal.
   * @returns after the operation finishes.
   */
  protected abstract perform(kind: Kind, control: CliOperationControl<Phase, Failure['command']>, signal: AbortSignal): Promise<void>

  /**
   * Replace the account the view reports and notify subscribers.
   * @param account - the account the latest check observed.
   */
  protected publish(account: Account): void {
    this.account = account
    this.changed()
  }

  /**
   * Read the account, the active operation, and the last result.
   * @returns a view without credentials.
   */
  snapshot(): CliAccountView<Account, Kind, Phase, Failure> {
    return {
      account: this.account,
      ...this.active === undefined ? {} : { operation: this.active.view() },
      ...this.result === undefined ? {} : { result: this.result },
    }
  }

  /**
   * Start one operation.
   * @param kind - the requested operation.
   * @returns the operation identity.
   * @throws while another operation runs, or after disposal.
   */
  start(kind: Kind): CliOperationId {
    this.lifetime.signal.throwIfAborted()
    if (this.active !== undefined) throw new Error(`${this.options.name}: another account operation is in progress`)
    const operation = new Operation<Kind, Phase, Failure>(kind, this.cancellable)
    this.active = operation
    this.result = undefined
    operation.done = this.execute(operation)
    this.changed()
    return operation.id
  }

  /** Start a check unless an operation already runs or the runtime is disposed. */
  refresh(): void {
    if (this.active === undefined && !this.lifetime.signal.aborted) this.start(this.options.check)
  }

  /**
   * Cancel the named operation if its current phase is cancellable, and wait for it to settle.
   * @param id - the operation to cancel; a finished operation or a phase that is not cancellable is ignored.
   * @returns after the operation settles, or at once when nothing is cancelled.
   */
  async cancel(id: CliOperationId): Promise<void> {
    const operation = this.active
    if (operation?.id !== id || !operation.canCancel) return
    this.interrupt(operation)
    await operation.done
  }

  /**
   * Follow the account and its operations; each new subscriber starts a check when no operation runs.
   * @param signal - the subscriber's lifetime; disposal also ends the stream.
   * @returns the current view, then each changed view, coalescing changes that arrive before the next read.
   */
  async *follow(signal: AbortSignal): AsyncIterable<CliAccountView<Account, Kind, Phase, Failure>> {
    this.refresh()
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    let wake = Promise.withResolvers<void>()
    let changed = true
    const notify = (): void => { changed = true; wake.resolve() }
    this.listeners.add(notify)
    combined.addEventListener('abort', notify, { once: true })
    try {
      for (;;) {
        if (!changed) await wake.promise
        if (combined.aborted) break
        wake = Promise.withResolvers<void>()
        changed = false
        yield this.snapshot()
      }
    } finally {
      this.listeners.delete(notify)
      combined.removeEventListener('abort', notify)
    }
  }

  /**
   * Refuse new work, cancel the active operation, wait for it, and dispose the executor.
   * @returns after account work and owned processes stop.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error(`${this.options.name}: plugin disposed`))
    try {
      const operation = this.active
      if (operation !== undefined) {
        this.interrupt(operation)
        await operation.done
      }
    } finally {
      await this.options.cli.dispose()
    }
  }

  private changed(): void {
    for (const notify of this.listeners) notify()
  }

  private interrupt(operation: Operation<Kind, Phase, Failure>): void {
    operation.controller.abort(new Error(`${this.options.name}: account operation cancelled`))
    operation.phase = 'cancelling'
    operation.authorizationUrl = undefined
    this.changed()
  }

  private async execute(operation: Operation<Kind, Phase, Failure>): Promise<void> {
    let outcome: CliOperationResult<Kind, Failure>['outcome'] = 'succeeded'
    let failure: Failure | undefined
    const control: CliOperationControl<Phase, Failure['command']> = {
      stage: (phase) => { this.stage(operation, phase) },
      offer: (url) => { this.offer(operation, url) },
      run: (command, args, signal, options) => this.run(operation, command, args, signal, options),
    }
    try {
      await this.perform(operation.kind, control, AbortSignal.any([operation.controller.signal, this.lifetime.signal]))
    } catch (_error) {
      // Exceptions and native output may contain credentials; report only the classified command fields.
      outcome = operation.controller.signal.aborted ? 'cancelled' : 'failed'
      if (outcome === 'failed') {
        failure = operation.failure
        this.options.logger.error(`${this.options.name}: account operation failed: %o`, {
          id: operation.id, kind: operation.kind, phase: operation.phase, ...failure,
        })
      }
    } finally {
      this.active = undefined
      this.result = { id: operation.id, kind: operation.kind, outcome, ...failure === undefined ? {} : { failure } }
      this.changed()
    }
  }

  private async run(
    operation: Operation<Kind, Phase, Failure>, command: Failure['command'], args: readonly string[],
    signal: AbortSignal, options?: CliRunOptions,
  ): Promise<CliCommandResult> {
    operation.failure = this.options.classify(command, { exitCode: null, stdout: '', stderr: '' })
    const result = await this.options.cli.run(args, signal, options)
    operation.failure = this.options.classify(command, result)
    return result
  }

  private stage(operation: Operation<Kind, Phase, Failure>, phase: Phase | 'checking'): void {
    operation.controller.signal.throwIfAborted()
    operation.phase = phase
    operation.authorizationUrl = undefined
    this.changed()
  }

  private offer(operation: Operation<Kind, Phase, Failure>, value: string): void {
    if (operation.controller.signal.aborted || !URL.canParse(value)) return
    const url = new URL(value)
    const trusted = url.protocol === 'https:' && url.username === '' && url.password === ''
      && this.options.authorizationHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
    if (!trusted) return
    operation.authorizationUrl = url.href
    this.changed()
  }
}
