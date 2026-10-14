import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CliCommandExecutor } from './executor.ts'
import type { CliAccountView, CliOperation, CliOperationId, CliOperationResult } from './types.ts'

export interface CliOperationControl<Phase extends string> {
  stage(phase: Phase | 'checking'): void
  offer(url: string): void
}

export interface CliAccountRuntimeOptions<Account, Kind extends string, Phase extends string> {
  readonly name: string
  readonly cli: CliCommandExecutor
  readonly logger: Context['logger']
  readonly account: Account
  readonly check: Kind
  readonly cancellable: readonly Phase[]
  readonly authorizationHosts: readonly string[]
}

class Operation<Kind extends string, Phase extends string> {
  readonly id = brandString<CliOperationId>(randomUUID())
  readonly controller = new AbortController()
  phase: Phase | 'checking' | 'cancelling' = 'checking'
  authorizationUrl: string | undefined
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

export abstract class CliAccountRuntime<Account, Kind extends string, Phase extends string> {
  protected readonly cli: CliCommandExecutor
  private account: Account
  private active: Operation<Kind, Phase> | undefined
  private result: CliOperationResult<Kind> | undefined
  private readonly cancellable: ReadonlySet<string>
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()

  constructor(private readonly options: CliAccountRuntimeOptions<Account, Kind, Phase>) {
    this.cli = options.cli
    this.account = options.account
    this.cancellable = new Set(options.cancellable)
  }

  protected abstract perform(kind: Kind, control: CliOperationControl<Phase>, signal: AbortSignal): Promise<void>

  protected publish(account: Account): void {
    this.account = account
    this.changed()
  }

  snapshot(): CliAccountView<Account, Kind, Phase> {
    return {
      account: this.account,
      ...this.active === undefined ? {} : { operation: this.active.view() },
      ...this.result === undefined ? {} : { result: this.result },
    }
  }

  start(kind: Kind): CliOperationId {
    this.lifetime.signal.throwIfAborted()
    if (this.active !== undefined) throw new Error(`${this.options.name}: another account operation is in progress`)
    const operation = new Operation<Kind, Phase>(kind, this.cancellable)
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

  async *follow(signal: AbortSignal): AsyncIterable<CliAccountView<Account, Kind, Phase>> {
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
      await this.cli.dispose()
    }
  }

  private changed(): void {
    for (const notify of this.listeners) notify()
  }

  private interrupt(operation: Operation<Kind, Phase>): void {
    operation.controller.abort(new Error(`${this.options.name}: account operation cancelled`))
    operation.phase = 'cancelling'
    operation.authorizationUrl = undefined
    this.changed()
  }

  private async execute(operation: Operation<Kind, Phase>): Promise<void> {
    let outcome: CliOperationResult<Kind>['outcome'] = 'succeeded'
    const control: CliOperationControl<Phase> = {
      stage: (phase) => { this.stage(operation, phase) },
      offer: (url) => { this.offer(operation, url) },
    }
    try {
      await this.perform(operation.kind, control, AbortSignal.any([operation.controller.signal, this.lifetime.signal]))
    } catch (error) {
      outcome = operation.controller.signal.aborted ? 'cancelled' : 'failed'
      if (outcome === 'failed') this.options.logger.warn(`${this.options.name}: ${operation.kind} failed: ${String(error)}`)
    } finally {
      this.active = undefined
      this.result = { id: operation.id, kind: operation.kind, outcome }
      this.changed()
    }
  }

  private stage(operation: Operation<Kind, Phase>, phase: Phase | 'checking'): void {
    operation.controller.signal.throwIfAborted()
    operation.phase = phase
    operation.authorizationUrl = undefined
    this.changed()
  }

  private offer(operation: Operation<Kind, Phase>, value: string): void {
    if (operation.controller.signal.aborted || !URL.canParse(value)) return
    const url = new URL(value)
    const trusted = url.protocol === 'https:' && url.username === '' && url.password === ''
      && this.options.authorizationHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))
    if (!trusted) return
    operation.authorizationUrl = url.href
    this.changed()
  }
}
