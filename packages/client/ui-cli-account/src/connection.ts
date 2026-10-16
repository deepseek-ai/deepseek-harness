/** Browser mirror of one CLI plugin's Host account view and the Plugins page's account actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { CliAccountView, CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

type AnyView = CliAccountView<unknown, string, string>
type KindOf<View extends AnyView> = NonNullable<View['result']>['kind']

/** A transient outcome the page reports outside its own lifetime; `seq` distinguishes repeats. */
export interface CliAccountNotice<Notice extends string> {
  readonly seq: number
  readonly kind: Notice | 'action-failed'
}

/** The page's whole view: the Host's account view plus this browser's pending action and notice. */
export interface CliAccountSnapshot<View extends AnyView, Notice extends string> {
  /** The Host's view; undefined until the stream reports one. */
  readonly view: View | undefined
  /** Whether the Host stream is delivering. */
  readonly linked: boolean
  /** Whether the Host stream failed for good, as when the plugin's Host component is not running; `retry` reopens it. */
  readonly stopped: boolean
  /** Whether an action this page started has not answered. */
  readonly busy: boolean
  readonly notice: CliAccountNotice<Notice> | undefined
}

/** The plugin's Remote operations the mirror uses and the notices its successes report. */
export interface CliAccountConnectionOptions<View extends AnyView, Notice extends string> {
  /** Diagnostic name of the Host stream. */
  readonly name: string
  /** Open one generation of the plugin's `follow` stream. */
  readonly follow: (signal: AbortSignal) => AsyncIterable<View>
  /** Cancel one operation through the plugin's Remote. */
  readonly cancel: (id: CliOperationId) => Promise<RemoteResult<void>>
  /** The notice each operation kind reports when an operation this browser started succeeds; unlisted kinds report none. */
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

/** One Host subscription per plugin page, shared by every surface of that plugin on the Plugins page. */
export class CliAccountConnection<View extends AnyView, Notice extends string> {
  /** The page's whole view, published after each stream item or page action settles. */
  readonly state: SnapshotStore<CliAccountSnapshot<View, Notice>> = createSnapshotStore<CliAccountSnapshot<View, Notice>>({
    view: undefined, linked: false, stopped: false, busy: false, notice: undefined,
  })

  /** The operation this browser started; only its links open a window here. */
  private started: CliOperationId | undefined
  private readonly opened = new Set<string>()
  private seq = 0
  private disposed = false
  private stream!: RemoteStream<View>
  private observing!: Promise<void>

  /** The page actions every plugin's face exposes unchanged, bound so slot handlers can call them directly. */
  readonly actions = {
    cancel: (): void => { this.cancel() },
    openAuthorization: (): void => { this.openAuthorization() },
    retry: (): void => { this.retry() },
    dismissNotice: (): void => { this.dismissNotice() },
  }

  /**
   * @param ctx - the plugin's browser context, carrying the Remote client.
   * @param options - the plugin's Remote operations and success notices.
   */
  constructor(private readonly ctx: Context, private readonly options: CliAccountConnectionOptions<View, Notice>) {
    this.subscribe()
  }

  /**
   * Start an operation through the plugin's Remote; a click while another action is pending is ignored,
   * and a rejected start reports the `action-failed` notice.
   * @param call - the plugin's Remote start method.
   */
  start(call: () => Promise<RemoteResult<CliOperationId>>): void {
    void this.run(async () => {
      this.started = await settle(call())
      const current = this.state.getSnapshot().view
      if (current !== undefined) this.follow(current)
    })
  }

  /** Cancel the current operation when the Host marks it cancellable. */
  cancel(): void {
    const operation = this.state.getSnapshot().view?.operation
    if (operation === undefined || !operation.cancellable) return
    void this.run(async () => { await settle(this.options.cancel(operation.id)) })
  }

  /** Open the current operation's authorization link again, over HTTPS only. */
  openAuthorization(): void {
    openAuthorizationPage(this.state.getSnapshot().view?.operation?.authorizationUrl)
  }

  /** Reopen the Host stream after it stopped; ignored while it runs or after disposal. */
  retry(): void {
    void this.reopen()
  }

  /** Clear the current notice. */
  dismissNotice(): void {
    this.patch({ notice: undefined })
  }

  /**
   * Stop observing the Host and report nothing more; Host-owned operations keep running.
   * @returns after the stream closes.
   */
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
      // A terminal failure, such as a Host without the plugin's service, ends the stream; a disposed page shows nothing.
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

  /** Open each new link of this browser's operation once, and report how the operation ended. */
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
      // The Host keeps the diagnostic; the page reports one retryable outcome.
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
