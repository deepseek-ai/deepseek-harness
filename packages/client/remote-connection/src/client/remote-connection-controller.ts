/** Transient QR login state; secrets remain in memory until the invitation settles. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-remote-connection/remote'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteConnectionStatus, RemoteLoginTicket } from '../types.ts'

/** Client methods are generated from the Host service. */
export type RemoteConnectionApi = TypertClientRemote['remoteConnection']

/** Settings panel state, including uncertain outcomes that hide the QR. */
export interface RemoteConnectionState {
  /** Advertised address and prerequisites; null until a deployment read succeeds. */
  deployment: RemoteConnectionStatus | null
  /** Current operation or invitation outcome; only pending permits displaying the QR credential. */
  phase: 'loading' | 'ready' | 'creating' | 'pending' | 'cancelling' | 'used' | 'expired' | 'cancelled' | 'replaced' | 'error'
  /** Secret invitation, retained during uncertain outcomes for status recovery; never persist or log its URL. */
  ticket: RemoteLoginTicket | null
  /** Failure owned by the panel; null after a successful read or new operation. */
  error: 'loadFailed' | 'createFailed' | 'cancelFailed' | 'statusFailed' | null
  /** Remaining invitation lifetime in whole seconds, measured against the browser's monotonic clock. */
  remainingSeconds: number
  /** Keep the countdown and warning visible during a QR operation; never permits displaying the retained credential. */
  retainDetails: boolean
}

/** Registration-side data and actions for the settings section. */
export interface RemoteConnectionFace {
  /** Start a new invitation; operation outcomes arrive through the state source. */
  create: () => void
  /** Cancel the retained invitation without revoking an already-issued browser session. */
  cancel: () => void
  /** Refresh deployment availability and any retained invitation's state. */
  reload: () => void
  /** Shared state source bound by the renderer to useRemoteConnection for every panel. */
  hooks: { remoteConnection: SnapshotStore<RemoteConnectionState> }
}

/** Owns current invitation polling and ignores superseded replies. */
export class RemoteConnectionController {
  /** Snapshot consumed by the settings section; credentials are discarded when it settles or unloads. */
  readonly store = createSnapshotStore<RemoteConnectionState>({
    deployment: null, phase: 'loading', ticket: null, error: null, remainingSeconds: 0, retainDetails: false,
  })
  private readonly pending = new Set<Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private deadline = 0
  private live = true

  /** @param remote - Generated owner-authenticated service methods. */
  constructor(private readonly remote: Pick<RemoteConnectionApi, 'status' | 'create' | 'cancel'>) {}

  /**
   * Bind stable actions and the private snapshot to the slot renderer.
   * @returns The settings section's injection values.
   */
  inject(): RemoteConnectionFace {
    return {
      create: () => { void this.create() },
      cancel: () => { void this.cancel() },
      reload: () => { void this.load() },
      hooks: { remoteConnection: this.store },
    }
  }

  /**
   * Withdraw the old connection's login address until the Host confirms its deployment again.
   * @returns after any outstanding QR gesture settles and the status read completes.
   */
  async reconnect(): Promise<void> {
    this.store.update((state) => { state.deployment = null })
    if (this.busy()) await Promise.all(this.pending)
    await this.load()
  }

  /**
   * Refresh deployment availability and, when retained, the current invitation.
   * @returns After the read settles or immediately when another gesture owns the panel.
   */
  load(): Promise<void> {
    if (!this.live || this.busy()) return Promise.resolve()
    const generation = this.begin()
    this.store.update((state) => { state.retainDetails = state.phase === 'pending'; state.phase = 'loading'; state.error = null })
    return this.track(this.read(generation))
  }

  /**
   * Replace the previous code; an uncertain response never restores its QR.
   * @returns After the creation result has been presented.
   */
  create(): Promise<void> {
    const deployment = this.store.getSnapshot().deployment
    if (!this.live || this.busy() || deployment?.availability !== 'available') return Promise.resolve()
    const generation = this.begin()
    this.store.update((state) => { state.retainDetails = state.phase === 'pending'; state.phase = 'creating'; state.ticket = null; state.error = null })
    return this.track(this.runCreate(generation, deployment.pollIntervalMs))
  }

  /**
   * Cancel the retained invitation without affecting an already-issued login.
   * @returns After cancellation settles; an unknown outcome remains visible.
   */
  cancel(): Promise<void> {
    const ticket = this.store.getSnapshot().ticket
    if (!this.live || this.busy() || ticket === null) return Promise.resolve()
    const generation = this.begin()
    this.store.update((state) => { state.retainDetails = state.phase === 'pending'; state.phase = 'cancelling'; state.error = null })
    return this.track(this.runCancel(generation, ticket))
  }

  /** Stop polling, discard the QR secret, and await owned requests. */
  async dispose(): Promise<void> {
    this.live = false
    this.begin()
    this.store.update((state) => { state.ticket = null; state.retainDetails = false })
    await Promise.all(this.pending)
  }

  private busy(): boolean {
    return ['creating', 'cancelling'].includes(this.store.getSnapshot().phase)
  }

  private begin(): number {
    clearTimeout(this.timer)
    clearTimeout(this.expiryTimer)
    this.timer = undefined
    this.expiryTimer = undefined
    return ++this.generation
  }

  private current(generation: number): boolean { return this.live && generation === this.generation }

  private track(operation: Promise<void>): Promise<void> {
    this.pending.add(operation)
    void operation.finally(() => { this.pending.delete(operation) })
    return operation
  }

  private fail(generation: number, error: NonNullable<RemoteConnectionState['error']>): void {
    if (this.current(generation)) this.store.update((state) => { state.phase = 'error'; state.error = error; state.retainDetails = false })
  }

  private async runCreate(generation: number, pollIntervalMs: number): Promise<void> {
    try {
      const result = await this.remote.create()
      if (!this.current(generation)) return
      if (!result.ok) { this.fail(generation, 'createFailed'); return }
      this.deadline = performance.now() + result.value.lifetimeMs
      this.store.update((state) => { state.ticket = result.value; state.phase = 'pending'; state.remainingSeconds = this.remainingSeconds(); state.retainDetails = false })
      this.schedule(generation, pollIntervalMs)
    } catch (_requestFailure) {
      this.fail(generation, 'createFailed')
    }
  }

  private async runCancel(generation: number, ticket: RemoteLoginTicket): Promise<void> {
    try {
      const result = await this.remote.cancel(ticket.id)
      if (!this.current(generation)) return
      if (!result.ok) { this.fail(generation, 'cancelFailed'); return }
      this.store.update((state) => { state.ticket = null; state.phase = result.value === 'none' ? 'replaced' : result.value; state.retainDetails = false })
    } catch (_requestFailure) {
      this.fail(generation, 'cancelFailed')
    }
  }

  private async read(generation: number): Promise<void> {
    const ticket = this.store.getSnapshot().ticket
    try {
      const result = await this.remote.status(ticket?.id ?? null)
      if (!this.current(generation)) return
      if (!result.ok) { this.fail(generation, ticket === null ? 'loadFailed' : 'statusFailed'); return }
      this.store.update((state) => {
        state.deployment = result.value
        state.remainingSeconds = this.remainingSeconds()
        state.error = null
        state.retainDetails = false
        state.phase = ticket === null ? 'ready' : result.value.ticket === 'none' ? 'replaced' : result.value.ticket
        if (state.phase !== 'pending' || result.value.availability !== 'available') state.ticket = null
      })
      const currentTicket = this.store.getSnapshot().ticket
      if (currentTicket === null) this.begin()
      else this.schedule(generation, result.value.pollIntervalMs)
    } catch (_requestFailure) {
      this.fail(generation, ticket === null ? 'loadFailed' : 'statusFailed')
    }
  }

  private remainingSeconds(): number { return Math.max(0, Math.ceil((this.deadline - performance.now()) / 1000)) }

  private schedule(generation: number, pollIntervalMs: number): void {
    const remaining = this.deadline - performance.now()
    if (remaining <= 0) {
      this.store.update((state) => { state.ticket = null; state.phase = 'expired'; state.remainingSeconds = 0; state.retainDetails = false })
      return
    }
    // The expiry deadline still hides the credential when a status request stalls.
    this.expiryTimer ??= setTimeout(() => {
      this.begin()
      this.store.update((state) => { state.ticket = null; state.phase = 'expired'; state.remainingSeconds = 0; state.retainDetails = false })
    }, remaining)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.track(this.read(generation))
    }, Math.min(pollIntervalMs, remaining))
  }
}
