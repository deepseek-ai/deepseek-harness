import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { WecomCli } from './cli.ts'
import type { WecomAccountState, WecomOperationId, WecomOperationResult, WecomOperationState, WecomState } from './types.ts'

const AUTHORIZATION_LINK = /^\s*(https:\/\/\S+)\s*$/u
const AUTHORIZATION_HOST = 'work.weixin.qq.com'

export interface WecomAccountLimits {
  commandTimeoutMs: number
  authorizationTimeoutMs: number
}

class Operation {
  readonly id = brandString<WecomOperationId>(randomUUID())
  readonly controller = new AbortController()
  phase: WecomOperationState['phase'] = 'checking'
  authorizationUrl: string | undefined
  done: Promise<void> = Promise.resolve()

  constructor(readonly kind: WecomOperationState['kind']) {}

  view(): WecomOperationState {
    const link = this.authorizationUrl === undefined ? {} : { authorizationUrl: this.authorizationUrl }
    return { id: this.id, kind: this.kind, phase: this.phase, ...link }
  }
}

export class WecomAccount {
  private account: WecomAccountState = { state: 'unchecked' }
  private active: Operation | undefined
  private result: WecomOperationResult | undefined
  private readonly lifetime = new AbortController()

  constructor(
    private readonly cli: WecomCli,
    private readonly limits: WecomAccountLimits,
    private readonly changed: () => void,
  ) {}

  snapshot(): WecomState {
    return {
      account: this.account,
      ...this.active === undefined ? {} : { operation: this.active.view() },
      ...this.result === undefined ? {} : { result: this.result },
    }
  }

  start(kind: WecomOperationState['kind']): WecomOperationId {
    this.lifetime.signal.throwIfAborted()
    if (this.active !== undefined) throw new Error('wecom: another account operation is in progress')
    const operation = new Operation(kind)
    this.active = operation
    this.result = undefined
    operation.done = this.execute(operation)
    this.changed()
    return operation.id
  }

  refresh(): void {
    if (this.active === undefined && !this.lifetime.signal.aborted) this.start('check')
  }

  async cancel(id: WecomOperationId): Promise<void> {
    const operation = this.active
    if (operation?.id !== id) return
    this.interrupt(operation)
    await operation.done
  }

  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('wecom: plugin disposed'))
    const operation = this.active
    if (operation === undefined) return
    this.interrupt(operation)
    await operation.done
  }

  private interrupt(operation: Operation): void {
    operation.controller.abort(new Error('wecom: account operation cancelled'))
    operation.phase = 'cancelling'
    operation.authorizationUrl = undefined
    this.changed()
  }

  private async execute(operation: Operation): Promise<void> {
    let outcome: WecomOperationResult['outcome'] = 'succeeded'
    try {
      await this.perform(operation, AbortSignal.any([operation.controller.signal, this.lifetime.signal]))
    } catch {
      outcome = operation.controller.signal.aborted ? 'cancelled' : 'failed'
    } finally {
      this.active = undefined
      this.result = { id: operation.id, kind: operation.kind, outcome }
      this.changed()
    }
  }

  private async perform(operation: Operation, signal: AbortSignal): Promise<void> {
    switch (operation.kind) {
      case 'check':
        await this.check(signal)
        return
      case 'connect': return this.connect(operation, signal)
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(operation.kind)
    }
  }

  private async connect(operation: Operation, signal: AbortSignal): Promise<void> {
    this.stage(operation, 'authorizing')
    const init = await this.cli.run(['auth', 'init', '--noninteractive', '--no-browser'], signal, {
      timeoutMs: this.limits.authorizationTimeoutMs,
      onLine: (stream, line) => {
        const link = stream === 'stdout' && operation.authorizationUrl === undefined ? AUTHORIZATION_LINK.exec(line) : null
        if (link !== null) this.offer(operation, link[1] as string)
      },
    })
    if (init.exitCode !== 0) throw new Error('wecom: auth init failed')
    this.stage(operation, 'verifying')
    if ((await this.check(signal)).state !== 'authorized') throw new Error('wecom: auth init left no authorization')
  }

  private async check(signal: AbortSignal): Promise<WecomAccountState> {
    const result = await this.cli.run(['auth', 'show', '--status'], signal, { timeoutMs: this.limits.commandTimeoutMs })
    const status = result.stdout.trim()
    if (result.exitCode !== 0 || (status !== 'authorized' && status !== 'unauthorized')) {
      throw new Error('wecom: auth show --status failed')
    }
    this.account = { state: status }
    this.changed()
    return this.account
  }

  private stage(operation: Operation, phase: WecomOperationState['phase']): void {
    operation.controller.signal.throwIfAborted()
    operation.phase = phase
    operation.authorizationUrl = undefined
    this.changed()
  }

  private offer(operation: Operation, value: string): void {
    if (operation.controller.signal.aborted || !URL.canParse(value)) return
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname !== AUTHORIZATION_HOST) return
    operation.authorizationUrl = url.href
    this.changed()
  }
}
