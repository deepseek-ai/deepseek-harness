/** One CLI plugin's account operations: one at a time, Host-owned, with a credential-free view that observers reread after each change. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ConnectorAccountSource, ConnectorOperation, ConnectorOperationId, ConnectorOperationResult,
} from '@deepseek-ai/dsh-client-ui-connector-account/types'
import type { CliCommandExecutor, CliCommandResult, CliRunOptions } from './executor.ts'
import type { CliAccountRegistration, CliAccountView, CliCommandFailure, CliOperationControl } from './types.ts'

/** The registration fields the runtime reads, and the executor and logger it works through. */
export type CliAccountRuntimeOptions<Account, Kind extends string, Phase extends string, Command extends string> =
  & Pick<
    CliAccountRegistration<Account, Kind, Phase, Command, string>,
    'name' | 'account' | 'check' | 'cancellable' | 'authorizationHosts' | 'perform'
  >
  & {
    /** The executor the runtime runs commands with and disposes with itself. */
    readonly executor: CliCommandExecutor
    readonly logger: Context['logger']
  }

/**
 * List the last command of a failed operation as the diagnostic items a Plugins page failure shows after the plugin's
 * guidance.
 * @param failure - the last command a failed operation ran and its exit code.
 * @returns the command, then its exit code when it has one, such as `login` and `exit 3`; untranslated.
 */
export function failureDetails(failure: CliCommandFailure): string[] {
  return failure.exitCode === null ? [failure.command] : [failure.command, `exit ${failure.exitCode}`]
}

class Operation<Kind extends string, Phase extends string, Command extends string> {
  readonly id = brandString<ConnectorOperationId>(randomUUID())
  readonly controller = new AbortController()
  phase: Phase | 'checking' | 'cancelling' = 'checking'
  authorizationUrl: string | undefined
  failure: CliCommandFailure<Command> | undefined
  done: Promise<void> = Promise.resolve()

  constructor(readonly kind: Kind, private readonly cancellable: ReadonlySet<string>) {}

  get canCancel(): boolean {
    return this.cancellable.has(this.phase)
  }

  view(): ConnectorOperation<Kind, Phase | 'checking' | 'cancelling'> {
    const link = this.authorizationUrl === undefined ? {} : { authorizationUrl: this.authorizationUrl }
    return { id: this.id, kind: this.kind, phase: this.phase, cancellable: this.canCancel, ...link }
  }
}

/**
 * Runs at most one account operation at a time; observers see it without owning it, and the Service registers it as
 * the plugin's Plugins page account source. A failed operation logs and returns only its last command and that
 * command's exit code, because exceptions and native output may contain credentials.
 */
export class CliAccountRuntime<
  Account, Kind extends string, Phase extends string, Command extends string,
> implements ConnectorAccountSource<CliAccountView<Account, Kind, Phase, Command>> {
  private account: Account
  private active: Operation<Kind, Phase, Command> | undefined
  private result: ConnectorOperationResult<Kind, CliCommandFailure<Command>> | undefined
  private readonly cancellable: ReadonlySet<string>
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  /** @param options - the plugin's registration fields, executor, and logger. */
  constructor(private readonly options: CliAccountRuntimeOptions<Account, Kind, Phase, Command>) {
    this.account = options.account
    this.cancellable = new Set(options.cancellable)
  }

  /**
   * Replace the account the view reports and notify subscribers.
   * @param account - the account the latest check observed.
   */
  publish(account: Account): void {
    this.account = account
    this.changed()
  }

  /**
   * Read the account, the active operation, and the last result.
   * @returns a view without credentials.
   */
  snapshot(): CliAccountView<Account, Kind, Phase, Command> {
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
  start(kind: Kind): ConnectorOperationId {
    this.lifetime.signal.throwIfAborted()
    if (this.active !== undefined) throw new Error(`${this.options.name}: another account operation is in progress`)
    const operation = new Operation<Kind, Phase, Command>(kind, this.cancellable)
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
  async cancel(id: ConnectorOperationId): Promise<void> {
    const operation = this.active
    if (operation?.id !== id || !operation.canCancel) return
    this.interrupt(operation)
    await operation.done
  }

  /**
   * Call `listener` after each change of the view, without starting a check. An exception a listener throws is logged
   * and stops neither the other listeners nor the operation or call that changed the view.
   * @param listener - called synchronously after the account, operation, or result changes.
   * @returns a disposer that stops the calls.
   */
  observe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
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
      await this.options.executor.dispose()
    }
  }

  private changed(): void {
    for (const notify of this.listeners) {
      try {
        notify()
      } catch (error) {
        this.options.logger.error(`${this.options.name}: account observer failed: %o`, error)
      }
    }
  }

  private interrupt(operation: Operation<Kind, Phase, Command>): void {
    operation.controller.abort(new Error(`${this.options.name}: account operation cancelled`))
    operation.phase = 'cancelling'
    operation.authorizationUrl = undefined
    this.changed()
  }

  private async execute(operation: Operation<Kind, Phase, Command>): Promise<void> {
    let outcome: ConnectorOperationResult<Kind>['outcome'] = 'succeeded'
    let failure: CliCommandFailure<Command> | undefined
    const control: CliOperationControl<Account, Phase, Command> = {
      stage: (phase) => { this.stage(operation, phase) },
      offer: url => this.offer(operation, url),
      run: (command, args, signal, options) => this.run(operation, command, args, signal, options),
      publish: (account) => { this.publish(account) },
    }
    try {
      await this.options.perform(operation.kind, control, AbortSignal.any([operation.controller.signal, this.lifetime.signal]))
    } catch (_error) {
      // Exceptions and native output may contain credentials; report only the last command and its exit code.
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
    operation: Operation<Kind, Phase, Command>, command: Command, args: readonly string[],
    signal: AbortSignal, options?: CliRunOptions,
  ): Promise<CliCommandResult> {
    operation.failure = { command, exitCode: null }
    const result = await this.options.executor.run(args, signal, options)
    operation.failure = { command, exitCode: result.exitCode }
    return result
  }

  private stage(operation: Operation<Kind, Phase, Command>, phase: Phase | 'checking'): void {
    operation.controller.signal.throwIfAborted()
    operation.phase = phase
    operation.authorizationUrl = undefined
    this.changed()
  }

  private offer(operation: Operation<Kind, Phase, Command>, value: string): boolean {
    if (operation.controller.signal.aborted || !URL.canParse(value)) return false
    const url = new URL(value)
    const trusted = url.protocol === 'https:' && url.username === '' && url.password === ''
      && this.options.authorizationHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
    if (!trusted) return false
    operation.authorizationUrl = url.href
    this.changed()
    return true
  }
}
