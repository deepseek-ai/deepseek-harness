import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { CliAccountView, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

type AnyView = CliAccountView<unknown, string, string>
type KindOf<View extends AnyView> = NonNullable<View['result']>['kind']

export interface CliAccountNotice<Notice extends string> {
  readonly seq: number
  readonly kind: Notice | 'action-failed'
}

export interface CliAccountSnapshot<View extends AnyView, Notice extends string> {
  readonly view: View | undefined
  readonly linked: boolean
  readonly stopped: boolean
  readonly busy: boolean
  readonly notice: CliAccountNotice<Notice> | undefined
}

export interface CliAccountConnectionOptions<View extends AnyView, Notice extends string> {
  readonly name: string
  readonly follow: (signal: AbortSignal) => AsyncIterable<View>
  readonly cancel: (id: CliOperationId) => Promise<RemoteResult<void>>
  readonly notices: Readonly<Partial<Record<KindOf<View>, Notice>>>
}

function openAuthorizationPage(url: string | undefined): void {
  if (url !== undefined && URL.canParse(url) && new URL(url).protocol === 'https:') window.open(url, '_blank', 'noopener,noreferrer')
}

async function settle<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

export class CliAccountConnection<View extends AnyView, Notice extends string> {
  readonly state: SnapshotStore<CliAccountSnapshot<View, Notice>> = createSnapshotStore<CliAccountSnapshot<View, Notice>>({
    view: undefined, linked: false, stopped: false, busy: false, notice: undefined,
  })

  private started: CliOperationId | undefined
  private readonly opened = new Set<string>()
  private seq = 0
  private disposed = false
  private stream!: RemoteStream<View>
  private observing!: Promise<void>

  readonly actions = {
    cancel: (): void => { this.cancel() },
    openAuthorization: (): void => { this.openAuthorization() },
    retry: (): void => { this.retry() },
    dismissNotice: (): void => { this.dismissNotice() },
  }

  constructor(private readonly ctx: Context, private readonly options: CliAccountConnectionOptions<View, Notice>) {
    this.subscribe()
  }

  start(call: () => Promise<RemoteResult<CliOperationId>>): void {
    void this.run(async () => {
      this.started = await settle(call())
      const current = this.state.getSnapshot().view
      if (current !== undefined) this.follow(current)
    })
  }

  cancel(): void {
    const operation = this.state.getSnapshot().view?.operation
    if (operation === undefined || !operation.cancellable) return
    void this.run(async () => { await settle(this.options.cancel(operation.id)) })
  }

  openAuthorization(): void {
    openAuthorizationPage(this.state.getSnapshot().view?.operation?.authorizationUrl)
  }

  retry(): void {
    void this.reopen()
  }

  dismissNotice(): void {
    this.patch({ notice: undefined })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stream.dispose()
    await this.observing
  }

  private subscribe(): void {
    this.stream = this.ctx.remote.$stream<View>({
      name: this.options.name, open: this.options.follow,
      ended: () => new Error(`${this.options.name} stream ended`),
      carrierFailed: () => { this.patch({ linked: false }) },
    })
    this.observing = this.observe(this.stream)
  }

  private async observe(stream: RemoteStream<View>): Promise<void> {
    try {
      for await (const item of stream) {
        this.patch({ view: item.value, linked: true })
        this.follow(item.value)
        item.accept()
      }
    } catch {
      if (!this.disposed) this.patch({ linked: false, stopped: true })
    }
  }

  private async reopen(): Promise<void> {
    if (this.disposed || !this.state.getSnapshot().stopped) return
    await this.stream.dispose()
    await this.observing
    this.patch({ view: undefined, stopped: false })
    this.subscribe()
  }

  private follow(view: View): void {
    const operation = view.operation
    if (operation !== undefined && operation.id === this.started && operation.authorizationUrl !== undefined
      && !this.opened.has(operation.authorizationUrl)) {
      this.opened.add(operation.authorizationUrl)
      openAuthorizationPage(operation.authorizationUrl)
    }
    const result = view.result
    if (result === undefined || result.id !== this.started) return
    this.started = undefined
    const notice = result.outcome === 'succeeded' ? this.options.notices[result.kind as KindOf<View>] : undefined
    if (notice !== undefined) this.notify(notice)
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

  private patch(change: Partial<CliAccountSnapshot<View, Notice>>): void {
    this.state.set({ ...this.state.getSnapshot(), ...change })
  }

  private notify(kind: CliAccountNotice<Notice>['kind']): void {
    if (this.disposed) return
    this.seq += 1
    this.patch({ notice: { seq: this.seq, kind } })
  }
}
