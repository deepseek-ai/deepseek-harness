import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CliCommandExecutor, CliCommandResult, CliRunOptions } from './executor.ts'
import type { CliAccountView, CliCommandFailure, CliOperation, CliOperationId, CliOperationResult } from './types.ts'

export interface CliOperationControl<Phase extends string, Command extends string> {
  stage(phase: Phase | 'checking'): void
  offer(url: string): void
  run(command: Command, args: readonly string[], signal: AbortSignal, options?: CliRunOptions): Promise<CliCommandResult>
}

export interface CliAccountRuntimeOptions<Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure> {
  readonly name: string
  readonly cli: CliCommandExecutor
  readonly logger: Context['logger']
  readonly account: Account
  readonly check: Kind
  readonly cancellable: readonly Phase[]
  readonly authorizationHosts: readonly string[]
  readonly classify: (command: Failure['command'], result: CliCommandResult) => Failure
}

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

export abstract class CliAccountRuntime<
  Account, Kind extends string, Phase extends string, Failure extends CliCommandFailure = CliCommandFailure,
> {
  private account: Account
  private active: Operation<Kind, Phase, Failure> | undefined
  private result: CliOperationResult<Kind, Failure> | undefined
  private readonly cancellable: ReadonlySet<string>
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  constructor(private readonly options: CliAccountRuntimeOptions<Account, Kind, Phase, Failure>) {
    this.account = options.account
    this.cancellable = new Set(options.cancellable)
  }

  protected abstract perform(kind: Kind, control: CliOperationControl<Phase, Failure['command']>, signal: AbortSignal): Promise<void>

  protected publish(account: Account): void {
    this.account = account
    this.changed()
  }

  snapshot(): CliAccountView<Account, Kind, Phase, Failure> {
    return {
      account: this.account,
      ...this.active === undefined ? {} : { operation: this.active.view() },
      ...this.result === undefined ? {} : { result: this.result },
    }
  }

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

  refresh(): void {
    if (this.active === undefined && !this.lifetime.signal.aborted) this.start(this.options.check)
  }

  async cancel(id: CliOperationId): Promise<void> {
    const operation = this.active
    if (operation?.id !== id || !operation.canCancel) return
    this.interrupt(operation)
    await operation.done
  }

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
