/** Browser mirror of the Host's Feishu account and the Plugins page's connection actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { FeishuOperationId, FeishuState } from '@deepseek-ai/dsh-feishu-cli/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** The npm package whose bundle page carries the connection section. */
export const FEISHU_PACKAGE = '@deepseek-ai/dsh-feishu'

/** A transient outcome the page reports outside its own lifetime. */
export interface ConnectionNotice {
  readonly seq: number
  readonly kind: 'connected' | 'signed-out' | 'action-failed'
}

/** The page's whole view: the Host's account view plus this browser's pending action and notice. */
export interface ConnectionSnapshot {
  /** The Host's view; undefined until the stream reports one. */
  readonly feishu: FeishuState | undefined
  /** Whether the Host stream is delivering. */
  readonly linked: boolean
  /** Whether an action this page started has not answered. */
  readonly busy: boolean
  readonly notice: ConnectionNotice | undefined
}

/** The step a connection or sign-out in progress shows. */
export type ConnectionStep = 'configuring' | 'authorizing' | 'connecting' | 'signing-out'

/** What the user sees about the connection, derived from the Host's view alone. */
export type ConnectionPresentation =
  | { readonly phase: 'checking' }
  | { readonly phase: 'disconnected' | 'unavailable'; readonly failed: boolean }
  | { readonly phase: 'connected'; readonly userName: string | undefined; readonly failed: boolean }
  | {
    readonly phase: 'connecting'
    readonly step: ConnectionStep
    readonly operation: FeishuOperationId
    readonly url: string | undefined
    readonly cancellable: boolean
  }

/** Page-facing actions and the snapshot hook the slot entries inject. */
export interface ConnectionFace {
  hooks: { feishuConnection: HostObservable<ConnectionSnapshot> }
  connect(): void
  cancel(): void
  signOut(): void
  openAuthorization(): void
  dismissNotice(): void
}

function step(phase: Exclude<NonNullable<FeishuState['operation']>['phase'], 'checking'>): ConnectionStep {
  switch (phase) {
    case 'configuring':
    case 'authorizing':
    case 'signing-out': return phase
    case 'verifying':
    case 'cancelling': return 'connecting'
    /* v8 ignore next -- closed operation phase union */
    default: return assertNever(phase)
  }
}

/**
 * Derive the connection the page shows from the Host's view.
 * @param state - the view as the Host last reported it.
 * @returns the phase, with the operation in progress or the account the last check found.
 */
export function presentConnection(state: FeishuState | undefined): ConnectionPresentation {
  const operation = state?.operation
  if (state === undefined || operation?.kind === 'check') return { phase: 'checking' }
  if (operation !== undefined) {
    return {
      phase: 'connecting',
      step: operation.kind === 'sign-out' ? 'signing-out' : operation.phase === 'checking' ? 'connecting' : step(operation.phase),
      operation: operation.id,
      url: operation.authorizationUrl,
      cancellable: operation.kind === 'connect' && operation.phase !== 'cancelling',
    }
  }
  const failed = state.result?.outcome === 'failed'
  const account = state.account
  switch (account.state) {
    case 'unchecked': return { phase: 'checking' }
    case 'connected': return { phase: 'connected', userName: account.userName, failed }
    case 'unconfigured':
    case 'signed-out': return { phase: 'disconnected', failed }
    case 'unverified': return { phase: 'unavailable', failed }
    /* v8 ignore next -- closed account state union */
    default: return assertNever(account)
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

/** One Host subscription per browser plugin, shared by every Feishu entry on the Plugins page. */
export class FeishuConnection {
  /** The page's whole view, published after each stream item or page action settles. */
  readonly state: SnapshotStore<ConnectionSnapshot> = createSnapshotStore<ConnectionSnapshot>({
    feishu: undefined, linked: false, busy: false, notice: undefined,
  })

  /** The connection or sign-out this browser started; only its links open a window here. */
  private started: FeishuOperationId | undefined
  private readonly opened = new Set<string>()
  private seq = 0
  private disposed = false
  private readonly stream: RemoteStream<FeishuState>
  private readonly observing: Promise<void>

  constructor(private readonly ctx: Context) {
    this.stream = ctx.remote.$stream<FeishuState>({
      name: 'Feishu connection', open: signal => ctx.remote.feishu.follow(signal),
      ended: () => new Error('Feishu connection stream ended'),
      carrierFailed: () => { this.patch({ linked: false }) },
    })
    this.observing = this.observe()
  }

  /**
   * Bind the page-facing actions; each runs without awaiting so slot handlers stay synchronous.
   * @returns the face the slot entries inject.
   */
  face(): ConnectionFace {
    return {
      hooks: { feishuConnection: this.state },
      connect: () => { void this.start(() => this.ctx.remote.feishu.connect()) },
      signOut: () => { void this.start(() => this.ctx.remote.feishu.signOut()) },
      cancel: () => { void this.cancel() },
      openAuthorization: () => {
        const shown = presentConnection(this.state.getSnapshot().feishu)
        if (shown.phase === 'connecting') openAuthorizationPage(shown.url)
      },
      dismissNotice: () => { this.patch({ notice: undefined }) },
    }
  }

  /** Stop observing the Host; Host-owned operations keep running. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stream.dispose()
    await this.observing
  }

  private async observe(): Promise<void> {
    try {
      for await (const item of this.stream) {
        this.patch({ feishu: item.value, linked: true })
        this.follow(item.value)
        item.accept()
      }
    } catch {
      // The carrier already reported the failure; a disposed page has nothing left to show.
      if (!this.disposed) this.patch({ linked: false })
    }
  }

  /** Open each new link of this browser's operation once, and report how the operation ended. */
  private follow(state: FeishuState): void {
    const operation = state.operation
    if (operation !== undefined && operation.id === this.started && operation.authorizationUrl !== undefined
      && !this.opened.has(operation.authorizationUrl)) {
      this.opened.add(operation.authorizationUrl)
      openAuthorizationPage(operation.authorizationUrl)
    }
    const result = state.result
    if (result === undefined || result.id !== this.started) return
    this.started = undefined
    if (result.outcome === 'succeeded') this.notify(result.kind === 'sign-out' ? 'signed-out' : 'connected')
  }

  private async start(call: () => Promise<RemoteResult<FeishuOperationId>>): Promise<void> {
    await this.run(async () => {
      this.started = await settle(call())
      // The stream may have reported this operation before the call answered.
      const current = this.state.getSnapshot().feishu
      if (current !== undefined) this.follow(current)
    })
  }

  private async cancel(): Promise<void> {
    const shown = presentConnection(this.state.getSnapshot().feishu)
    if (shown.phase !== 'connecting' || !shown.cancellable) return
    await this.run(async () => { await settle(this.ctx.remote.feishu.cancel(shown.operation)) })
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.state.getSnapshot().busy) return
    this.patch({ busy: true })
    try {
      await operation()
    } catch {
      // The Host keeps the diagnostic; the page reports one retryable outcome.
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
