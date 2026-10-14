import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { WecomOperationId, WecomState } from '@deepseek-ai/dsh-wecom-cli/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'

export const WECOM_PACKAGE = '@deepseek-ai/dsh-wecom'

export interface ConnectionNotice {
  readonly seq: number
  readonly kind: 'connected' | 'action-failed'
}

export interface ConnectionSnapshot {
  readonly wecom: WecomState | undefined
  readonly linked: boolean
  readonly stopped: boolean
  readonly busy: boolean
  readonly notice: ConnectionNotice | undefined
}

export type ConnectionStep = 'authorizing' | 'connecting'

export type ConnectionPresentation =
  | { readonly phase: 'checking' | 'stopped' }
  | { readonly phase: 'disconnected' | 'unavailable' | 'connected'; readonly failed: boolean }
  | {
    readonly phase: 'connecting'
    readonly step: ConnectionStep
    readonly operation: WecomOperationId
    readonly url: string | undefined
    readonly cancellable: boolean
  }

export interface ConnectionFace {
  hooks: { wecomConnection: HostObservable<ConnectionSnapshot> }
  check(): void
  connect(): void
  cancel(): void
  openAuthorization(): void
  retry(): void
  dismissNotice(): void
}

export function presentConnection(snapshot: Pick<ConnectionSnapshot, 'wecom' | 'stopped'>): ConnectionPresentation {
  if (snapshot.stopped) return { phase: 'stopped' }
  const state = snapshot.wecom
  const operation = state?.operation
  if (state === undefined || operation?.kind === 'check') return { phase: 'checking' }
  if (operation !== undefined) {
    return {
      phase: 'connecting',
      step: operation.phase === 'authorizing' ? 'authorizing' : 'connecting',
      operation: operation.id,
      url: operation.authorizationUrl,
      cancellable: operation.phase !== 'cancelling',
    }
  }
  const failed = state.result?.outcome === 'failed'
  switch (state.account.state) {
    case 'unchecked': return failed ? { phase: 'unavailable', failed } : { phase: 'checking' }
    case 'unauthorized': return { phase: 'disconnected', failed }
    case 'authorized': return { phase: 'connected', failed }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(state.account.state)
  }
}

function openAuthorizationPage(url: string | undefined): void {
  if (url !== undefined && URL.canParse(url) && new URL(url).protocol === 'https:') window.open(url, '_blank', 'noopener,noreferrer')
}

async function settle<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export class WecomConnection {
  readonly state: SnapshotStore<ConnectionSnapshot> = createSnapshotStore<ConnectionSnapshot>({
    wecom: undefined, linked: false, stopped: false, busy: false, notice: undefined,
  })

  private started: WecomOperationId | undefined
  private readonly opened = new Set<string>()
  private seq = 0
  private disposed = false
  private stream!: RemoteStream<WecomState>
  private observing!: Promise<void>

  constructor(private readonly ctx: Context) {
    this.subscribe()
  }

  face(): ConnectionFace {
    return {
      hooks: { wecomConnection: this.state },
      check: () => { void this.start(() => this.ctx.remote.wecom.check()) },
      connect: () => { void this.start(() => this.ctx.remote.wecom.connect()) },
      cancel: () => { void this.cancel() },
      openAuthorization: () => {
        const shown = presentConnection(this.state.getSnapshot())
        if (shown.phase === 'connecting') openAuthorizationPage(shown.url)
      },
      retry: () => { void this.retry() },
      dismissNotice: () => { this.patch({ notice: undefined }) },
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stream.dispose()
    await this.observing
  }

  private subscribe(): void {
    this.stream = this.ctx.remote.$stream<WecomState>({
      name: 'WeCom connection', open: signal => this.ctx.remote.wecom.follow(signal),
      ended: () => new Error('WeCom connection stream ended'),
      carrierFailed: () => { this.patch({ linked: false }) },
    })
    this.observing = this.observe(this.stream)
  }

  private async observe(stream: RemoteStream<WecomState>): Promise<void> {
    try {
      for await (const item of stream) {
        this.patch({ wecom: item.value, linked: true })
        this.follow(item.value)
        item.accept()
      }
    } catch {
      if (!this.disposed) this.patch({ linked: false, stopped: true })
    }
  }

  private async retry(): Promise<void> {
    if (this.disposed || !this.state.getSnapshot().stopped) return
    await this.stream.dispose()
    await this.observing
    this.patch({ wecom: undefined, stopped: false })
    this.subscribe()
  }

  private follow(state: WecomState): void {
    const operation = state.operation
    if (operation !== undefined && operation.id === this.started && operation.authorizationUrl !== undefined
      && !this.opened.has(operation.authorizationUrl)) {
      this.opened.add(operation.authorizationUrl)
      openAuthorizationPage(operation.authorizationUrl)
    }
    const result = state.result
    if (result === undefined || result.id !== this.started) return
    this.started = undefined
    if (result.outcome === 'succeeded' && result.kind === 'connect') this.notify('connected')
  }

  private async start(call: () => Promise<RemoteResult<WecomOperationId>>): Promise<void> {
    await this.run(async () => {
      this.started = await settle(call())
      const current = this.state.getSnapshot().wecom
      if (current !== undefined) this.follow(current)
    })
  }

  private async cancel(): Promise<void> {
    const shown = presentConnection(this.state.getSnapshot())
    if (shown.phase !== 'connecting' || !shown.cancellable) return
    await this.run(async () => { await settle(this.ctx.remote.wecom.cancel(shown.operation)) })
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.patch({ busy: true })
    try {
      await operation()
    } catch {
      this.notify('action-failed')
    } finally {
      this.patch({ busy: false })
    }
  }

  private patch(change: Partial<ConnectionSnapshot>): void {
    this.state.set({ ...this.state.getSnapshot(), ...change })
  }

  private notify(kind: ConnectionNotice['kind']): void {
    if (this.disposed) return
    this.seq += 1
    this.patch({ notice: { seq: this.seq, kind } })
  }
}
